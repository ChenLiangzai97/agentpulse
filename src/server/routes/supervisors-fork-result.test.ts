/**
 * Fork RESULT reporting (isolation slice): the authenticated endpoint only
 * accepts a complete report for a known action that carries a pinned parent
 * snapshot. Entry points remain closed; these guards are what the future
 * supervisor caller relies on.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import "../db/__test_db.js";
import { deleteAllSupervisors } from "../services/__test_supervisors.js";

const { config } = await import("../config.js");
const { initializeDatabase, getDb } = await import("../db/client.js");
const {
	controlActions,
	launchRequests,
	managedSessions,
	opencodeForkRequests,
	providerInstances,
	sessionControlBindings,
	sessions,
	supervisors,
} = await import("../db/schema/index.js");
const { reserveOpenCodeInstance } = await import("../services/opencode-control-provenance.js");
const { eq } = await import("drizzle-orm");
const { Hono } = await import("hono");
const { supervisorsAgentRouter } = await import("./supervisors.js");

const app = new Hono().route("/api/v1", supervisorsAgentRouter);
const originalDisableAuth = config.disableAuth;

beforeAll(async () => {
	await initializeDatabase();
	(config as Record<string, unknown>).disableAuth = true;
});

afterAll(async () => {
	await deleteAllSupervisors();
	(config as Record<string, unknown>).disableAuth = originalDisableAuth;
});

async function seedForkChain(claimToken = "claim-1") {
	await getDb()
		.insert(supervisors)
		.values({
			id: "f-host",
			hostName: "f",
			platform: "linux",
			arch: "x64",
			version: "t",
			status: "connected",
			trustedRoots: ["/tmp"],
			capabilities: {},
		})
		.onConflictDoNothing();
	const parentId = `f-parent-${crypto.randomUUID()}`;
	const [launch] = await getDb()
		.insert(launchRequests)
		.values({
			launchCorrelationId: parentId,
			agentType: "opencode",
			cwd: "/tmp",
			requestedLaunchMode: "managed_opencode",
			claimedBySupervisorId: "f-host",
			status: "launching",
		})
		.returning();
	const instance = await reserveOpenCodeInstance("f-host", launch.id);
	await getDb()
		.update(providerInstances)
		.set({ state: "running" })
		.where(eq(providerInstances.id, instance.id));
	await getDb().insert(sessions).values({ sessionId: parentId, agentType: "opencode", cwd: "/tmp" });
	await getDb().insert(managedSessions).values({
		sessionId: parentId,
		launchRequestId: launch.id,
		supervisorId: "f-host",
		providerSessionId: "ses_p",
		managedState: "managed",
	});
	await getDb().insert(sessionControlBindings).values({
		sessionId: parentId,
		origin: "agentpulse_launch",
		instanceId: instance.id,
		nativeSessionId: "ses_p",
		generation: 1,
	});
	const [action] = await getDb()
		.insert(controlActions)
		.values({
			sessionId: parentId,
			actionType: "opencode_fork",
			requestedBy: "user",
			status: "running",
			metadata: {
				claimToken,
				instanceOriginSessionId: parentId,
				directParentSessionId: parentId,
				nativeSessionId: "ses_p",
				instanceId: instance.id,
				generation: 1,
				childDisplayName: "父 · 分支",
			},
		})
		.returning();
	await getDb()
		.insert(opencodeForkRequests)
		.values({ actionId: action.id, requestHash: "h", identity: null });
	const snapshot = {
		version: 1 as const,
		instanceId: instance.id,
		nativeSessionId: "ses_p",
		messages: [{ nativeId: "msg_1", contentHash: "h1" }],
		forkPointMessageId: null,
	};
	return { action, snapshot, parentId };
}

const post = (actionId: string, body: unknown) =>
	app.request(`/api/v1/supervisors/f-host/control-actions/${actionId}/fork-result`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});

describe("POST /supervisors/:id/control-actions/:actionId/fork-result", () => {
	test("refuses an incomplete report", async () => {
		const res = await post("missing-action", { claimToken: "t" });
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "fork_result_incomplete" });
	});

	test("refuses an unknown action", async () => {
		const res = await post("missing-action", {
			claimToken: "t",
			childNativeSessionId: "ses_x",
		});
		expect(res.status).toBe(404);
	});

	test("refuses a report without the pinned parent snapshot", async () => {
		const actionId = crypto.randomUUID();
		await getDb()
			.insert(controlActions)
			.values({
				id: actionId,
				sessionId: null,
				actionType: "opencode_fork",
				status: "running",
				metadata: { claimToken: "t" },
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			});
		const res = await post(actionId, { claimToken: "t", childNativeSessionId: "ses_x" });
		expect(res.status).toBe(409);
		expect(await res.json()).toEqual({ error: "fork_snapshot_missing" });
	});
});

test("the pinned snapshot cannot come from the action metadata mirror", async () => {
	const actionId = crypto.randomUUID();
	await getDb()
		.insert(controlActions)
		.values({
			id: actionId,
			sessionId: null,
			actionType: "opencode_fork",
			status: "running",
			metadata: { claimToken: "t", parentSnapshot: { version: 1 } },
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		});
	const res = await post(actionId, { claimToken: "t", childNativeSessionId: "ses_x" });
	expect(res.status).toBe(409);
});

test("a non-fork action cannot be finalized as a fork", async () => {
	const actionId = crypto.randomUUID();
	await getDb()
		.insert(controlActions)
		.values({
			id: actionId,
			sessionId: null,
			actionType: "stop",
			status: "running",
			metadata: { claimToken: "t" },
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		});
	const res = await post(actionId, {
		claimToken: "t",
		childNativeSessionId: "ses_x",
		parentSnapshot: {
			version: 1,
			instanceId: "i",
			nativeSessionId: "ses_y",
			messages: [],
			forkPointMessageId: null,
		},
	});
	expect(res.status).toBe(403);
	expect(await res.json()).toEqual({ error: "provider_binding_invalid" });
});

describe("authenticated report -> finalize chain", () => {
	test("a lost response is retried idempotently with the same token and child", async () => {
		const { action, snapshot } = await seedForkChain("claim-1");
		const childNativeSessionId = "ses_child_chain";
		const body = { claimToken: "claim-1", childNativeSessionId, parentSnapshot: snapshot };
		const first = await post(action.id, body);
		expect(first.status).toBe(200);
		const firstBody = (await first.json()) as { childSessionId: string; replayed: boolean };
		expect(firstBody.replayed).toBe(false);
		// The client never saw that response: retry EXACTLY the same report.
		const retry = await post(action.id, body);
		expect(retry.status).toBe(200);
		const retryBody = (await retry.json()) as { childSessionId: string; replayed: boolean };
		expect(retryBody.replayed).toBe(true);
		expect(retryBody.childSessionId).toBe(firstBody.childSessionId);
	});

	test("an OLD claim token is refused after a re-claim — the CAS is not loosened", async () => {
		const { action, snapshot } = await seedForkChain("claim-1");
		// A re-claim replaces the token while the native fork result is pending.
		const meta = action.metadata as Record<string, unknown>;
		await getDb()
			.update(controlActions)
			.set({ metadata: { ...meta, claimToken: "claim-2" } })
			.where(eq(controlActions.id, action.id));
		const stale = await post(action.id, {
			claimToken: "claim-1",
			childNativeSessionId: "ses_child_chain",
			parentSnapshot: snapshot,
		});
		expect(stale.status).toBe(403);
		expect(await stale.json()).toEqual({ error: "provider_binding_invalid" });
		// The supervisor's CURRENT claim (the one it holds) is the authority.
		const fresh = await post(action.id, {
			claimToken: "claim-2",
			childNativeSessionId: "ses_child_chain",
			parentSnapshot: snapshot,
		});
		expect(fresh.status).toBe(200);
	});
});
