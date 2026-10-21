/**
 * STOP cancellation semantics that ARE safe today: queued prompt deliveries are
 * cancelled and pending approvals expire. The PROTECTED stop/resume epoch that
 * must fence every executable action, claim and result is NOT implemented yet —
 * no marker is written and no resume entry is exposed, so these tests assert
 * only the monotonic cancellation, never a "stopped" state.
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
import { events as eventsTable, providerInteractions as providerInteractionsTable } from "../db/schema/index.js";
import { reserveOpenCodeInstance } from "./opencode-control-provenance.js";
import { queueOpenCodeAction } from "./opencode-managed.js";

const actor = { label: "user", userId: "user-1" } as never;

beforeAll(() => initializeDatabase());
beforeEach(async () => {
	for (const table of [
		providerInteractionsTable,
		eventsTable,
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

test("stop cancels queued prompt deliveries (monotonic, no state claim)", async () => {
	const { parentId } = await seed();
	await queueOpenCodeAction(parentId, "prompt", { prompt: "queued work" }, actor);
	await queueOpenCodeAction(parentId, "stop", {}, actor);
	const actions = await getDb()
		.select()
		.from(controlActions)
		.where(eq(controlActions.sessionId, parentId));
	const prompt = actions.find((action) => action.actionType === "prompt");
	expect(prompt?.status).toBe("failed");
	expect(prompt?.error).toBe("opencode_session_stopped");
	// NO protected stopped state is claimed: new work is NOT silently gated by
	// an unverified marker.
	const [row] = await getDb().select().from(sessions).where(eq(sessions.sessionId, parentId));
	expect((row?.metadata as Record<string, unknown>)?.controlStoppedAt ?? null).toBeNull();
});

test("an EXPIRED interaction is never resurrected as pending by a later snapshot", async () => {
	const { parentId, instance } = await seed();
	const { acceptOpenCodeSnapshot } = await import("./opencode-managed.js");
	const { providerInteractions } = await import("../db/schema/index.js");
	const permission = { id: "per_1", sessionID: "ses_parent", type: "permission" };
	await acceptOpenCodeSnapshot("stop-host", instance.id, {
		generation: 1,
		nativeSessionId: "ses_parent",
		messages: [],
		permissions: [permission],
		questions: [],
		status: { type: "busy" },
	});
	const [pending] = await getDb()
		.select()
		.from(providerInteractions)
		.where(eq(providerInteractions.sessionId, parentId));
	expect(pending?.status).toBe("pending");
	// STOP expires it (monotonic side effect)...
	await queueOpenCodeAction(parentId, "stop", {}, actor);
	const [expired] = await getDb()
		.select()
		.from(providerInteractions)
		.where(eq(providerInteractions.sessionId, parentId));
	expect(expired?.status).toBe("expired");
	// ...and a LATER snapshot re-listing the same native request cannot re-open it.
	await acceptOpenCodeSnapshot("stop-host", instance.id, {
		generation: 1,
		nativeSessionId: "ses_parent",
		messages: [],
		permissions: [permission],
		questions: [],
		status: { type: "busy" },
	});
	const [after] = await getDb()
		.select()
		.from(providerInteractions)
		.where(eq(providerInteractions.sessionId, parentId));
	expect(after?.status).toBe("expired");
});
