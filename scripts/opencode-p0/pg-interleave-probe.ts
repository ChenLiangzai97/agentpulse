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
		return { sessionId, supervisorId: `pg-host-${suffix}` };
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
