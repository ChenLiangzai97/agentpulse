/**
 * Isolated prototype (NOT wired to the main path): persistent stop operations
 * per docs/OPENCODE_FORK_DESIGN.md §D — concurrency-hardened revision.
 *
 * Review round 19 fixes baked in:
 *  - operation identity is UNIQUE (crypto random) and ownership is decided by
 *    a successful INSERT (or a conditional UPDATE of a stopped round), never
 *    by a clock read; same-millisecond rounds cannot collide;
 *  - every mutation is a conditional UPDATE keyed on the row's CURRENT
 *    stopOpId (portable CAS via jsonExtractText), so a late writer from an
 *    old round can never overwrite a newer round, nor write 'stopped' back
 *    to 'abort_sent';
 *  - sendAbort REJECTS stopped rounds; a timed-out attempt leaves the round
 *    'uncertain' (the underlying native request cannot be cancelled) and
 *    RESUME IS BLOCKED until the round is explicitly isolated or the attempt
 *    settles; late settlements of superseded rounds are counted observably;
 *  - transport success (HTTP-200-shaped) is still NOT termination: only
 *    confirmTermination — carrying the round id — stops the round.
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDb } from "../../db/client.js";
import { settings } from "../../db/schema/index.js";
import { jsonExtractText } from "../../db/sql-helpers.js";

export interface PersistedStopOp {
	stopOpId: string;
	sessionId: string;
	status: "abort_pending" | "abort_sent" | "stopped";
	attempts: number;
	/** At least one transport attempt timed out and has not settled. */
	uncertain: boolean;
	/** Late settlements that arrived after the round was superseded. */
	staleArrivals: number;
	requestHash?: string | null;
}

const KEY = (sessionId: string) => `forkproto.stopop.${sessionId}`;

async function load(sessionId: string): Promise<PersistedStopOp | null> {
	const [row] = await getDb()
		.select()
		.from(settings)
		.where(eq(settings.key, KEY(sessionId)));
	return row ? (row.value as PersistedStopOp) : null;
}

/** CAS: mutate the row ONLY while it still shows `expectedOpId`. */
async function casUpdate(
	sessionId: string,
	expectedOpId: string,
	next: PersistedStopOp,
): Promise<boolean> {
	const rows = await getDb()
		.update(settings)
		.set({ value: next })
		.where(
			and(
				eq(settings.key, KEY(sessionId)),
				eq(jsonExtractText(settings.value, "$.stopOpId"), expectedOpId),
			),
		)
		.returning({ key: settings.key });
	return rows.length > 0;
}

export class PersistentStopStore {
	constructor(
		private readonly transport: { abortNativeTurn: (sessionId: string) => Promise<void> },
		private readonly attemptTimeoutMs = 5_000,
	) {}

	/** Starts a new round, or re-observes the in-flight one (any store, any restart). */
	async begin(sessionId: string, requestHash?: string): Promise<PersistedStopOp> {
		const candidate: PersistedStopOp = {
			stopOpId: `stop-${randomUUID()}`,
			sessionId,
			status: "abort_pending",
			attempts: 0,
			uncertain: false,
			staleArrivals: 0,
			requestHash: requestHash ?? null,
		};
		await getDb()
			.insert(settings)
			.values({ key: KEY(sessionId), value: candidate })
			.onConflictDoNothing({ target: settings.key });
		const existing = await load(sessionId);
		if (existing && existing.status !== "stopped") return existing;
		// Only one writer can flip a stopped row to a new round (CAS).
		if (existing && existing.status === "stopped") {
			const won = await casUpdate(sessionId, existing.stopOpId, candidate);
			if (won) return candidate;
			const racer = await load(sessionId);
			if (racer && racer.status !== "stopped") return racer;
		}
		return (await load(sessionId)) ?? candidate;
	}

	/**
	 * Issues (or RE-issues) the abort for the round. Rejects stopped rounds.
	 * A timed-out attempt marks the round uncertain — the native request may
	 * still land, so resume stays blocked until it settles or is isolated.
	 */
	async sendAbort(
		sessionId: string,
	): Promise<
		{ stopOpId: string; transportOk: boolean } | { rejected: "no_stop_round" | "stopped_round" }
	> {
		const op = await load(sessionId);
		if (!op) return { rejected: "no_stop_round" };
		if (op.status === "stopped") return { rejected: "stopped_round" };
		const next: PersistedStopOp = { ...op, attempts: op.attempts + 1, status: "abort_sent" };
		const accepted = await casUpdate(sessionId, op.stopOpId, next);
		if (!accepted) {
			// A newer round (or a concurrent writer) won; this attempt belongs
			// to a superseded round — do not touch the transport.
			return { rejected: "stopped_round" };
		}
		let timedOut = false;
		try {
			await Promise.race([
				this.transport.abortNativeTurn(sessionId),
				new Promise<never>((_, reject) =>
					setTimeout(() => {
						timedOut = true;
						reject(new Error("abort_attempt_timeout"));
					}, this.attemptTimeoutMs),
				),
			]);
			await this.settle(sessionId, next.stopOpId, { transportOk: true });
			return { stopOpId: next.stopOpId, transportOk: true };
		} catch {
			const current = await load(sessionId);
			if (!current || current.stopOpId !== next.stopOpId) {
				// Superseded while in flight: record the late arrival observably.
				if (current) {
					await casUpdate(sessionId, current.stopOpId, {
						...current,
						staleArrivals: current.staleArrivals + 1,
					});
				}
				return { rejected: "stopped_round" };
			}
			await this.settle(sessionId, next.stopOpId, { transportOk: false, timedOut });
			return { stopOpId: next.stopOpId, transportOk: false };
		}
	}

	/** Records a transport attempt's outcome; timed-out attempts keep uncertainty. */
	private async settle(
		sessionId: string,
		stopOpId: string,
		outcome: { transportOk: boolean; timedOut?: boolean },
	): Promise<void> {
		const current = await load(sessionId);
		if (!current || current.stopOpId !== stopOpId) return;
		const uncertain = outcome.timedOut ? true : current.uncertain;
		await casUpdate(sessionId, stopOpId, { ...current, uncertain });
	}

	/** Late settlement of a PREVIOUSLY timed-out attempt (the request finally landed or failed). */
	async settleLate(sessionId: string, stopOpId: string, transportOk: boolean): Promise<boolean> {
		const current = await load(sessionId);
		if (!current || current.stopOpId !== stopOpId) return false;
		await casUpdate(sessionId, stopOpId, { ...current, uncertain: false });
		return transportOk;
	}

	/**
	 * TERMINATION confirmation — the only path to 'stopped'. Carries the
	 * round id; refuses uncertain rounds until settled or isolated.
	 */
	async confirmTermination(
		sessionId: string,
		stopOpId: string,
	): Promise<boolean | { refused: "uncertain" }> {
		const op = await load(sessionId);
		if (!op || op.stopOpId !== stopOpId) return false;
		if (op.uncertain) return { refused: "uncertain" };
		if (op.status === "stopped") return true;
		const won = await casUpdate(sessionId, stopOpId, { ...op, status: "stopped" });
		return won;
	}

	/** Resume gate: a round may only resume when stopped AND nothing is uncertain. */
	async canResume(sessionId: string): Promise<boolean> {
		const op = await load(sessionId);
		return Boolean(op && op.status === "stopped" && !op.uncertain);
	}

	/** Operator action: explicitly isolate an unsettled attempt (documented risk). */
	async isolateRound(sessionId: string): Promise<boolean> {
		const op = await load(sessionId);
		if (!op) return false;
		return casUpdate(sessionId, op.stopOpId, { ...op, uncertain: false });
	}

	async snapshot(sessionId: string): Promise<PersistedStopOp | null> {
		return load(sessionId);
	}
}
