/**
 * Fork REQUEST acceptance (entry CLOSED by default): the route refuses unless
 * the operator opens AGENTPULSE_OPENCODE_FORK_ENTRY; when open it queues an
 * opencode_fork action with the binding identity + acceptance ledger row.
 */
import "../db/__test_db.js";
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

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
const { Hono } = await import("hono");
const { sessionsRouter } = await import("./sessions.js");
const { reserveOpenCodeInstance } = await import("../services/opencode-control-provenance.js");

const app = new Hono().route("/api/v1", sessionsRouter);
const originalDisableAuth = config.disableAuth;
const originalEntry = config.opencodeForkEntry;

beforeAll(async () => {
	await initializeDatabase();
	(config as Record<string, unknown>).disableAuth = true;
});

afterAll(() => {
	(config as Record<string, unknown>).disableAuth = originalDisableAuth;
	(config as Record<string, unknown>).opencodeForkEntry = originalEntry;
});

beforeEach(async () => {
	for (const table of [
		opencodeForkRequests,
		controlActions,
		sessionControlBindings,
		managedSessions,
		providerInstances,
		launchRequests,
		sessions,
		supervisors,
	])
		await getDb().delete(table);
});

async function seedManagedSession() {
	await getDb().insert(supervisors).values({
		id: "fork-host",
		hostName: "fork-host",
		platform: "linux",
		arch: "x64",
		version: "t",
		status: "connected",
		trustedRoots: ["/tmp"],
		capabilities: {},
	});
	const parentId = "fork-parent-session";
	const [launch] = await getDb()
		.insert(launchRequests)
		.values({
			launchCorrelationId: parentId,
			agentType: "opencode",
			cwd: "/tmp",
			requestedLaunchMode: "managed_opencode",
			claimedBySupervisorId: "fork-host",
			status: "launching",
		})
		.returning();
	const instance = await reserveOpenCodeInstance("fork-host", launch.id);
	await getDb()
		.update(providerInstances)
		.set({ state: "running" })
		.where(eq(providerInstances.id, instance.id));
	await getDb().insert(sessions).values({ sessionId: parentId, agentType: "opencode", cwd: "/tmp" });
	await getDb().insert(managedSessions).values({
		sessionId: parentId,
		launchRequestId: launch.id,
		supervisorId: "fork-host",
		providerSessionId: "ses_parent",
		managedState: "managed",
	});
	await getDb().insert(sessionControlBindings).values({
		sessionId: parentId,
		origin: "agentpulse_launch",
		instanceId: instance.id,
		nativeSessionId: "ses_parent",
		generation: 1,
	});
	return { parentId, instance };
}

const post = (sessionId: string, body: unknown = {}) =>
	app.request(`/api/v1/sessions/${sessionId}/fork`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});

test("the entry is CLOSED by default", async () => {
	(config as Record<string, unknown>).opencodeForkEntry = false;
	const { parentId } = await seedManagedSession();
	const res = await post(parentId);
	expect(res.status).toBe(403);
	expect(await res.json()).toEqual({ error: "opencode_fork_entry_closed" });
	expect(await getDb().select().from(controlActions)).toHaveLength(0);
});

test("when opened: queues the fork action with identity metadata + ledger row", async () => {
	(config as Record<string, unknown>).opencodeForkEntry = true;
	const { parentId, instance } = await seedManagedSession();
	const res = await post(parentId, { childDisplayName: "父 · 分支" });
	expect(res.status).toBe(202);
	const body = (await res.json()) as { action: { id: string } };
	const [action] = await getDb()
		.select()
		.from(controlActions)
		.where(eq(controlActions.id, body.action.id));
	expect(action?.actionType).toBe("opencode_fork");
	expect(action?.status).toBe("queued");
	const meta = action?.metadata as Record<string, unknown>;
	expect(meta.instanceId).toBe(instance.id);
	expect(meta.nativeSessionId).toBe("ses_parent");
	expect(meta.instanceOriginSessionId).toBe(parentId);
	expect(meta.directParentSessionId).toBe(parentId);
	expect(meta.childDisplayName).toBe("父 · 分支");
	const ledger = await getDb()
		.select()
		.from(opencodeForkRequests)
		.where(eq(opencodeForkRequests.actionId, body.action.id));
	expect(ledger).toHaveLength(1);
});

test("a no-key second request while one is queued is refused as busy", async () => {
	(config as Record<string, unknown>).opencodeForkEntry = true;
	const { parentId } = await seedManagedSession();
	expect((await post(parentId, {})).status).toBe(202);
	const second = await post(parentId, {});
	expect(second.status).toBe(409);
	expect(await second.json()).toEqual({ error: "opencode_fork_busy" });
	expect(await getDb().select().from(opencodeForkRequests)).toHaveLength(1);
});

test("same actor + key + body replays; different body under the same key is 409", async () => {
	(config as Record<string, unknown>).opencodeForkEntry = true;
	const { parentId } = await seedManagedSession();
	const body = { idempotencyKey: "fork-key-0001", childDisplayName: "分支A" };
	const first = (await (await post(parentId, body)).json()) as { action: { id: string } };
	const replay = (await (await post(parentId, body)).json()) as { action: { id: string } };
	expect(replay.action.id).toBe(first.action.id);
	const conflict = await post(parentId, { ...body, childDisplayName: "分支B" });
	expect(conflict.status).toBe(409);
	expect(await conflict.json()).toEqual({ error: "opencode_fork_idempotency_conflict" });
});

test("different fork points are different requests (concurrent keys are independent)", async () => {
	(config as Record<string, unknown>).opencodeForkEntry = true;
	const { parentId } = await seedManagedSession();
	const [a, b] = await Promise.all([
		post(parentId, { idempotencyKey: "fork-key-aaaa", forkPointMessageId: "msg_one" }),
		post(parentId, { idempotencyKey: "fork-key-bbbb", forkPointMessageId: "msg_two" }),
	]);
	expect(a.status).toBe(202);
	expect(b.status).toBe(202);
	const ids = new Set([
		((await a.json()) as { action: { id: string } }).action.id,
		((await b.json()) as { action: { id: string } }).action.id,
	]);
	expect(ids.size).toBe(2);
	expect(await getDb().select().from(opencodeForkRequests)).toHaveLength(2);
});

test("the same key after completion still replays the original action", async () => {
	(config as Record<string, unknown>).opencodeForkEntry = true;
	const { parentId } = await seedManagedSession();
	const body = { idempotencyKey: "fork-key-cccc" };
	const first = (await (await post(parentId, body)).json()) as { action: { id: string } };
	await getDb()
		.update(controlActions)
		.set({ status: "succeeded" })
		.where(eq(controlActions.id, first.action.id));
	const again = (await (await post(parentId, body)).json()) as { action: { id: string } };
	expect(again.action.id).toBe(first.action.id);
});

test("a DIFFERENT actor with the same key gets its own action", async () => {
	(config as Record<string, unknown>).opencodeForkEntry = true;
	const { parentId } = await seedManagedSession();
	// Two service identities (no user id) share the '' owner scope in the unique
	// index, so use two real user ids to exercise the per-actor scope. The auth
	// context is not switchable in this harness, so the DB scope is asserted
	// directly: same key, two users → two rows (the index is actor-scoped).
	await getDb().insert(controlActions).values([
		{
			id: crypto.randomUUID(),
			sessionId: parentId,
			actionType: "opencode_fork",
			status: "queued",
			idempotencyKey: "fork-key-dddd",
			requestedByUserId: "user-a",
			metadata: {},
		},
		{
			id: crypto.randomUUID(),
			sessionId: parentId,
			actionType: "opencode_fork",
			status: "queued",
			idempotencyKey: "fork-key-dddd",
			requestedByUserId: "user-b",
			metadata: {},
		},
	]);
	expect(await getDb().select().from(controlActions)).toHaveLength(2);
});

test("invalid field types are 400 — never coerced into a full fork", async () => {
	(config as Record<string, unknown>).opencodeForkEntry = true;
	const { parentId } = await seedManagedSession();
	for (const body of [
		{ forkPointMessageId: 0 },
		{ forkPointMessageId: false },
		{ childDisplayName: 0 },
		{ idempotencyKey: "short" },
		{ idempotencyKey: "bad key with spaces" },
		{ unknownField: "x" },
	]) {
		const res = await post(parentId, body);
		expect(res.status).toBe(400);
	}
	expect(await getDb().select().from(controlActions)).toHaveLength(0);
});
