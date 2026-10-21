/**
 * PROTECTED stop gate (fork design D): the binding carries an epoch; STOP
 * increments it and moves active -> stopping; executable actions are refused
 * while stopping; the claim fence never hands out stale-epoch actions; the
 * result fence refuses stale successes and only a CURRENT stop success moves
 * stopping -> stopped. Resume is NOT implemented (no entry).
 */
import "../db/__test_db.js";
import { beforeAll, beforeEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { getDb, initializeDatabase } from "../db/client.js";
import {
	controlActions,
	events as eventsTable,
	launchRequests,
	managedSessions,
	providerInstances,
	providerInteractions as providerInteractionsTable,
	sessionControlBindings,
	sessions,
	supervisors,
} from "../db/schema/index.js";
import { config } from "../config.js";
import {
	assertExecutionPermit,
	claimNextControlAction,
	updateControlAction,
} from "./control-actions.js";
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

const bindingOf = async (sessionId: string) => {
	const [row] = await getDb()
		.select()
		.from(sessionControlBindings)
		.where(eq(sessionControlBindings.sessionId, sessionId));
	return row;
};

test("STOP increments the epoch, moves to stopping and cancels every queued executable action", async () => {
	const { parentId } = await seed();
	await queueOpenCodeAction(parentId, "prompt", { prompt: "queued work" }, actor);
	const stop = await queueOpenCodeAction(parentId, "stop", {}, actor);
	const binding = await bindingOf(parentId);
	expect(binding?.stopState).toBe("stopping");
	expect(binding?.stopEpoch).toBe(1);
	expect((stop.metadata as Record<string, unknown>).controlEpoch).toBe(1);
	const actions = await getDb()
		.select()
		.from(controlActions)
		.where(eq(controlActions.sessionId, parentId));
	expect(actions.find((a) => a.actionType === "prompt")?.status).toBe("failed");
	// While stopping, NO executable action can be queued (not just prompts).
	for (const kind of ["prompt", "opencode_command", "opencode_fork"] as const) {
		await expect(
			queueOpenCodeAction(
				parentId,
				kind,
				kind === "prompt" ? { prompt: "x" } : kind === "opencode_command" ? { command: "x" } : {},
				actor,
			),
		).rejects.toThrow("opencode_session_stopping");
	}
});

test("the CLAIM fence fails a stale-epoch action instead of executing it", async () => {
	const { parentId, instance } = await seed();
	await queueOpenCodeAction(parentId, "stop", {}, actor);
	// An action queued at the OLD epoch (e.g. a claim from before the stop).
	const [stale] = await getDb()
		.insert(controlActions)
		.values({
			id: crypto.randomUUID(),
			sessionId: parentId,
			actionType: "prompt",
			status: "queued",
			metadata: {
				agentType: "opencode",
				instanceId: instance.id,
				generation: 1,
				nativeSessionId: "ses_parent",
				controlEpoch: 0,
				prompt: "stale",
			},
			createdAt: new Date(Date.now() - 60_000).toISOString(),
			updatedAt: new Date().toISOString(),
		})
		.returning();
	// The STOP (current epoch) is claimable; the stale prompt is not.
	const claimed = await claimNextControlAction("stop-host");
	expect(claimed?.actionType).toBe("stop");
	expect(await claimNextControlAction("stop-host")).toBeNull();
	const [after] = await getDb().select().from(controlActions).where(eq(controlActions.id, stale.id));
	expect(after?.status).toBe("failed");
	expect(after?.error).toBe("opencode_session_stopped");
});

test("the RESULT fence refuses stale successes and only a current STOP success marks stopped", async () => {
	const { parentId } = await seed();
	const stop = await queueOpenCodeAction(parentId, "stop", {}, actor);
	await getDb()
		.update(controlActions)
		.set({ status: "running", claimedBySupervisorId: "stop-host" })
		.where(eq(controlActions.id, stop.id));
	// A stale stop (old epoch) reporting success must NOT transition to stopped.
	await getDb()
		.update(controlActions)
		.set({
			metadata: { ...(stop.metadata as Record<string, unknown>), controlEpoch: 0 },
		})
		.where(eq(controlActions.id, stop.id));
	const refused = await updateControlAction({
		actionId: stop.id,
		supervisorId: "stop-host",
		status: "succeeded",
	});
	expect(refused?.status).toBe("failed");
	expect(refused?.error).toBe("opencode_session_stopped");
	expect((await bindingOf(parentId))?.stopState).toBe("stopping");
	// The CURRENT stop success completes the transition.
	await getDb()
		.update(controlActions)
		.set({
			status: "running",
			metadata: { ...(stop.metadata as Record<string, unknown>), controlEpoch: 1 },
			claimedBySupervisorId: "stop-host",
		})
		.where(eq(controlActions.id, stop.id));
	const accepted = await updateControlAction({
		actionId: stop.id,
		supervisorId: "stop-host",
		status: "succeeded",
	});
	expect(accepted?.status).toBe("succeeded");
	expect((await bindingOf(parentId))?.stopState).toBe("stopped");
});

test("resume: entry-gated, only from a trusted STOPPED state, bumps the epoch", async () => {
	const { parentId, instance } = await seed();
	const original = config.opencodeResumeEntry;
	try {
		(config as Record<string, unknown>).opencodeResumeEntry = false;
		await expect(queueOpenCodeAction(parentId, "opencode_resume", {}, actor)).rejects.toThrow(
			"opencode_resume_entry_closed",
		);
		(config as Record<string, unknown>).opencodeResumeEntry = true;
		// While merely STOPPING the state is not trusted yet.
		await queueOpenCodeAction(parentId, "stop", {}, actor);
		await expect(queueOpenCodeAction(parentId, "opencode_resume", {}, actor)).rejects.toThrow(
			"opencode_resume_not_stopped",
		);
		// A confirmed stop state allows resume: active + NEW epoch.
		await getDb()
			.update(sessionControlBindings)
			.set({ stopState: "stopped", stopEpoch: 1 })
			.where(eq(sessionControlBindings.sessionId, parentId));
		const resume = await queueOpenCodeAction(parentId, "opencode_resume", {}, actor);
		expect((resume.metadata as Record<string, unknown>).controlEpoch).toBe(2);
		const binding = await bindingOf(parentId);
		expect(binding?.stopState).toBe("active");
		expect(binding?.stopEpoch).toBe(2);
		// A killed instance cannot be resumed without a relaunch.
		await getDb()
			.update(sessionControlBindings)
			.set({ stopState: "stopped", stopEpoch: 2 })
			.where(eq(sessionControlBindings.sessionId, parentId));
		await getDb()
			.update(providerInstances)
			.set({ state: "stopped" })
			.where(eq(providerInstances.id, instance.id));
		await expect(queueOpenCodeAction(parentId, "opencode_resume", {}, actor)).rejects.toThrow(
			"provider_binding_invalid",
		);
	} finally {
		(config as Record<string, unknown>).opencodeResumeEntry = original;
	}
});

test("EXECUTION permit: claim -> STOP -> permit is refused (deterministic interleaving)", async () => {
	const { parentId } = await seed();
	await queueOpenCodeAction(parentId, "prompt", { prompt: "claimed then stopped" }, actor);
	const claimed = await claimNextControlAction("stop-host");
	expect(claimed?.actionType).toBe("prompt");
	const claimToken = String((claimed?.metadata as Record<string, unknown>).claimToken ?? "");
	// Before the stop the supervisor may execute.
	await expect(
		assertExecutionPermit({ actionId: claimed?.id ?? "", supervisorId: "stop-host", claimToken }),
	).resolves.toBeTruthy();
	// STOP lands AFTER the claim but BEFORE native execution.
	await queueOpenCodeAction(parentId, "stop", {}, actor);
	await expect(
		assertExecutionPermit({ actionId: claimed?.id ?? "", supervisorId: "stop-host", claimToken }),
	).rejects.toThrow("opencode_session_stopped");
});

test("a managed action WITHOUT controlEpoch is isolated at claim time, never executed", async () => {
	const { parentId, instance } = await seed();
	const [legacy] = await getDb()
		.insert(controlActions)
		.values({
			id: crypto.randomUUID(),
			sessionId: parentId,
			actionType: "prompt",
			status: "queued",
			metadata: {
				agentType: "opencode",
				instanceId: instance.id,
				generation: 1,
				nativeSessionId: "ses_parent",
				prompt: "legacy",
			},
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		})
		.returning();
	expect(await claimNextControlAction("stop-host")).toBeNull();
	const [after] = await getDb().select().from(controlActions).where(eq(controlActions.id, legacy.id));
	expect(after?.status).toBe("failed");
	expect(after?.error).toBe("opencode_session_stopped");
});

test("an EXPIRED interaction is never resurrected as pending by a later snapshot", async () => {
	const { parentId, instance } = await seed();
	const { acceptOpenCodeSnapshot } = await import("./opencode-managed.js");
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
		.from(providerInteractionsTable)
		.where(eq(providerInteractionsTable.sessionId, parentId));
	expect(pending?.status).toBe("pending");
	await queueOpenCodeAction(parentId, "stop", {}, actor);
	const [expired] = await getDb()
		.select()
		.from(providerInteractionsTable)
		.where(eq(providerInteractionsTable.sessionId, parentId));
	expect(expired?.status).toBe("expired");
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
		.from(providerInteractionsTable)
		.where(eq(providerInteractionsTable.sessionId, parentId));
	expect(after?.status).toBe("expired");
});
