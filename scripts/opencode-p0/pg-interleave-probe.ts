/**
 * PG two-connection interleaving probe: CLAIM vs STOP on the protected epoch.
 *
 * A scratch PG database is initialized through the REAL migrations/services.
 * A prompt is queued, then claimNextControlAction and queueOpenCodeAction(stop)
 * run CONCURRENTLY on two pool connections. Invariant: the action either stays
 * fenced (stop won -> epoch advanced, execution permit refuses) or is failed;
 * it is never executable under a stale epoch.
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
const scratchUrl = url.toString();
const admin = postgres(baseUrl, { max: 1, onnotice: () => {} });
let ok = false;
const evidence: Record<string, unknown> = { probe };
try {
	await admin.unsafe(`CREATE DATABASE "${probe}"`);
	process.env.DATABASE_URL = scratchUrl;
	process.env.DATA_DIR = await mkdtemp(join(tmpdir(), "ap-interleave-"));
	const { initializeDatabase, getDb } = await import("../../src/server/db/client.js");
	const schema = await import("../../src/server/db/schema/index.js");
	const { reserveOpenCodeInstance } = await import(
		"../../src/server/services/opencode-control-provenance.js"
	);
	const { claimNextControlAction, assertExecutionPermit } = await import(
		"../../src/server/services/control-actions.js"
	);
	const { queueOpenCodeAction } = await import("../../src/server/services/opencode-managed.js");
	await initializeDatabase();

	await getDb().insert(schema.supervisors).values({
		id: "pg-host",
		hostName: "pg-host",
		platform: "linux",
		arch: "x64",
		version: "t",
		status: "connected",
		trustedRoots: ["/tmp"],
		capabilities: {},
	});
	const [launch] = await getDb()
		.insert(schema.launchRequests)
		.values({
			launchCorrelationId: "pg-parent",
			agentType: "opencode",
			cwd: "/tmp",
			requestedLaunchMode: "managed_opencode",
			claimedBySupervisorId: "pg-host",
			status: "launching",
		})
		.returning();
	const instance = await reserveOpenCodeInstance("pg-host", launch.id);
	await getDb()
		.update(schema.providerInstances)
		.set({ state: "running" })
		.where((await import("drizzle-orm")).eq(schema.providerInstances.id, instance.id));
	await getDb().insert(schema.sessions).values({ sessionId: "pg-parent", agentType: "opencode", cwd: "/tmp" });
	await getDb().insert(schema.managedSessions).values({
		sessionId: "pg-parent",
		launchRequestId: launch.id,
		supervisorId: "pg-host",
		providerSessionId: "ses_pg",
		managedState: "managed",
	});
	await getDb().insert(schema.sessionControlBindings).values({
		sessionId: "pg-parent",
		origin: "agentpulse_launch",
		instanceId: instance.id,
		nativeSessionId: "ses_pg",
		generation: 1,
	});
	const actor = { label: "user", userId: "pg-user" } as never;
	await queueOpenCodeAction("pg-parent", "prompt", { prompt: "interleaved" }, actor);

	const [claim, stop] = await Promise.allSettled([
		claimNextControlAction("pg-host"),
		queueOpenCodeAction("pg-parent", "stop", {}, actor),
	]);
	const claimed = claim.status === "fulfilled" ? claim.value : null;
	const stopResult = stop.status === "fulfilled" ? stop.value : null;
	const stopError = stop.status === "rejected" ? String((stop as PromiseRejectedResult).reason) : null;
	evidence.claim = claimed ? { id: claimed.id, type: claimed.actionType } : null;
	evidence.stop = stopResult ? { id: stopResult.id, type: stopResult.actionType } : null;
	evidence.stopError = stopError;

	const [action] = await getDb()
		.select()
		.from(schema.controlActions)
		.where((await import("drizzle-orm")).eq(schema.controlActions.sessionId, "pg-parent"));
	const [binding] = await getDb()
		.select()
		.from(schema.sessionControlBindings)
		.where((await import("drizzle-orm")).eq(schema.sessionControlBindings.sessionId, "pg-parent"));
	const token = String((action?.metadata as Record<string, unknown>)?.claimToken ?? "");
	// If the claimed action survived RUNNING, execution must be fenced.
	let permitRefused = "no_running_claim";
	if (claimed && action?.status === "running") {
		permitRefused = await assertExecutionPermit({
			actionId: claimed.id,
			supervisorId: "pg-host",
			claimToken: token,
		})
			.then(() => "ALLOWED")
			.catch((error: Error) => error.message);
	}
	evidence.action = action
		? { status: action.status, epoch: (action.metadata as Record<string, unknown>)?.controlEpoch }
		: null;
	evidence.binding = binding
		? { stopState: binding.stopState, stopEpoch: binding.stopEpoch }
		: null;
	evidence.permit = permitRefused;
	const staleRunning =
		action?.status === "running" && binding && (action.metadata as Record<string, unknown>)?.controlEpoch !== binding.stopEpoch;
	ok =
		!staleRunning ||
		permitRefused === "opencode_session_stopped" ||
		permitRefused === "provider_binding_invalid";
} finally {
	await admin.unsafe(`DROP DATABASE IF EXISTS "${probe}" WITH (FORCE)`).catch(() => {});
	await admin.end({ timeout: 5 }).catch(() => {});
}
await writeFile(join(import.meta.dir, "pg-interleave-evidence.json"), JSON.stringify(evidence, null, 1));
console.log(JSON.stringify(evidence, null, 1));
process.exit(ok ? 0 : 1);
