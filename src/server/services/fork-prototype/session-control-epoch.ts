/**
 * Isolated prototype (NOT wired to the control main path): session-level
 * control epochs for managed OpenCode sessions, per docs/OPENCODE_FORK_DESIGN.md §D.
 *
 * Invariants under test (fault-injectable):
 *  1. stop() cancels queued actions and bumps the session epoch; an action
 *     CLAIMED before the stop but executed after RESUME is rejected — the
 *     instance generation never changed, the SESSION epoch is what stops it.
 *  2. stop() is not "stopped" until the native abort is CONFIRMED; without
 *     confirmation the observable state stays "stopping" (never claimed done).
 *  3. Epochs are per session: stopping the child does not affect a parent
 *     session sharing the same instance.
 *  4. resume() is explicit and never lowers the epoch.
 */
export interface PrototypeAction {
	id: string;
	sessionId: string;
	epochAtQueue: number;
	state: "queued" | "claimed" | "executing" | "succeeded" | "failed" | "cancelled";
}

export interface SessionControlState {
	epoch: number;
	status: "managed" | "stopping" | "stopped";
	/** The in-flight stop operation; cleared on confirmation. */
	abortInFlight: AbortHandle | null;
	/** The stop operation this round belongs to; only a NEW stop changes it. */
	currentStopOpId: number | null;
}

export interface AbortHandle {
	sessionId: string;
	/** Identifies THIS stop operation — confirmations must match it. */
	stopOpId: number;
	/** The fault-injectable transport: resolves when the native abort lands. */
	confirm: Promise<void>;
}

export class SessionControlEpochStore {
	private sessions = new Map<string, SessionControlState>();
	private actions = new Map<string, PrototypeAction>();
	private stopOpCounter = 0;

	constructor(
		private readonly transport: {
			abortNativeTurn: (sessionId: string) => Promise<void>;
		},
	) {}

	private nextStopOpId(): number {
		this.stopOpCounter += 1;
		return this.stopOpCounter;
	}

	private state(sessionId: string): SessionControlState {
		let s = this.sessions.get(sessionId);
		if (!s) {
			s = { epoch: 1, status: "managed", abortInFlight: null, currentStopOpId: null };
			this.sessions.set(sessionId, s);
		}
		return s;
	}

	enqueue(sessionId: string, actionId: string): PrototypeAction {
		const s = this.state(sessionId);
		if (s.status !== "managed") throw new Error(`session_${s.status}`);
		const action: PrototypeAction = {
			id: actionId,
			sessionId,
			epochAtQueue: s.epoch,
			state: "queued",
		};
		this.actions.set(actionId, action);
		return action;
	}

	/** A supervisor claims a queued action. */
	claim(actionId: string): PrototypeAction {
		const a = this.actions.get(actionId);
		if (!a) throw new Error("unknown_action");
		if (a.state !== "queued") throw new Error(`not_claimable_${a.state}`);
		a.state = "claimed";
		return a;
	}

	/**
	 * Execution gate — THE race codex flagged: an action claimed before a stop
	 * must not execute after a resume. The instance generation is irrelevant
	 * here; only the session epoch decides.
	 */
	execute(
		actionId: string,
	): { ok: true; action: PrototypeAction } | { ok: false; reason: string; detail?: string } {
		const a = this.actions.get(actionId);
		if (!a) return { ok: false, reason: "unknown_action" };
		const s = this.state(a.sessionId);
		if (s.epoch !== a.epochAtQueue)
			return {
				ok: false,
				reason: "stale_session_epoch",
				detail: `queued@${a.epochAtQueue} now@${s.epoch}`,
			};
		if (s.status !== "managed") return { ok: false, reason: `session_${s.status}` };
		// Replay gate: ONLY a claimed action may start executing — an
		// un-claimed queued action, an already-executing one, or a finished
		// one can never (re-)enter executing.
		if (a.state !== "claimed")
			return { ok: false, reason: `not_claimable_${a.state}`, detail: `state=${a.state}` };
		a.state = "executing";
		return { ok: true, action: a };
	}

	finish(actionId: string, outcome: "succeeded" | "failed"): void {
		const a = this.actions.get(actionId);
		if (a && a.state === "executing") a.state = outcome;
	}

	/**
	 * Stop: cancel queued/claimed actions, abort the in-flight native turn,
	 * and only report "stopped" once the abort is CONFIRMED. The observable
	 * window between stop() and confirmation is "stopping" — never claimed done.
	 */
	/**
	 * Stop. Each stop operation carries a unique stopOpId; confirmations
	 * (automatic or manual) must MATCH it, so a late confirmation belonging to
	 * an earlier stop can never mark a newer stopping round as stopped. A
	 * re-entrant stop while one is in flight REUSES that operation instead of
	 * issuing another abort.
	 */
	stop(sessionId: string): { stopOpId: number; outcome: Promise<"stopping" | "stopped"> } {
		const s = this.state(sessionId);
		if (s.status === "stopped") {
			const stopOpId = this.nextStopOpId();
			return { stopOpId, outcome: Promise.resolve("stopped") };
		}
		if (s.status === "stopping" && s.abortInFlight) {
			const handle = s.abortInFlight;
			return { stopOpId: handle.stopOpId, outcome: this.awaitAbort(s, handle) };
		}
		s.currentStopOpId = this.nextStopOpId();
		s.status = "stopping";
		s.epoch += 1; // invalidates everything queued/claimed before the stop
		for (const a of this.actions.values())
			if (a.sessionId === sessionId && (a.state === "queued" || a.state === "claimed"))
				a.state = "cancelled";
		const handle: AbortHandle = {
			sessionId,
			stopOpId: s.currentStopOpId,
			confirm: this.transport.abortNativeTurn(sessionId),
		};
		s.abortInFlight = handle;
		return { stopOpId: handle.stopOpId, outcome: this.awaitAbort(s, handle) };
	}

	private async awaitAbort(
		s: SessionControlState,
		handle: AbortHandle,
	): Promise<"stopping" | "stopped"> {
		let confirmed = true;
		try {
			await handle.confirm;
		} catch {
			confirmed = false; // transport may re-attempt; status stays stopping
		}
		// Idempotent for observers of the SAME round; a stale round can never
		// flip a newer one because currentStopOpId only moves on a new stop.
		if (!confirmed)
			return s.status === "stopped" && s.currentStopOpId === handle.stopOpId
				? "stopped"
				: "stopping";
		if (s.currentStopOpId !== handle.stopOpId) return "stopping"; // superseded by a newer round
		if (s.status === "stopping") {
			s.status = "stopped";
			s.abortInFlight = null;
		}
		return s.status === "stopped" ? "stopped" : "stopping";
	}

	/** Abort confirmation may land late (fault window: stop() already returned).
	 * Must carry the stopOpId of the stop it belongs to — a stale opId is a no-op. */
	confirmAbort(sessionId: string, stopOpId: number): boolean {
		const s = this.sessions.get(sessionId);
		if (!s || s.status !== "stopping") return false;
		if (s.currentStopOpId !== stopOpId) return false; // stale round
		s.status = "stopped";
		s.abortInFlight = null;
		return true;
	}

	/** Explicit recovery; never lowers the epoch. */
	resume(sessionId: string): void {
		const s = this.state(sessionId);
		if (s.status !== "stopped") throw new Error(`not_resumable_${s.status}`);
		s.status = "managed";
	}

	snapshot(sessionId: string): Readonly<SessionControlState> {
		return { ...this.state(sessionId) };
	}
	action(actionId: string): Readonly<PrototypeAction> | undefined {
		const a = this.actions.get(actionId);
		return a ? { ...a } : undefined;
	}
}
