/**
 * Durable fork execution ledger (A6). A native fork is NOT idempotent, so a
 * crash, a lost report or a re-claimed action must never cause a second fork.
 *
 * Lifecycle of `<instance>/fork-<actionId>.json`:
 *   intent  -> written BEFORE the native call (no child id yet);
 *              recovery of an intent means OUTCOME UNKNOWN: refuse, don't fork.
 *   created -> atomic rewrite right after the native call returned a child;
 *   done    -> written after the server confirmed the managed binding and kept
 *              for the life of the instance: a later claim re-reports and
 *              re-registers the SAME child instead of forking again.
 *
 * Error handling is deliberate: only a genuinely absent file allows a first
 * execution. Corrupt or unreadable records fail closed.
 */
import { open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ForkSnapshot } from "./fork-snapshot.js";

export interface ForkRecord {
	version: 1;
	actionId: string;
	instanceId: string;
	generation: number;
	/** The claim token under which the native fork executed. */
	claimToken: string;
	/** The token the server ACCEPTED; future replays must use exactly this one. */
	finalizedToken?: string;
	phase: "intent" | "created" | "done";
	childNativeSessionId?: string;
	parentSnapshot?: ForkSnapshot;
}

export interface ForkIdentity {
	actionId: string;
	instanceId: string;
	generation: number;
}

const pathFor = (directory: string, identity: ForkIdentity) =>
	join(directory, `fork-${identity.actionId}.json`);

const sameBinding = (record: ForkRecord, identity: ForkIdentity) =>
	record.actionId === identity.actionId &&
	record.instanceId === identity.instanceId &&
	record.generation === identity.generation;

/** Returns null only when the record is genuinely absent. */
export async function readForkRecord(
	directory: string,
	identity: ForkIdentity,
	nativeSessionId?: string,
): Promise<ForkRecord | null> {
	let text: string;
	try {
		text = await readFile(pathFor(directory, identity), "utf8");
	} catch (error) {
		if ((error as { code?: string }).code === "ENOENT") return null;
		throw new Error("opencode_fork_ledger_unreadable", { cause: error });
	}
	let parsed: ForkRecord;
	try {
		parsed = JSON.parse(text) as ForkRecord;
	} catch (error) {
		throw new Error("opencode_fork_ledger_corrupt", { cause: error });
	}
	if (
		parsed?.version !== 1 ||
		typeof parsed.claimToken !== "string" ||
		!["intent", "created", "done"].includes(String(parsed.phase)) ||
		!sameBinding(parsed, identity)
	)
		throw new Error("opencode_fork_ledger_corrupt");
	// A record that claims a child/snapshot must actually BE complete before it
	// may be re-reported: never hand the server half-evidence.
	if (parsed.phase !== "intent") {
		// The recorded snapshot must belong to THIS instance and THIS native
		// parent, not merely to a same-named action file.
		if (
			parsed.parentSnapshot?.instanceId !== identity.instanceId ||
			(nativeSessionId !== undefined &&
				parsed.parentSnapshot?.nativeSessionId !== nativeSessionId)
		)
			throw new Error("opencode_fork_ledger_corrupt");
		if (
			typeof parsed.childNativeSessionId !== "string" ||
			!/^ses_[A-Za-z0-9_-]+$/.test(parsed.childNativeSessionId)
		)
			throw new Error("opencode_fork_ledger_corrupt");
		const snapshot = parsed.parentSnapshot;
		if (
			!snapshot ||
			snapshot.version !== 1 ||
			typeof snapshot.instanceId !== "string" ||
			typeof snapshot.nativeSessionId !== "string" ||
			!Array.isArray(snapshot.messages) ||
			snapshot.messages.some(
				(message) =>
					typeof message?.nativeId !== "string" || typeof message?.contentHash !== "string",
			)
		)
			throw new Error("opencode_fork_ledger_corrupt");
	}
	return parsed;
}

/** Atomic: a crash leaves either the old or the new full record, never a mix. */
async function writeRecord(directory: string, identity: ForkIdentity, record: ForkRecord) {
	const target = pathFor(directory, identity);
	const temp = `${target}.tmp-${crypto.randomUUID()}`;
	const handle = await open(temp, "w", 0o600);
	try {
		await handle.writeFile(JSON.stringify(record));
		// Atomic rename protects against torn files; fsync is ordered so the
		// record is durable across a normal host crash path. (No power-loss
		// experiment has been run — do not claim absolute crash safety.)
		await handle.sync();
	} finally {
		await handle.close();
	}
	await rename(temp, target);
	// Persist the directory entry too, or the rename itself can be lost.
	const dir = await open(directory, "r");
	try {
		await dir.sync();
	} finally {
		await dir.close();
	}
}

export interface ForkAttempt {
	directory: string;
	identity: ForkIdentity;
	/** The native parent this execution belongs to; a record from another
	 *  parent (even same instance) is not trusted. */
	nativeSessionId: string;
	/** Claim token of THIS claim; a recorded child keeps its ORIGINAL token. */
	claimToken: string;
	/** Optional copyOf point; must exist in the captured parent snapshot. */
	forkPointMessageId: string | null;
	capture: () => Promise<ForkSnapshot>;
	fork: (forkPointMessageId: string | null) => Promise<{ id: string }>;
	/** Reports the record; resolves with the token the server ACCEPTED. */
	report: (record: ForkRecord) => Promise<{ token: string }>;
	/** Called only after the report confirmed the managed binding. */
	register: (childNativeSessionId: string) => void;
}

export async function executeOrReportFork(
	attempt: ForkAttempt,
): Promise<"forked" | "reported" | "replayed"> {
	const existing = await readForkRecord(attempt.directory, attempt.identity, attempt.nativeSessionId);
	if (existing?.phase === "intent")
		// The process died between the intent and the native result. The fork may
		// or may not exist; forking again could duplicate it. Reconciliation.
		throw new Error("opencode_fork_outcome_unknown");
	if (existing?.phase === "created") {
		// Native child exists but the binding was never confirmed: report only.
		const { token } = await attempt.report(existing);
		if (!existing.childNativeSessionId) throw new Error("opencode_fork_ledger_corrupt");
		attempt.register(existing.childNativeSessionId);
		await writeRecord(attempt.directory, attempt.identity, {
			...existing,
			phase: "done",
			finalizedToken: token,
		});
		return "reported";
	}
	if (existing?.phase === "done") {
		// Already committed: re-report idempotently and re-register the SAME child.
		await attempt.report(existing);
		if (!existing.childNativeSessionId) throw new Error("opencode_fork_ledger_corrupt");
		attempt.register(existing.childNativeSessionId);
		return "replayed";
	}

	// No record: this is the only path that may execute a native fork.
	const base: ForkRecord = {
		version: 1,
		...attempt.identity,
		claimToken: attempt.claimToken,
		phase: "intent",
	};
	await writeRecord(attempt.directory, attempt.identity, base);
	const parentSnapshot = await attempt.capture();
	// copyOf: the point must be IN the evidence we just captured; an unknown id
	// would silently degrade to a full fork.
	if (
		attempt.forkPointMessageId &&
		!parentSnapshot.messages.some((message) => message.nativeId === attempt.forkPointMessageId)
	)
		throw new Error("opencode_fork_point_unknown");
	const created = await attempt.fork(attempt.forkPointMessageId);
	const record: ForkRecord = {
		...base,
		phase: "created",
		childNativeSessionId: created.id,
		parentSnapshot,
	};
	await writeRecord(attempt.directory, attempt.identity, record);
	const { token } = await attempt.report(record);
	if (!record.childNativeSessionId) throw new Error("opencode_fork_ledger_corrupt");
	attempt.register(record.childNativeSessionId);
	await writeRecord(attempt.directory, attempt.identity, {
		...record,
		phase: "done",
		finalizedToken: token,
	});
	return "forked";
}

/**
 * Reports a fork result, reconciling the token the server currently accepts.
 * Only an authorization/CAS refusal (403/409) moves on to the next candidate;
 * transport failures never cause a second delivery. The returned token is the
 * one the server ACCEPTED and must be persisted for future replays.
 */
export async function reportForkWithTokenFallback(params: {
	record: ForkRecord;
	currentClaimToken: string;
	deliver: (token: string) => Promise<unknown>;
}): Promise<{ token: string }> {
	const candidates = [
		...(params.record.finalizedToken ? [params.record.finalizedToken] : []),
		params.record.claimToken,
		params.currentClaimToken,
	].filter((token, index, all) => all.indexOf(token) === index);
	let lastError: unknown = null;
	for (const token of candidates) {
		try {
			await params.deliver(token);
			return { token };
		} catch (error) {
			lastError = error;
			const status = (error as { status?: number }).status;
			if (status !== 403 && status !== 409) throw error;
		}
	}
	throw lastError;
}
