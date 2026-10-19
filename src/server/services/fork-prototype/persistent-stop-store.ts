/**
 * Isolated prototype (NOT wired to the main path): persistent stop operations
 * per docs/OPENCODE_FORK_DESIGN.md §D — revision-CAS revision.
 *
 * Review round 21 fixes:
 *  - every CAS matches (stopOpId AND revision): a same-round stale writer
 *    (sendAbort that read an older state) can no longer write 'stopped' back
 *    to 'abort_sent', fire an abort, or lose attempts/uncertainty updates;
 *  - uncertainty is tracked PER ATTEMPT ( unsettled: attemptId[] ), not as a
 *    round boolean: two timed-out attempts need BOTH settlements; the
 *    underlying transport promise is wired so its eventual completion (or
 *    failure) settles its attempt automatically, whenever it lands;
 *  - there is NO boolean-only unblock: clearing uncertainty requires the
 *    transport's isolateTarget to CONFIRM the old target can no longer
 *    affect the session (proof recorded); a failed isolation keeps the
 *    round blocked.
 */
import { randomUUID } from "node:crypto";
import { type SQL, and, eq, sql } from "drizzle-orm";
import { config } from "../../config.js";
import { getDb } from "../../db/client.js";
import { settings } from "../../db/schema/index.js";

export interface PersistedStopOp {
	stopOpId: string;
	/** Monotonic per-row revision — the within-round CAS token. */
	revision: number;
	sessionId: string;
	status: "abort_pending" | "abort_sent" | "stopped";
	attempts: number;
	/** Attempt ids whose transport outcome is not yet known. */
	unsettled: string[];
	/** Late settlements that arrived after the round was superseded. */
	staleArrivals: number;
	isolationProof?: string | null;
	requestHash?: string | null;
}

export interface StopTransport {
	abortNativeTurn: (sessionId: string) => Promise<void>;
	/**
	 * Must CONFIRM the old abort target can no longer affect this session
	 * (terminate-and-confirm, or replacement target) and return a proof.
	 * Throwing keeps the round blocked — there is no boolean bypass.
	 */
	isolateTarget: (sessionId: string, stopOpId: string) => Promise<{ proof: string }>;
}

const KEY = (sessionId: string) => `forkproto.stopop.${sessionId}`;
/** Authority pointer: at most ONE active (non-stopped) round per session.
 * Rounds write their ledger rows separately; this pointer is what begin()
 * claims and what every CAS also guards, so two concurrent new rounds
 * cannot both succeed. */
const ACTIVE = (sessionId: string) => `forkproto.stopop.active.${sessionId}`;

async function load(sessionId: string): Promise<PersistedStopOp | null> {
	const [row] = await getDb()
		.select()
		.from(settings)
		.where(eq(settings.key, KEY(sessionId)));
	return row ? (row.value as PersistedStopOp) : null;
}

/**
 * Dialect-adapted JSON path comparison. Types matter on both engines:
 *  - SQLite json_extract preserves the JSON value's type — numeric fields
 *    must compare against a numeric bind (INTEGER = TEXT is false);
 *  - PostgreSQL ->> always yields TEXT — compare against the string form.
 */
function jsonPathEq(path: string, value: string | number): SQL {
	if (config.dialect === "postgres") {
		// PG has no $.path form: ->> takes a single key; #>> takes a path
		// array literal. "$.stopOpId" → "{stopOpId}".
		const arrayPath = `{${path.slice(2)}}`;
		return sql`(${settings.value} #>> ${arrayPath}) = ${String(value)}`;
	}
	if (typeof value === "number") return sql`json_extract(${settings.value}, ${path}) = ${value}`;
	return sql`json_extract(${settings.value}, ${path}) = ${value}`;
}

/** Revision CAS: mutate ONLY while the row still shows (stopOpId, revision). */
async function casUpdate(expected: PersistedStopOp, next: PersistedStopOp): Promise<boolean> {
	const rows = await getDb()
		.update(settings)
		.set({ value: next })
		.where(
			and(
				eq(settings.key, KEY(expected.sessionId)),
				jsonPathEq("$.stopOpId", expected.stopOpId),
				jsonPathEq("$.revision", expected.revision),
			),
		)
		.returning({ key: settings.key });
	return rows.length > 0;
}

/** Defense-in-depth ONLY (the atomic conditional write above is the real
 * guard): verifies this writer's unique attempt id landed in the row. The
 * round-22 duplicate-success anomaly was fully explained by the missing
 * revision bump — a minimal standalone repro confirmed the driver's
 * returning() reports zero rows for non-matching updates correctly. */
async function writeLanded(
	sessionId: string,
	marker: string,
	pick: (row: PersistedStopOp) => string[],
): Promise<boolean> {
	const after = await load(sessionId);
	return after !== null && pick(after).includes(marker);
}

export class PersistentStopStore {
	constructor(
		private readonly transport: StopTransport,
		private readonly attemptTimeoutMs = 5_000,
		/** Test-only interleaving hook: runs between a mutation's load and CAS. */
		private readonly testHooks: { beforeCas?: () => Promise<void> } = {},
	) {}

	async begin(sessionId: string, requestHash?: string): Promise<PersistedStopOp> {
		const candidate: PersistedStopOp = {
			stopOpId: `stop-${randomUUID()}`,
			revision: 1,
			sessionId,
			status: "abort_pending",
			attempts: 0,
			unsettled: [],
			staleArrivals: 0,
			isolationProof: null,
			requestHash: requestHash ?? null,
		};
		// Claim the session's single ACTIVE-round slot FIRST (insert-win).
		// Its value names the owning round; a stopped round releases it.
		await getDb()
			.insert(settings)
			.values({ key: ACTIVE(sessionId), value: { stopOpId: candidate.stopOpId } })
			.onConflictDoNothing({ target: settings.key });
		const [active] = await getDb()
			.select()
			.from(settings)
			.where(eq(settings.key, ACTIVE(sessionId)));
		const activeOwner = (active?.value as { stopOpId?: string } | undefined)?.stopOpId;
		if (activeOwner && activeOwner !== candidate.stopOpId) {
			// Someone else owns the active round — is it still live?
			const owner = await load(sessionId);
			if (owner && owner.stopOpId === activeOwner && owner.status !== "stopped") return owner;
			// Stale pointer (owner stopped/absent): CAS-takeover the slot —
			// the WHERE matches the pointer's CURRENT owner value.
			const won = await getDb()
				.update(settings)
				.set({ value: { stopOpId: candidate.stopOpId } })
				.where(and(eq(settings.key, ACTIVE(sessionId)), jsonPathEq("$.stopOpId", activeOwner)))
				.returning({ key: settings.key });
			if (won.length === 0) {
				const racer = await load(sessionId);
				if (racer && racer.status !== "stopped") return racer;
			}
		}
		await getDb()
			.insert(settings)
			.values({ key: KEY(sessionId), value: candidate })
			.onConflictDoNothing({ target: settings.key });
		const existing = await load(sessionId);
		if (existing && existing.status !== "stopped") return existing;
		if (existing && existing.status === "stopped") {
			const won = await casUpdate(existing, { ...candidate, revision: existing.revision + 1 });
			if (won) return candidate;
			const racer = await load(sessionId);
			if (racer && racer.status !== "stopped") return racer;
		}
		return (await load(sessionId)) ?? candidate;
	}

	async sendAbort(
		sessionId: string,
	): Promise<
		| { stopOpId: string; attemptId: string; transportOk: boolean; timedOut: boolean }
		| { rejected: "no_stop_round" | "stopped_round" | "superseded" }
	> {
		const observed = await load(sessionId);
		if (!observed) return { rejected: "no_stop_round" };
		if (observed.status === "stopped") return { rejected: "stopped_round" };
		const attemptId = `att-${randomUUID()}`;
		const registered: PersistedStopOp = {
			...observed,
			// The revision bump is the atomic-write token: without it every
			// same-round writer matches the WHERE clause and overwrites the
			// previous one (the round-22 root cause — NOT a driver issue).
			revision: observed.revision + 1,
			attempts: observed.attempts + 1,
			status: "abort_sent",
			unsettled: [...observed.unsettled, attemptId],
		};
		await this.testHooks.beforeCas?.();
		const accepted =
			(await casUpdate(observed, registered)) &&
			(await writeLanded(sessionId, attemptId, (row) => row.unsettled));
		if (!accepted) {
			// The row moved underneath us (same-round writer or a new round):
			// this attempt is NOT registered — never touch the transport.
			const now = await load(sessionId);
			return { rejected: now?.status === "stopped" ? "stopped_round" : "superseded" };
		}
		// Wire the eventual settlement of THIS attempt regardless of the race
		// outcome — a late completion settles whenever it lands.
		const transport = this.transport.abortNativeTurn(sessionId);
		const wired = transport.then(
			() => this.settleAttempt(sessionId, registered.stopOpId, attemptId, true),
			() => this.settleAttempt(sessionId, registered.stopOpId, attemptId, false),
		);
		let timedOut = false;
		try {
			await Promise.race([
				transport,
				new Promise<never>((_, reject) =>
					setTimeout(() => {
						timedOut = true;
						reject(new Error("abort_attempt_timeout"));
					}, this.attemptTimeoutMs),
				),
			]);
			await wired;
			return { stopOpId: registered.stopOpId, attemptId, transportOk: true, timedOut: false };
		} catch {
			if (timedOut) {
				// The attempt stays unsettled; the wired settlement will clear
				// it when the transport eventually completes.
				return { stopOpId: registered.stopOpId, attemptId, transportOk: false, timedOut: true };
			}
			await wired; // transport failed promptly — settled as failed
			return { stopOpId: registered.stopOpId, attemptId, transportOk: false, timedOut: false };
		}
	}

	/** Removes ONE attempt from the unsettled set (idempotent, CAS-guarded). */
	async settleAttempt(
		sessionId: string,
		stopOpId: string,
		attemptId: string,
		_transportOk: boolean,
	): Promise<boolean> {
		for (let tries = 0; tries < 3; tries++) {
			const current = await load(sessionId);
			if (!current || current.stopOpId !== stopOpId) return false;
			if (!current.unsettled.includes(attemptId)) return true; // already settled
			const next: PersistedStopOp = {
				...current,
				revision: current.revision + 1,
				unsettled: current.unsettled.filter((id) => id !== attemptId),
			};
			if (await casUpdate(current, next)) return true;
		}
		return false;
	}

	/** TERMINATION confirmation — refused while ANY attempt is unsettled. */
	async confirmTermination(
		sessionId: string,
		stopOpId: string,
	): Promise<boolean | { refused: "uncertain" | "unknown_round" }> {
		for (let tries = 0; tries < 3; tries++) {
			const current = await load(sessionId);
			if (!current || current.stopOpId !== stopOpId) return { refused: "unknown_round" };
			if (current.unsettled.length > 0) return { refused: "uncertain" };
			if (current.status === "stopped") return true;
			const next: PersistedStopOp = {
				...current,
				revision: current.revision + 1,
				status: "stopped",
			};
			if (await casUpdate(current, next)) {
				// Release the active-round slot (best effort; a stale pointer
				// is cleaned up by the next begin()'s CAS takeover).
				await getDb()
					.delete(settings)
					.where(eq(settings.key, ACTIVE(sessionId)));
				return true;
			}
		}
		return false;
	}

	/** Resume gate: stopped AND every attempt settled. */
	async canResume(sessionId: string): Promise<boolean> {
		const op = await load(sessionId);
		return Boolean(op && op.status === "stopped" && op.unsettled.length === 0);
	}

	/**
	 * Isolation REPLACES the old boolean bypass: the transport must CONFIRM
	 * the old abort target can no longer affect the session; the proof is
	 * recorded and only then are the unsettled attempts cleared. A failed or
	 * refused isolation keeps the round blocked.
	 */
	async isolate(
		sessionId: string,
	): Promise<{ isolated: boolean; proof?: string; reason?: string }> {
		const current = await load(sessionId);
		if (!current) return { isolated: false, reason: "no_round" };
		if (current.unsettled.length === 0)
			return { isolated: true, proof: current.isolationProof ?? "nothing-to-isolate" };
		try {
			const { proof } = await this.transport.isolateTarget(sessionId, current.stopOpId);
			const latest = await load(sessionId);
			if (!latest || latest.stopOpId !== current.stopOpId)
				return { isolated: false, reason: "superseded" };
			const next: PersistedStopOp = {
				...latest,
				revision: latest.revision + 1,
				unsettled: [],
				isolationProof: proof,
			};
			if (await casUpdate(latest, next)) return { isolated: true, proof };
			return { isolated: false, reason: "concurrent_write" };
		} catch (error) {
			return {
				isolated: false,
				reason: error instanceof Error ? error.message : "isolation_failed",
			};
		}
	}

	async snapshot(sessionId: string): Promise<PersistedStopOp | null> {
		return load(sessionId);
	}

	/**
	 * Restart reconciliation (review rounds 24+25): in-process promises die
	 * with the process, so unsettled attempts NEVER settle themselves after a
	 * crash/restart. A restart of the CONTROL process alone proves nothing
	 * about the old abort target — the PRODUCTION contract is a verifiable
	 * evidence object bound to THIS round and the OLD target's identity
	 * (e.g. {kind:"instance-terminated", instanceIdentity, verifiedBy}).
	 * This prototype only enforces the structural binding (round id match,
	 * kind + target identity present); the actual verification (process
	 * generation / uptime / supervisor attestation) is a main-path
	 * integration responsibility and is NOT implemented here.
	 */
	async reconcileAfterRestart(
		sessionId: string,
		stopOpId: string,
		proof: { kind: string; instanceIdentity: string; detail?: string },
	): Promise<boolean | { refused: "unknown_round" | "invalid_proof" }> {
		if (!proof?.kind || !proof?.instanceIdentity) return { refused: "invalid_proof" };
		const current = await load(sessionId);
		if (!current || current.stopOpId !== stopOpId) return { refused: "unknown_round" };
		if (current.unsettled.length === 0) return false;
		const token = `${proof.kind}:${proof.instanceIdentity}${proof.detail ? `:${proof.detail}` : ""}`;
		const next: PersistedStopOp = {
			...current,
			revision: current.revision + 1,
			unsettled: [],
			isolationProof: token,
		};
		const won = await casUpdate(current, next);
		return won;
	}
}
