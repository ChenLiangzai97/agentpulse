/**
 * Isolated prototype (NOT wired to the main path): persistent stop operations
 * per docs/OPENCODE_FORK_DESIGN.md §D — the durability layer the in-memory
 * SessionControlEpochStore lacks.
 *
 * Three review-driven boundaries:
 *  1. Operation identity (stopOpId) is PERSISTED (settings rows — the
 *     established cross-dialect store), so it survives a server restart: a
 *     fresh store on the same database sees the same in-flight stop round.
 *  2. RETRY re-issues the abort transport call for the SAME round (one
 *     stopOpId, N transport attempts) instead of parking in 'stopping'.
 *  3. Transport success (HTTP 200) is NOT termination: a round only becomes
 *     'stopped' when TERMINATION is observed (native session left busy /
 *     event stream quiesced) via confirmTermination, which must carry the
 *     round's stopOpId.
 */
import { eq } from "drizzle-orm";
import { getDb } from "../../db/client.js";
import { settings } from "../../db/schema/index.js";

export interface PersistedStopOp {
	stopOpId: number;
	sessionId: string;
	status: "abort_pending" | "abort_sent" | "stopped";
	attempts: number;
	requestHash?: string | null;
}

const KEY = (sessionId: string) => `forkproto.stopop.${sessionId}`;

export class PersistentStopStore {
	constructor(
		private readonly transport: { abortNativeTurn: (sessionId: string) => Promise<void> },
		/** Bound per transport attempt: a HUNG call counts as a failure the
		 * caller may retry, instead of blocking the round forever. */
		private readonly attemptTimeoutMs = 5_000,
	) {}

	private async load(sessionId: string): Promise<PersistedStopOp | null> {
		const [row] = await getDb()
			.select()
			.from(settings)
			.where(eq(settings.key, KEY(sessionId)));
		return row ? (row.value as PersistedStopOp) : null;
	}

	private async save(op: PersistedStopOp): Promise<void> {
		await getDb()
			.insert(settings)
			.values({ key: KEY(op.sessionId), value: op })
			.onConflictDoUpdate({ target: settings.key, set: { value: op } });
	}

	/** Starts (or re-observes, across restarts) the stop round for a session. */
	async begin(sessionId: string, requestHash?: string): Promise<PersistedStopOp> {
		const existing = await this.load(sessionId);
		if (existing && existing.status !== "stopped") return existing; // same round, even after a restart
		const op: PersistedStopOp = {
			stopOpId: Date.now(), // prototype identity; 0015 formalizes a sequence
			sessionId,
			status: "abort_pending",
			attempts: 0,
			requestHash: requestHash ?? null,
		};
		await this.save(op);
		return op;
	}

	/**
	 * Issues (or RE-issues after a failure) the abort for the round. The
	 * transport call count is observable: a retry must actually re-send.
	 */
	async sendAbort(sessionId: string): Promise<{ stopOpId: number; transportOk: boolean }> {
		const op = await this.load(sessionId);
		if (!op) throw new Error("no_stop_round");
		const next: PersistedStopOp = { ...op, attempts: op.attempts + 1, status: "abort_sent" };
		await this.save(next);
		try {
			await Promise.race([
				this.transport.abortNativeTurn(sessionId),
				new Promise<never>((_, reject) =>
					setTimeout(() => reject(new Error("abort_attempt_timeout")), this.attemptTimeoutMs),
				),
			]);
			return { stopOpId: next.stopOpId, transportOk: true };
		} catch {
			// transport failed or hung — the round stays abort_sent with
			// attempts incremented; the caller may retry (re-issuing the
			// transport).
			return { stopOpId: next.stopOpId, transportOk: false };
		}
	}

	/**
	 * TERMINATION confirmation — distinct from transport success. Must carry
	 * the round's stopOpId; a stale id is rejected. This is the only path to
	 * 'stopped', and it models "native session left busy / events quiesced",
	 * never "HTTP 200".
	 */
	async confirmTermination(sessionId: string, stopOpId: number): Promise<boolean> {
		const op = await this.load(sessionId);
		if (!op || op.stopOpId !== stopOpId) return false; // stale or unknown round
		if (op.status === "stopped") return true; // idempotent for the same round
		await this.save({ ...op, status: "stopped" });
		return true;
	}

	async snapshot(sessionId: string): Promise<PersistedStopOp | null> {
		return this.load(sessionId);
	}
}
