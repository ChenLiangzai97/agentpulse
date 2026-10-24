import "../db/__test_db.js";
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { getDb, initializeDatabase } from "../db/client.js";
import {
	controlActions,
	events,
	launchRequests,
	managedSessions,
	providerInstances,
	providerInteractions,
	sessionControlBindings,
	sessions,
	supervisors,
} from "../db/schema/index.js";
import { config } from "../config.js";
import { processHookEvent, processStatusUpdate } from "./event-processor.js";
import { interruptOpenCodeInstance, queueOpenCodeAction } from "./opencode-managed.js";
import {
	bindCreatedOpenCodeSession,
	reserveOpenCodeInstance,
} from "./opencode-control-provenance.js";

const admin = { label: "user", userId: null, role: "admin", mode: "solo" } as const;
const oldDisableAuth = config.disableAuth;

beforeAll(async () => {
	await initializeDatabase();
	config.disableAuth = true;
});
afterAll(() => {
	config.disableAuth = oldDisableAuth;
});
beforeEach(async () => {
	for (const table of [
		providerInteractions,
		sessionControlBindings,
		providerInstances,
		controlActions,
		events,
		managedSessions,
		launchRequests,
		sessions,
		supervisors,
	])
		await getDb().delete(table);
	await getDb().insert(supervisors).values({
		id: "p1-host",
		hostName: "p1-host",
		platform: "linux",
		arch: "x64",
		version: "test",
		status: "connected",
		trustedRoots: ["/tmp"],
		capabilities: {},
	});
});

async function managedFixture() {
	const [launch] = await getDb()
		.insert(launchRequests)
		.values({
			launchCorrelationId: "managed",
			agentType: "opencode",
			cwd: "/tmp/p1",
			requestedLaunchMode: "managed_opencode",
			claimedBySupervisorId: "p1-host",
			status: "launching",
		})
		.returning();
	const instance = await reserveOpenCodeInstance("p1-host", launch.id);
	const [running] = await getDb()
		.update(providerInstances)
		.set({ state: "running" })
		.where(eq(providerInstances.id, instance.id))
		.returning();
	await getDb()
		.insert(sessions)
		.values({ sessionId: "managed", agentType: "opencode", cwd: "/tmp/p1" });
	await getDb().insert(managedSessions).values({
		sessionId: "managed",
		launchRequestId: launch.id,
		supervisorId: "p1-host",
		providerSessionId: "ses_nativefixture",
		managedState: "managed",
	});
	await bindCreatedOpenCodeSession("p1-host", instance.id, "ses_nativefixture", 1);
	return { launch, instance: running };
}

test("interrupt cancels queued prompts before delivery", async () => {
	const { instance } = await managedFixture();
	expect(instance.state).toBe("running");
	const p1 = await queueOpenCodeAction("managed", "prompt", { prompt: "first" }, admin);
	const p2 = await queueOpenCodeAction("managed", "prompt", { prompt: "second" }, admin);
	expect(p1.status).toBe("queued");
	await queueOpenCodeAction("managed", "interrupt", {}, admin);
	const rows = await getDb()
		.select()
		.from(controlActions)
		.where(and(eq(controlActions.sessionId, "managed"), eq(controlActions.actionType, "prompt")));
	expect(rows).toHaveLength(2);
	for (const row of rows) {
		expect(row.status).toBe("failed");
		expect(row.error).toBe("opencode_prompt_cancelled_before_delivery");
		expect(row.finishedAt).toBeTruthy();
	}
	const interruptRows = await getDb()
		.select()
		.from(controlActions)
		.where(
			and(eq(controlActions.sessionId, "managed"), eq(controlActions.actionType, "interrupt")),
		);
	expect(interruptRows).toHaveLength(1);
	expect(interruptRows[0].status).toBe("queued");
});

test("interrupt/stop invalidates instance state, interactions and in-flight actions", async () => {
	const { instance } = await managedFixture();
	const generation = instance.generation;
	const [action] = await getDb()
		.insert(controlActions)
		.values({
			sessionId: "managed",
			actionType: "prompt",
			status: "running",
			metadata: { prompt: "in flight" },
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		})
		.returning();
	const [interaction] = await getDb()
		.insert(providerInteractions)
		.values({
			id: "itx-1",
			sessionId: "managed",
			instanceId: instance.id,
			generation,
			nativeRequestId: "req-1",
			kind: "permission",
			revision: "r1",
			payload: { tool: "bash" },
			status: "pending",
			expiresAt: new Date(Date.now() + 60000).toISOString(),
		})
		.returning();
	await getDb()
		.update(managedSessions)
		.set({ activeControlActionId: action.id })
		.where(eq(managedSessions.sessionId, "managed"));

	await interruptOpenCodeInstance("p1-host", instance.id, generation, "stopped");

	const [after] = await getDb()
		.select()
		.from(providerInstances)
		.where(eq(providerInstances.id, instance.id));
	expect(after.state).toBe("stopped");
	expect(after.generation).toBe(generation + 1);
	const [managedAfter] = await getDb()
		.select()
		.from(managedSessions)
		.where(eq(managedSessions.sessionId, "managed"));
	expect(managedAfter.managedState).toBe("stopped");
	expect(managedAfter.activeControlActionId).toBeNull();
	expect(managedAfter.controlLockExpiresAt).toBeNull();
	const [actionAfter] = await getDb()
		.select()
		.from(controlActions)
		.where(eq(controlActions.id, action.id));
	expect(actionAfter.status).toBe("failed");
	expect(actionAfter.error).toBe("opencode_process_interrupted");
	const [interactionAfter] = await getDb()
		.select()
		.from(providerInteractions)
		.where(eq(providerInteractions.id, interaction.id));
	expect(interactionAfter.status).toBe("interrupted");

	// Idempotent replay with the pre-advance generation must not throw or double-advance.
	await interruptOpenCodeInstance("p1-host", instance.id, generation, "stopped");
	const [replay] = await getDb()
		.select()
		.from(providerInstances)
		.where(eq(providerInstances.id, instance.id));
	expect(replay.generation).toBe(generation + 1);
});

test("hook and status channels cannot write protected managed namespaces", async () => {
	await managedFixture();
	for (const sessionId of ["managed", "managed:opencode-child:sub1"]) {
		const result = await processHookEvent(
			{ session_id: sessionId, hook_event_name: "UserPromptSubmit", prompt: "hi" },
			"opencode",
		);
		expect(result.isNew).toBe(false);
		expect(result.session).toBeNull();
		expect(result.events).toHaveLength(0);
		const written = await getDb()
			.select()
			.from(events)
			.where(eq(events.sessionId, sessionId));
		expect(written).toHaveLength(0);
	}
	expect(
		await processStatusUpdate({
			session_id: "managed:opencode-child:sub1",
			status: "implementing",
		}),
	).toBe(false);
	const [session] = await getDb().select().from(sessions).where(eq(sessions.sessionId, "managed"));
	expect(session.semanticStatus).toBeNull();

	// Control: unprotected opencode sessions still ingest through hooks.
	const external = await processHookEvent(
		{ session_id: "opencode:other:ses_x", hook_event_name: "UserPromptSubmit", prompt: "hi" },
		"opencode",
	);
	expect(external.isNew).toBe(true);
	expect(external.events.length).toBeGreaterThan(0);
});
