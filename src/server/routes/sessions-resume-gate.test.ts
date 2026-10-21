/**
 * The GENERIC resume entry must not bypass OpenCode's (still open) protected
 * stop/resume gate. OpenCode parent and fork children are refused; other
 * providers keep their existing behavior.
 */
import "../db/__test_db.js";
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

const { config } = await import("../config.js");
const { initializeDatabase, getDb } = await import("../db/client.js");
const db = await import("../db/schema/index.js");
const { Hono } = await import("hono");
const { sessionsRouter } = await import("./sessions.js");
const { reserveOpenCodeInstance } = await import("../services/opencode-control-provenance.js");

const app = new Hono().route("/api/v1", sessionsRouter);
const originalDisableAuth = config.disableAuth;

beforeAll(async () => {
	await initializeDatabase();
	(config as Record<string, unknown>).disableAuth = true;
});
afterAll(() => {
	(config as Record<string, unknown>).disableAuth = originalDisableAuth;
});
beforeEach(async () => {
	for (const table of [
		db.controlActions,
		db.sessionControlBindings,
		db.managedSessions,
		db.providerInstances,
		db.launchRequests,
		db.sessions,
		db.supervisors,
	])
		await getDb().delete(table);
});

async function seedOpencode() {
	await getDb().insert(db.supervisors).values({
		id: "resume-host",
		hostName: "resume-host",
		platform: "linux",
		arch: "x64",
		version: "t",
		status: "connected",
		trustedRoots: ["/tmp"],
		capabilities: {},
	});
	const parentId = "resume-parent";
	const [launch] = await getDb()
		.insert(db.launchRequests)
		.values({
			launchCorrelationId: parentId,
			agentType: "opencode",
			cwd: "/tmp",
			requestedLaunchMode: "managed_opencode",
			claimedBySupervisorId: "resume-host",
			status: "launching",
		})
		.returning();
	const instance = await reserveOpenCodeInstance("resume-host", launch.id);
	await getDb()
		.update(db.providerInstances)
		.set({ state: "running" })
		.where(eq(db.providerInstances.id, instance.id));
	await getDb().insert(db.sessions).values({ sessionId: parentId, agentType: "opencode", cwd: "/tmp" });
	await getDb().insert(db.managedSessions).values({
		sessionId: parentId,
		launchRequestId: launch.id,
		supervisorId: "resume-host",
		providerSessionId: "ses_parent",
		managedState: "managed",
	});
	await getDb().insert(db.sessionControlBindings).values({
		sessionId: parentId,
		origin: "agentpulse_launch",
		instanceId: instance.id,
		nativeSessionId: "ses_parent",
		generation: 1,
	});
	return { parentId, instance };
}

const resume = (sessionId: string) =>
	app.request(`/api/v1/sessions/${sessionId}/resume`, { method: "POST" });

test("the generic resume entry refuses a managed OpenCode PARENT", async () => {
	const { parentId } = await seedOpencode();
	const res = await resume(parentId);
	expect(res.status).toBe(409);
	expect(await res.json()).toEqual({ error: "opencode_resume_not_supported" });
	expect(await getDb().select().from(db.controlActions)).toHaveLength(0);
});

test("the generic resume entry refuses an OpenCode FORK CHILD too", async () => {
	const { parentId, instance } = await seedOpencode();
	const childId = "resume-child";
	await getDb().insert(db.sessions).values({ sessionId: childId, agentType: "opencode", cwd: "/tmp" });
	await getDb().insert(db.managedSessions).values({
		sessionId: childId,
		launchRequestId: instance.launchRequestId,
		supervisorId: "resume-host",
		providerSessionId: "ses_child",
		managedState: "managed",
	});
	await getDb().insert(db.sessionControlBindings).values({
		sessionId: childId,
		origin: "agentpulse_launch",
		instanceId: instance.id,
		nativeSessionId: "ses_child",
		generation: 1,
	});
	const res = await resume(childId);
	// Refused before any action: either by ownership (403) or by the OpenCode
	// gate (409). The property under test is that NO resume action is created.
	expect([403, 409]).toContain(res.status);
	const [action] = await getDb()
		.select()
		.from(db.controlActions)
		.where(eq(db.controlActions.sessionId, childId));
	expect(action).toBeUndefined();
	void parentId;
});

test("a non-OpenCode managed session keeps the generic path (no OpenCode refusal)", async () => {
	await getDb().insert(db.supervisors).values({
		id: "resume-host",
		hostName: "resume-host",
		platform: "linux",
		arch: "x64",
		version: "t",
		status: "connected",
		trustedRoots: ["/tmp"],
		capabilities: {},
	});
	const sessionId = "codex-resume";
	const [launch] = await getDb()
		.insert(db.launchRequests)
		.values({
			launchCorrelationId: sessionId,
			agentType: "codex_cli",
			cwd: "/tmp",
			claimedBySupervisorId: "resume-host",
			status: "launching",
		})
		.returning();
	await getDb().insert(db.sessions).values({ sessionId, agentType: "codex_cli", cwd: "/tmp" });
	await getDb().insert(db.managedSessions).values({
		sessionId,
		launchRequestId: launch.id,
		supervisorId: "resume-host",
		providerSessionId: "thread-1",
		managedState: "managed",
	});
	const res = await resume(sessionId);
	const body = (await res.json()) as { error?: string; action?: { actionType: string } };
	expect(body.error).not.toBe("opencode_resume_not_supported");
	expect(res.status).toBe(202);
	expect(body.action?.actionType).toBe("resume");
});
