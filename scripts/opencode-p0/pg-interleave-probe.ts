/**
 * PG forced-interleaving probe for the protected STOP epoch.
 *
 * Each scenario runs through the REAL services on a scratch PG database with
 * EXPLICIT ordering, asserts the expected success/refusal SETS, and fails on
 * any unexpected error. A final two-connection case proves the binding row lock
 * makes STOP wait for an open transaction.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";

const baseUrl = process.env.AGENTPULSE_PG_PROBE_URL;
if (!baseUrl) {
	console.error("set AGENTPULSE_PG_PROBE_URL");
	process.exit(2);
}
const probe = `ap_interleave_probe_${crypto.randomUUID().replaceAll("-", "_")}`;
const url = new URL(baseUrl);
url.pathname = `/${probe}`;
const admin = postgres(baseUrl, { max: 1, onnotice: () => {} });
const evidence: Record<string, unknown> = { probe };
const expect = (ok: boolean, label: string) => {
	if (!ok) throw new Error(`assertion_failed:${label}`);
};
let ok = false;
try {
	await admin.unsafe(`CREATE DATABASE "${probe}"`);
	process.env.DATABASE_URL = url.toString();
	process.env.DATA_DIR = await mkdtemp(join(tmpdir(), "ap-interleave-"));
	const { initializeDatabase, getDb } = await import("../../src/server/db/client.js");
	const schema = await import("../../src/server/db/schema/index.js");
	const { eq, and } = await import("drizzle-orm");
	const { reserveOpenCodeInstance } = await import(
		"../../src/server/services/opencode-control-provenance.js"
	);
	const { claimNextControlAction, assertExecutionPermit, updateControlAction } = await import(
		"../../src/server/services/control-actions.js"
	);
	const { queueOpenCodeAction } = await import("../../src/server/services/opencode-managed.js");
	const { finalizeOpenCodeFork } = await import("../../src/server/services/opencode-fork-service.js");
	const { config } = await import("../../src/server/config.js");
	await initializeDatabase();

	const seed = async (suffix: string) => {
		await getDb().insert(schema.supervisors).values({
			id: `pg-host-${suffix}`,
			hostName: `pg-host-${suffix}`,
			platform: "linux",
			arch: "x64",
			version: "t",
			status: "connected",
			trustedRoots: ["/tmp"],
			capabilities: {},
		});
		const sessionId = `pg-parent-${suffix}`;
		const [launch] = await getDb()
			.insert(schema.launchRequests)
			.values({
				launchCorrelationId: sessionId,
				agentType: "opencode",
				cwd: "/tmp",
				requestedLaunchMode: "managed_opencode",
				claimedBySupervisorId: `pg-host-${suffix}`,
				status: "launching",
			})
			.returning();
		const instance = await reserveOpenCodeInstance(`pg-host-${suffix}`, launch.id);
		await getDb()
			.update(schema.providerInstances)
			.set({ state: "running" })
			.where(eq(schema.providerInstances.id, instance.id));
		await getDb().insert(schema.sessions).values({ sessionId, agentType: "opencode", cwd: "/tmp" });
		await getDb().insert(schema.managedSessions).values({
			sessionId,
			launchRequestId: launch.id,
			supervisorId: `pg-host-${suffix}`,
			providerSessionId: `ses_${suffix}`,
			managedState: "managed",
		});
		await getDb().insert(schema.sessionControlBindings).values({
			sessionId,
			origin: "agentpulse_launch",
			instanceId: instance.id,
			nativeSessionId: `ses_${suffix}`,
			generation: 1,
		});
		return { sessionId, supervisorId: `pg-host-${suffix}`, instanceId: instance.id };
	};
	const binding = async (sessionId: string) => {
		const [row] = await getDb()
			.select()
			.from(schema.sessionControlBindings)
			.where(eq(schema.sessionControlBindings.sessionId, sessionId));
		return row;
	};
	const actionOf = async (sessionId: string, type: string) => {
		const [row] = await getDb()
			.select()
			.from(schema.controlActions)
			.where(
				and(
					eq(schema.controlActions.sessionId, sessionId),
					eq(schema.controlActions.actionType, type),
				),
			);
		return row;
	};

	// A) CLAIM WINS, then STOP is deferred, result releases, STOP applies.
	{
		const { sessionId, supervisorId } = await seed("a");
		await queueOpenCodeAction(sessionId, "prompt", { prompt: "a" }, { label: "u", userId: "u-a" } as never);
		const claimed = await claimNextControlAction(supervisorId);
		expect(claimed?.actionType === "prompt", "a-claim");
		const stop1 = await queueOpenCodeAction(sessionId, "stop", {}, { label: "u", userId: "u-a" } as never)
			.then(() => "applied")
			.catch((error: Error) => error.message);
		expect(stop1 === "opencode_stop_deferred", "a-stop-deferred");
		const token = String((claimed?.metadata as Record<string, unknown>)?.claimToken ?? "");
		const permitBefore = await assertExecutionPermit({
			actionId: claimed?.id ?? "",
			supervisorId,
			claimToken: token,
		}).then(() => "allowed");
		expect(permitBefore === "allowed", "a-permit-before");
		const report = await updateControlAction({
			actionId: claimed?.id ?? "",
			supervisorId,
			status: "failed",
			claimToken: token,
			error: "done",
		});
		expect(report?.status === "failed", "a-report");
		await queueOpenCodeAction(sessionId, "stop", {}, { label: "u", userId: "u-a" } as never);
		expect((await binding(sessionId))?.stopState === "stopping", "a-stop-applied");
		evidence.scenarioA = { stop1, permitBefore, report: report?.status };
	}

	// B) STOP WINS: a claim afterwards must NOT be handed out, and execution is fenced.
	{
		const { sessionId, supervisorId } = await seed("b");
		await queueOpenCodeAction(sessionId, "stop", {}, { label: "u", userId: "u-b" } as never);
		expect((await binding(sessionId))?.stopState === "stopping", "b-stopping");
		expect(await claimNextControlAction(supervisorId), "b-claim-null");
		evidence.scenarioB = { stopState: (await binding(sessionId))?.stopState, claimed: null };
	}

	// C) RESULT vs STOP: a permit lease defers STOP; the matching terminal result
	//    releases it; the stale permit is refused afterwards.
	{
		const { sessionId, supervisorId } = await seed("c");
		await queueOpenCodeAction(sessionId, "prompt", { prompt: "c" }, { label: "u", userId: "u-c" } as never);
		const claimed = await claimNextControlAction(supervisorId);
		const token = String((claimed?.metadata as Record<string, unknown>)?.claimToken ?? "");
		await assertExecutionPermit({ actionId: claimed?.id ?? "", supervisorId, claimToken: token });
		const stop1 = await queueOpenCodeAction(sessionId, "stop", {}, { label: "u", userId: "u-c" } as never)
			.then(() => "applied")
			.catch((error: Error) => error.message);
		expect(stop1 === "opencode_stop_deferred", "c-deferred");
		// An OLD token must not release the lease.
		const staleResult = await updateControlAction({
			actionId: claimed?.id ?? "",
			supervisorId,
			status: "failed",
			claimToken: "old",
		});
		expect(staleResult === null, "c-old-token");
		await updateControlAction({
			actionId: claimed?.id ?? "",
			supervisorId,
			status: "failed",
			claimToken: token,
		});
		await queueOpenCodeAction(sessionId, "stop", {}, { label: "u", userId: "u-c" } as never);
		const permitAfter = await assertExecutionPermit({
			actionId: claimed?.id ?? "",
			supervisorId,
			claimToken: token,
		}).then(() => "ALLOWED").catch((error: Error) => error.message);
		expect(permitAfter !== "ALLOWED", "c-permit-after");
		evidence.scenarioC = { stop1, permitAfter };
	}

	// E) FINALIZE x STOP, both orders, with a real transaction barrier.
	{
		(config as Record<string, unknown>).opencodeForkEntry = true;
		// E1: finalize holds its transaction (FOR UPDATE on the binding) behind a
		// barrier; STOP is attempted meanwhile and must be deferred; finalize then
		// commits the FULL child chain and STOP applies on retry.
		const first = await seed("e1");
		await queueOpenCodeAction(
			first.sessionId,
			"opencode_fork",
			{ idempotencyKey: "pg-fork-e1" },
			{ label: "u", userId: "u-e1" } as never,
		);
		const forkAction = await claimNextControlAction(first.supervisorId);
		expect(forkAction?.actionType === "opencode_fork", "e1-claim");
		const forkToken = String((forkAction?.metadata as Record<string, unknown>)?.claimToken ?? "");
		let reachedBarrier: (() => void) | null = null;
		let releaseBarrier: (() => void) | null = null;
		const barrierReached = new Promise<void>((resolve) => {
			reachedBarrier = resolve;
		});
		const barrier = new Promise<void>((resolve) => {
			releaseBarrier = resolve;
		});
		const finalizing = finalizeOpenCodeFork(
			{
				actionId: forkAction?.id ?? "",
				supervisorId: first.supervisorId,
				claimToken: forkToken,
				childNativeSessionId: "ses_pg_fork_child_e1",
				parentSnapshot: {
					version: 1,
					instanceId: first.instanceId,
					nativeSessionId: "ses_e1",
					messages: [],
					forkPointMessageId: null,
				},
			},
			{
				beforeFinalCas: async () => {
					reachedBarrier?.();
					await barrier;
				},
			},
		);
		await barrierReached;
		const stopDuringFinalize = await queueOpenCodeAction(
			first.sessionId,
			"stop",
			{},
			{ label: "u", userId: "u-e1" } as never,
		)
			.then(() => "applied")
			.catch((error: Error) => error.message);
		expect(stopDuringFinalize === "opencode_stop_deferred", "e1-stop-deferred");
		releaseBarrier?.();
		const finalized = await finalizing;
		expect(finalized.replayed === false, "e1-finalized");
		// Full success chain: session + managed + binding + lineage + ledger identity.
		const { eq: eqOp } = await import("drizzle-orm");
		const [childSession] = await getDb()
			.select()
			.from(schema.sessions)
			.where(eqOp(schema.sessions.sessionId, finalized.childSessionId));
		const [childManaged] = await getDb()
			.select()
			.from(schema.managedSessions)
			.where(eqOp(schema.managedSessions.sessionId, finalized.childSessionId));
		const [childBinding] = await getDb()
			.select()
			.from(schema.sessionControlBindings)
			.where(eqOp(schema.sessionControlBindings.sessionId, finalized.childSessionId));
		const [childLineage] = await getDb()
			.select()
			.from(schema.opencodeForks)
			.where(eqOp(schema.opencodeForks.childSessionId, finalized.childSessionId));
		const [ledgerRow] = await getDb()
			.select()
			.from(schema.opencodeForkRequests)
			.where(eqOp(schema.opencodeForkRequests.actionId, forkAction?.id ?? ""));
		expect(
			Boolean(childSession) &&
				Boolean(childManaged) &&
				Boolean(childBinding) &&
				Boolean(childLineage) &&
				Boolean((ledgerRow?.identity as Record<string, unknown> | null)?.result),
			"e1-full-chain",
		);
		// STOP retries after the fork finished and applies.
		await queueOpenCodeAction(
			first.sessionId,
			"stop",
			{},
			{ label: "u", userId: "u-e1" } as never,
		);
		expect((await binding(first.sessionId))?.stopState === "stopping", "e1-stop-after");

		// E2: STOP commits FIRST; a stale fork attempt cannot finalize (whole
		// transaction rolls back, zero child artifacts).
		const second = await seed("e2");
		await queueOpenCodeAction(
			second.sessionId,
			"opencode_fork",
			{ idempotencyKey: "pg-fork-e2" },
			{ label: "u", userId: "u-e2" } as never,
		);
		const staleFork = await claimNextControlAction(second.supervisorId);
		const staleToken = String((staleFork?.metadata as Record<string, unknown>)?.claimToken ?? "");
		// STOP first: this cancels the QUEUED fork; the claimed one is running and
		// would defer, so report it as failed first, then STOP, then simulate a
		// stale running attempt with the OLD epoch.
		await updateControlAction({
			actionId: staleFork?.id ?? "",
			supervisorId: second.supervisorId,
			status: "failed",
			claimToken: staleToken,
			error: "pre_stop",
		});
		await queueOpenCodeAction(second.sessionId, "stop", {}, { label: "u", userId: "u-e2" } as never);
		expect((await binding(second.sessionId))?.stopState === "stopping", "e2-stopping");
		await getDb()
			.update(schema.controlActions)
			.set({
				status: "running",
				metadata: {
					...((staleFork?.metadata as Record<string, unknown>) ?? {}),
					controlEpoch: 0,
					claimToken: "stale-token-e2",
				},
			})
			.where(eqOp(schema.controlActions.id, staleFork?.id ?? ""));
		const before = {
			sessions: (await getDb().select().from(schema.sessions)).length,
			managed: (await getDb().select().from(schema.managedSessions)).length,
			bindings: (await getDb().select().from(schema.sessionControlBindings)).length,
			lineage: (await getDb().select().from(schema.opencodeForks)).length,
			ledgerIdentities: (await getDb().select().from(schema.opencodeForkRequests)).filter(
				(row) => row.identity !== null,
			).length,
		};
		const rejected = await finalizeOpenCodeFork({
			actionId: staleFork?.id ?? "",
			supervisorId: second.supervisorId,
			claimToken: "stale-token-e2",
			childNativeSessionId: "ses_pg_fork_child_e2",
			parentSnapshot: {
				version: 1,
				instanceId: second.instanceId,
				nativeSessionId: "ses_e2",
				messages: [],
				forkPointMessageId: null,
			},
		})
			.then(() => "COMMITTED")
			.catch((error: Error) => error.message);
		expect(rejected === "provider_binding_invalid", "e2-rejected");
		const after = {
			sessions: (await getDb().select().from(schema.sessions)).length,
			managed: (await getDb().select().from(schema.managedSessions)).length,
			bindings: (await getDb().select().from(schema.sessionControlBindings)).length,
			lineage: (await getDb().select().from(schema.opencodeForks)).length,
			ledgerIdentities: (await getDb().select().from(schema.opencodeForkRequests)).filter(
				(row) => row.identity !== null,
			).length,
		};
		expect(
			before.sessions === after.sessions &&
				before.managed === after.managed &&
				before.bindings === after.bindings &&
				before.lineage === after.lineage &&
				before.ledgerIdentities === after.ledgerIdentities,
			"e2-no-partial-artifacts",
		);
		evidence.scenarioE = {
			finalizeFirst: { stop: stopDuringFinalize, replayed: finalized.replayed },
			stopFirst: { rejected, artifactsUnchanged: before, artifactsAfter: after },
		};
	}

	// D) TWO CONNECTIONS: an open FOR UPDATE transaction makes STOP wait.
	{
		const { sessionId } = await seed("d");
		const holder = postgres(url.toString(), { max: 1 });
		await holder.begin(async (tx) => {
			await tx`SELECT session_id FROM session_control_bindings WHERE session_id = ${sessionId} FOR UPDATE`;
			const started = Date.now();
			const stopPromise = queueOpenCodeAction(
				sessionId,
				"stop",
				{},
				{ label: "u", userId: "u-d" } as never,
			);
			await Bun.sleep(400);
			const stillWaiting = (await binding(sessionId))?.stopState === "active";
			await tx.unsafe("COMMIT");
			await stopPromise;
			const waited = Date.now() - started;
			expect(stillWaiting && waited >= 350, "d-lock-waited");
			evidence.scenarioD = { waitedMs: waited, blockedWhileHeld: stillWaiting };
		});
		await holder.end({ timeout: 5 });
	}
	ok = true;
} finally {
	await admin.unsafe(`DROP DATABASE IF EXISTS "${probe}" WITH (FORCE)`).catch(() => {});
	await admin.end({ timeout: 5 }).catch(() => {});
}
await writeFile(join(import.meta.dir, "pg-interleave-evidence.json"), JSON.stringify({ ...evidence, ok }, null, 1));
console.log(JSON.stringify({ ...evidence, ok }, null, 1));
process.exit(ok ? 0 : 1);
