/**
 * Session STOP / RESUME state machine (fork design D): a durable stop marker,
 * queued deliveries cancelled, pending approvals invalidated, new work refused
 * until an explicit resume clears the marker.
 */
import "../db/__test_db.js";
import { beforeAll, beforeEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { getDb, initializeDatabase } from "../db/client.js";
import {
	controlActions,
	launchRequests,
	managedSessions,
	providerInstances,
	sessionControlBindings,
	sessions,
	supervisors,
} from "../db/schema/index.js";
import { reserveOpenCodeInstance } from "./opencode-control-provenance.js";
import { queueOpenCodeAction } from "./opencode-managed.js";

const actor = { label: "user", userId: "user-1" } as never;

beforeAll(() => initializeDatabase());
beforeEach(async () => {
	for (const table of [
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

async function seed() {
	await getDb().insert(supervisors).values({
		id: "stop-host",
		hostName: "stop-host",
		platform: "linux",
		arch: "x64",
		version: "t",
		status: "connected",
		trustedRoots: ["/tmp"],
		capabilities: {},
	});
	const parentId = "stop-parent";
	const [launch] = await getDb()
		.insert(launchRequests)
		.values({
			launchCorrelationId: parentId,
			agentType: "opencode",
			cwd: "/tmp",
			requestedLaunchMode: "managed_opencode",
			claimedBySupervisorId: "stop-host",
			status: "launching",
		})
		.returning();
	const instance = await reserveOpenCodeInstance("stop-host", launch.id);
	await getDb()
		.update(providerInstances)
		.set({ state: "running" })
		.where(eq(providerInstances.id, instance.id));
	await getDb().insert(sessions).values({ sessionId: parentId, agentType: "opencode", cwd: "/tmp" });
	await getDb().insert(managedSessions).values({
		sessionId: parentId,
		launchRequestId: launch.id,
		supervisorId: "stop-host",
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

test("stop writes a durable marker, cancels queued prompts and refuses new work", async () => {
	const { parentId } = await seed();
	await queueOpenCodeAction(parentId, "prompt", { prompt: "queued work" }, actor);
	await queueOpenCodeAction(parentId, "stop", {}, actor);
	const [row] = await getDb().select().from(sessions).where(eq(sessions.sessionId, parentId));
	expect((row?.metadata as Record<string, unknown>)?.controlStoppedAt).toBeString();
	const queued = await getDb()
		.select()
		.from(controlActions)
		.where(eq(controlActions.sessionId, parentId));
	const prompt = queued.find((action) => action.actionType === "prompt");
	expect(prompt?.status).toBe("failed");
	expect(prompt?.error).toBe("opencode_session_stopped");
	await expect(
		queueOpenCodeAction(parentId, "prompt", { prompt: "after stop" }, actor),
	).rejects.toThrow("opencode_session_stopped");
});

test("an explicit resume clears the marker and work is accepted again", async () => {
	const { parentId } = await seed();
	await queueOpenCodeAction(parentId, "stop", {}, actor);
	await queueOpenCodeAction(parentId, "opencode_resume", {}, actor);
	const [row] = await getDb().select().from(sessions).where(eq(sessions.sessionId, parentId));
	expect((row?.metadata as Record<string, unknown>)?.controlStoppedAt ?? null).toBeNull();
	const action = await queueOpenCodeAction(parentId, "prompt", { prompt: "back to work" }, actor);
	expect(action.actionType).toBe("prompt");
	expect(action.status).toBe("queued");
});

test("resume requires a running instance (a killed instance needs a relaunch)", async () => {
	const { parentId, instance } = await seed();
	await queueOpenCodeAction(parentId, "stop", {}, actor);
	await getDb()
		.update(providerInstances)
		.set({ state: "stopped" })
		.where(eq(providerInstances.id, instance.id));
	// The instance fence rejects work on a stopped generation; resuming a
	// killed instance requires a relaunch (open item).
	await expect(queueOpenCodeAction(parentId, "opencode_resume", {}, actor)).rejects.toThrow(
		"provider_binding_invalid",
	);
});
