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
	/** Set when stop() issued the abort; cleared on confirmation. */
	abortInFlight: AbortHandle | null;
}

export interface AbortHandle {
	sessionId: string;
	/** The fault-injectable transport: resolves when the native abort lands. */
	confirm: Promise<void>;
}

export class SessionControlEpochStore {
	private sessions = new Map<string, SessionControlState>();
	private actions = new Map<string, PrototypeAction>();

	constructor(
		private readonly transport: {
			abortNativeTurn: (sessionId: string) => Promise<void>;
		},
	) {}

	private state(sessionId: string): SessionControlState {
		let s = this.sessions.get(sessionId);
		if (!s) {
			s = { epoch: 1, status: "managed", abortInFlight: null };
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
	execute(actionId: string):
		| { ok: true; action: PrototypeAction }
		| { ok: false; reason: string; detail?: string } {
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
	async stop(sessionId: string): Promise<"stopping" | "stopped"> {
		const s = this.state(sessionId);
		if (s.status === "stopped") return "stopped";
		s.status = "stopping";
		s.epoch += 1; // invalidates everything queued/claimed before the stop
		for (const a of this.actions.values())
			if (a.sessionId === sessionId && (a.state === "queued" || a.state === "claimed"))
				a.state = "cancelled";
		const abort = this.transport.abortNativeTurn(sessionId);
		let confirmed = true;
		try {
			await abort;
		} catch {
			confirmed = false; // transport may re-attempt; status stays stopping
		}
		if (confirmed && s.status === "stopping") {
			s.status = "stopped";
			s.abortInFlight = null;
			return "stopped";
		}
		return "stopping";
	}

	/** Abort confirmation may land late (fault window: stop() already returned). */
	confirmAbort(sessionId: string): void {
		const s = this.sessions.get(sessionId);
		if (s && s.status === "stopping") {
			s.status = "stopped";
			s.abortInFlight = null;
		}
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
