import "../db/__test_db.js";
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createHttpClient } from "../../../packages/agentpulse-mcp/src/client.js";
import { app } from "../app.js";
import { config } from "../config.js";
import { getDb, initializeDatabase } from "../db/client.js";
import {
	events,
	controlActions,
	launchRequests,
	managedSessions,
	providerInstances,
	sessionControlBindings,
	sessions,
	supervisors,
} from "../db/schema/index.js";
import { handleResumeIntent } from "./ask/ask-resume-handler.js";
import { handleSessionAction } from "./ask/ask-session-action-handler.js";
import { queuePromptAction, queueStopAction, retryLaunchForSession } from "./control-actions.js";
import { appendManagedSessionEvents, upsertManagedSessionState } from "./managed-session-state.js";
import {
	advanceOpenCodeGeneration,
	assertSessionControlOrigin,
	bindCreatedOpenCodeSession,
	inspectOpenCodeProvenance,
	recordExternalOpenCodeSession,
	reserveOpenCodeInstance,
} from "./opencode-control-provenance.js";
import { bindSession, queueApproval, queueResume } from "./session-binding.js";
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
	for (const id of ["p1-host", "p1-foreign"])
		await getDb()
			.insert(supervisors)
			.values({
				id,
				hostName: id,
				platform: "linux",
				arch: "x64",
				version: "test",
				status: "connected",
				trustedRoots: ["/tmp"],
				capabilities: {},
			});
});
async function external(id = "external") {
	await getDb()
		.insert(sessions)
		.values({
			sessionId: id,
			agentType: "opencode",
			cwd: "/tmp/p1",
			metadata: {
				manager: "agentpulse",
				origin: "agentpulse_launch",
				controlCapabilities: { send: true },
				opencode: { instanceId: "forged" },
			},
		});
	await recordExternalOpenCodeSession(id);
	return id;
}
async function claimed(id = "managed") {
	const [launch] = await getDb()
		.insert(launchRequests)
		.values({
			launchCorrelationId: id,
			agentType: "opencode",
			cwd: "/tmp/p1",
			requestedLaunchMode: "managed_opencode",
			claimedBySupervisorId: "p1-host",
			status: "launching",
		})
		.returning();
	return launch;
}
async function managedFixture() {
	const launch = await claimed();
	const instance = await reserveOpenCodeInstance("p1-host", launch.id);
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
	return { launch, instance };
}
test("metadata, legacy IDs, and admin authority cannot promote external origins", async () => {
	await external();
	expect((await inspectOpenCodeProvenance("external"))?.origin).toBe("external_observer");
	await expect(assertSessionControlOrigin("external", admin)).rejects.toThrow(
		"session_observe_only",
	);
	const launch = await claimed("external");
	await expect(reserveOpenCodeInstance("p1-host", launch.id)).rejects.toThrow(
		"session_observe_only",
	);
	await getDb()
		.update(sessions)
		.set({ agentType: "codex_cli" })
		.where(eq(sessions.sessionId, "external"));
	await expect(queueStopAction("external", admin)).rejects.toThrow("session_observe_only");
});
test("valid reservation verifies launch/native/owner; P1 still opens no controls", async () => {
	const { instance } = await managedFixture();
	expect((await inspectOpenCodeProvenance("managed"))?.bindingValid).toBe(true);
	await expect(assertSessionControlOrigin("managed", admin)).rejects.toThrow(
		"opencode_control_not_enabled",
	);
	await expect(
		bindCreatedOpenCodeSession("p1-foreign", instance.id, "ses_nativefixture", 1),
	).rejects.toThrow("provider_binding_invalid");
	await expect(
		bindCreatedOpenCodeSession("p1-host", instance.id, "ses_otherfixture", 1),
	).rejects.toThrow("session_observe_only");
	await advanceOpenCodeGeneration("p1-host", instance.id, 1);
	expect((await inspectOpenCodeProvenance("managed"))?.bindingValid).toBe(false);
	await expect(advanceOpenCodeGeneration("p1-host", instance.id, 1)).rejects.toThrow(
		"provider_binding_invalid",
	);
	await expect(
		bindCreatedOpenCodeSession("p1-host", instance.id, "ses_nativefixture", 1),
	).rejects.toThrow("provider_binding_invalid");
	await bindCreatedOpenCodeSession("p1-host", instance.id, "ses_nativefixture", 2);
	expect((await inspectOpenCodeProvenance("managed"))?.bindingValid).toBe(true);
});
test("external marker is immutable even with a forged managed row", async () => {
	await external();
	const launch = await claimed("external");
	await getDb().insert(managedSessions).values({
		sessionId: "external",
		launchRequestId: launch.id,
		supervisorId: "p1-host",
		providerSessionId: "ses_external",
		managedState: "managed",
	});
	for (const invoke of [
		() => bindSession("external", "p1-host", admin),
		() => queuePromptAction("external", "x", admin),
		() => queueStopAction("external", admin),
		() => queueApproval("external", "fake", "accept", admin),
		() => queueResume("external", admin),
		() => retryLaunchForSession("external", admin),
	])
		await expect(invoke()).rejects.toThrow("session_observe_only");
	expect(await getDb().select().from(controlActions)).toHaveLength(0);
});
test("REST all control routes reject external sessions before creating actions", async () => {
	await external();
	for (const suffix of [
		"bind",
		"prompt",
		"stop",
		"native-approvals/fake",
		"native-questions/fake/reply",
		"questions/fake/reply",
		"resume",
		"retry",
		"fork",
	]) {
		const response = await app.request(`/api/v1/sessions/external/${suffix}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				supervisorId: "p1-host",
				prompt: "x",
				decision: "accept",
				answers: [["x"]],
			}),
		});
		expect(response.status, suffix).toBe(403);
		expect(await response.json()).toEqual({ error: "session_observe_only" });
	}
	expect(await getDb().select().from(controlActions)).toHaveLength(0);
});
test("Ask cannot resume into a different agent or queue a stop for external sessions", async () => {
	await external();
	const resume = await handleResumeIntent({
		intent: { kind: "resume", sessionHint: null, newPrompt: "x", agentType: "claude_code" },
		origin: "web",
		threadId: "unused",
	});
	expect(resume.actionRequestId).toBeNull();
	expect(resume.replyText).toContain("observe-only");
	const stop = await handleSessionAction(
		{ action: "stop", sessionHint: null, noteText: null, newName: null },
		{ origin: "web", threadId: "unused", actor: admin },
	);
	expect(stop.actionRequestId).toBeNull();
	expect(stop.replyText).toContain("observe-only");
});
test("authenticated supervisor report cannot convert external sessions", async () => {
	await external();
	await expect(
		upsertManagedSessionState("p1-host", {
			sessionId: "external",
			agentType: "codex_cli",
			metadata: { manager: "agentpulse" },
		}),
	).rejects.toThrow("session_observe_only");
	await expect(appendManagedSessionEvents("p1-host", "external", [])).rejects.toThrow(
		"session_observe_only",
	);
	expect(await getDb().select().from(managedSessions)).toHaveLength(0);
});
test("MCP REST client receives the same refusal for prompt/stop/retry", async () => {
	await external();
	const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
	try {
		const client = createHttpClient({
			baseUrl: `http://127.0.0.1:${server.port}`,
			apiKey: "unused",
			fetchImpl: ((input, init) => app.fetch(new Request(input, init))) as typeof fetch,
		});
		await expect(client.promptSession("external", "x")).rejects.toMatchObject({
			status: 403,
			body: { error: "session_observe_only" },
		});
		await expect(client.stopSession("external")).rejects.toMatchObject({
			status: 403,
			body: { error: "session_observe_only" },
		});
		await expect(client.retryLaunch("external")).rejects.toMatchObject({
			status: 403,
			body: { error: "session_observe_only" },
		});
		expect(await getDb().select().from(controlActions)).toHaveLength(0);
	} finally {
		server.stop(true);
	}
});
