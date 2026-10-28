/**
 * Isolated prototype (NOT wired to the main path): persistent stop operations
 * per docs/OPENCODE_FORK_DESIGN.md §D — single-authoritative-row transactional
 * revision (review round 29).
 *
 * Model: ONE authoritative settings row per session holds the CURRENT round
 * and its full state. Round creation = a single conditional upsert inside one
 * transaction (no two-write claim/create window). Termination release is a
 * conditional update matching (stopOpId, revision) — a late confirmation from
 * an old round can never delete a NEW round's authority. Every mutation is
 * that same atomic conditional write; there is no separate ACTIVE pointer to
 * drift out of sync, and the code no longer claims otherwise.
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { config } from "../../config.js";
import { getDb } from "../../db/client.js";
import { settings } from "../../db/schema/index.js";
import { withTransaction } from "../../db/with-transaction.js";

export interface PersistedStopOp {
	stopOpId: string;
	revision: number;
	sessionId: string;
	status: "abort_pending" | "abort_sent" | "stopped";
	attempts: number;
	/** Attempt ids whose transport outcome is not yet known. */
	unsettled: string[];
	staleArrivals: number;
	isolationProof?: string | null;
	requestHash?: string | null;
}

export interface StopTransport {
	abortNativeTurn: (sessionId: string) => Promise<void>;
	isolateTarget: (sessionId: string, stopOpId: string) => Promise<{ proof: string }>;
}

const KEY = (sessionId: string) => `forkproto.stopop2.${sessionId}`;

async function loadRow(tx: unknown, sessionId: string): Promise<PersistedStopOp | null> {
	// biome-ignore lint/suspicious/noExplicitAny: tx typed in Phase 2a (helper contract)
	const rows = await (tx as any)
		.select()
		.from(settings)
		.where(eq(settings.key, KEY(sessionId)));
	return rows.length ? (rows[0].value as PersistedStopOp) : null;
}
async function load(sessionId: string): Promise<PersistedStopOp | null> {
	return loadRow(getDb(), sessionId);
}

/** Dialect-adapted JSON path comparison on the AUTHORITATIVE row's value. */
function jsonPathEq(path: string, value: string | number): SQL {
	if (config.dialect === "postgres") {
		const arrayPath = `{${path.slice(2)}}`;
		return sqlEmpty().append(sqlPg(arrayPath, value));
	}
	return sqlLite(path, value);
}
// small helpers keep the template pieces readable without importing sql twice
import { sql } from "drizzle-orm";
function sqlEmpty() {
	return sql``;
}
function sqlPg(arrayPath: string, value: string | number) {
	return sql`(${settings.value} #>> ${arrayPath}) = ${String(value)}`;
}
function sqlLite(path: string, value: string | number) {
	if (typeof value === "number") return sql`json_extract(${settings.value}, ${path}) = ${value}`;
	return sql`json_extract(${settings.value}, ${path}) = ${value}`;
}

/** Atomic conditional write on the authoritative row: (stopOpId, revision). */
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

export class PersistentStopStore {
	constructor(
		private readonly transport: StopTransport,
		private readonly attemptTimeoutMs = 5_000,
		/** Test-only: pauses INSIDE the claim transaction (round-29 interleavings). */
		private readonly testHooks: {
			insideClaimTx?: () => Promise<void>;
			beforeTerminationRelease?: () => Promise<void>;
		} = {},
	) {}

	/**
	 * Starts a new round or re-observes the live one. The claim + the round
	 * row are ONE conditional upsert inside ONE transaction: a racer either
	 * sees no row (and may create) or the complete current row — never a
	 * half-installed claim. A stopped row is replaced by the new round in the
	 * same statement; two racing begin()s cannot both win.
	 */
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
		return withTransaction(async (tx) => {
			await this.testHooks.insideClaimTx?.();
			const current = await loadRow(tx, sessionId);
			if (!current) {
				await tx
					.insert(settings)
					.values({ key: KEY(sessionId), value: candidate })
					.onConflictDoNothing({ target: settings.key });
				const mine = await loadRow(tx, sessionId);
				return mine ?? candidate;
			}
			if (current.status !== "stopped") return current; // live round wins
			// Replace the stopped round ATOMICALLY (same row, conditional on
			// the stopped state we just read — inside the transaction).
			const replaced = { ...candidate, revision: current.revision + 1 };
			const rows = await tx
				.update(settings)
				.set({ value: replaced })
				.where(
					and(
						eq(settings.key, KEY(sessionId)),
						jsonPathEq("$.stopOpId", current.stopOpId),
						jsonPathEq("$.revision", current.revision),
					),
				)
				.returning({ key: settings.key });
			if (rows.length > 0) return replaced;
			const racer = await loadRow(tx, sessionId);
			return racer ?? replaced;
		});
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
			revision: observed.revision + 1,
			attempts: observed.attempts + 1,
			status: "abort_sent",
			unsettled: [...observed.unsettled, attemptId],
		};
		const accepted = await casUpdate(observed, registered);
		if (!accepted) {
			const now = await load(sessionId);
			return { rejected: now?.status === "stopped" ? "stopped_round" : "superseded" };
		}
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
				return { stopOpId: registered.stopOpId, attemptId, transportOk: false, timedOut: true };
			}
			await wired;
			return { stopOpId: registered.stopOpId, attemptId, transportOk: false, timedOut: false };
		}
	}

	async settleAttempt(
		sessionId: string,
		stopOpId: string,
		attemptId: string,
		_transportOk: boolean,
	): Promise<boolean> {
		for (let tries = 0; tries < 3; tries++) {
			const current = await load(sessionId);
			if (!current || current.stopOpId !== stopOpId) return false;
			if (!current.unsettled.includes(attemptId)) return true;
			const next: PersistedStopOp = {
				...current,
				revision: current.revision + 1,
				unsettled: current.unsettled.filter((id) => id !== attemptId),
			};
			if (await casUpdate(current, next)) return true;
		}
		return false;
	}

	/**
	 * TERMINATION — refused while any attempt is unsettled. The status flip is
	 * a single conditional write on the AUTHORITATIVE row matching
	 * (stopOpId, revision): a late confirmation carrying an OLD round's id
	 * simply does not match and changes nothing.
	 */
	async confirmTermination(
		sessionId: string,
		stopOpId: string,
	): Promise<boolean | { refused: "uncertain" | "unknown_round" }> {
		for (let tries = 0; tries < 3; tries++) {
			const current = await load(sessionId);
			if (!current || current.stopOpId !== stopOpId) return { refused: "unknown_round" };
			if (current.unsettled.length > 0) return { refused: "uncertain" };
			if (current.status === "stopped") return true;
			await this.testHooks.beforeTerminationRelease?.();
			const next: PersistedStopOp = {
				...current,
				revision: current.revision + 1,
				status: "stopped",
			};
			if (await casUpdate(current, next)) return true;
		}
		return false;
	}

	async canResume(sessionId: string): Promise<boolean> {
		const op = await load(sessionId);
		return Boolean(op && op.status === "stopped" && op.unsettled.length === 0);
	}

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
	 * Restart reconciliation (structural binding only — verification is a
	 * main-path responsibility, NOT implemented here).
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
		return casUpdate(current, next);
	}
}
