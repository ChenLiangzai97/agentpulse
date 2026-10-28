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
	await assertSessionControlOrigin("managed", admin);
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

test("managed snapshot upserts parts and persistent interactions; priority actions remain available", async () => {
	const { instance } = await managedFixture();
	const {
		acceptOpenCodeSnapshot,
		listOpenCodeInteractions,
		queueOpenCodeAction,
		interruptOpenCodeInstance,
	} = await import("./opencode-managed.js");
	const { claimNextControlAction } = await import("./control-actions.js");
	const snapshot = {
		generation: 1,
		nativeSessionId: "ses_nativefixture",
		status: { type: "busy" },
		messages: [
			{
				info: {
					id: "msg_fixture",
					sessionID: "ses_nativefixture",
					role: "assistant",
					time: { created: 1700000000000 },
				},
				parts: [
					{
						id: "prt_fixture",
						sessionID: "ses_nativefixture",
						messageID: "msg_fixture",
						type: "tool",
						tool: "bash",
						callID: "call_fixture",
						state: { status: "running", input: { command: "printf fixture" } },
					},
				],
			},
		],
		permissions: [
			{
				id: "per_fixture",
				sessionID: "ses_nativefixture",
				permission: "bash",
				patterns: ["printf *"],
			},
		],
		questions: [],
	};
	await acceptOpenCodeSnapshot("p1-host", instance.id, snapshot);
	await acceptOpenCodeSnapshot("p1-host", instance.id, snapshot);
	expect(await getDb().select().from(events)).toHaveLength(1);
	snapshot.messages[0].parts[0].state = {
		...snapshot.messages[0].parts[0].state,
		status: "completed",
		...{ output: "fixture" },
	};
	await acceptOpenCodeSnapshot("p1-host", instance.id, snapshot);
	const [event] = await getDb().select().from(events);
	expect(event.eventType).toBe("PostToolUse");
	expect(event.toolResponse).toBe("fixture");
	const [interaction] = await listOpenCodeInteractions("managed");
	await expect(
		queueOpenCodeAction(
			"managed",
			"interaction_response",
			{ interactionId: interaction.id, revision: interaction.revision, decision: "always" },
			admin,
		),
	).rejects.toThrow("not_allowed");
	await queueOpenCodeAction("managed", "prompt", { prompt: "queued prompt" }, admin);
	const answer = await queueOpenCodeAction(
		"managed",
		"interaction_response",
		{ interactionId: interaction.id, revision: interaction.revision, decision: "once" },
		admin,
	);
	await expect(
		queueOpenCodeAction(
			"managed",
			"interaction_response",
			{ interactionId: interaction.id, revision: interaction.revision, decision: "once" },
			admin,
		),
	).rejects.toThrow("stale_or_answered");
	const claimedAnswer = await claimNextControlAction("p1-host");
	expect(claimedAnswer?.id).toBe(answer.id);
	// STOP drains running executions: finish the claimed answer first.
	const { updateControlAction } = await import("./control-actions.js");
	await updateControlAction({
		actionId: answer.id,
		supervisorId: "p1-host",
		status: "succeeded",
		claimToken: String((claimedAnswer?.metadata as Record<string, unknown>)?.claimToken ?? ""),
	});
	await queueOpenCodeAction("managed", "stop", {}, admin);
	const stopping = await claimNextControlAction("p1-host");
	expect(stopping?.actionType).toBe("stop");
	await interruptOpenCodeInstance("p1-host", instance.id, 1, "stopped");
	await acceptOpenCodeSnapshot("p1-host", instance.id, snapshot);
	await expect(queueOpenCodeAction("managed", "prompt", { prompt: "no" }, admin)).rejects.toThrow(
		"binding_invalid",
	);
});

test.skipIf(process.env.AGENTPULSE_OPENCODE_RUNTIME_TEST !== "1")(
	"real managed provider to server: bootstrap, tools, durable approval, stop",
	async () => {
		const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
		const { join } = await import("node:path");
		const { tmpdir } = await import("node:os");
		const { createManagedOpenCodeProvider } = await import(
			"../../supervisor/providers/opencode-managed.js"
		);
		const { mapLaunchRequest } = await import("./launch-validator.js");
		const { listOpenCodeInteractions, queueOpenCodeAction } = await import("./opencode-managed.js");
		const { claimNextControlAction, updateControlAction } = await import("./control-actions.js");
		const root = await mkdtemp(join(tmpdir(), "ap-managed-integration-"));
		const cwd = join(root, "project");
		await mkdir(cwd);
		const mock = Bun.spawn(["python3", "scripts/opencode-p0/mock_model.py"], {
			stdout: "pipe",
			stderr: "ignore",
		});
		const reader = mock.stdout.getReader();
		let line = "";
		while (!line.includes("\n")) {
			const r = await reader.read();
			if (r.done) throw new Error("mock exited");
			line += new TextDecoder().decode(r.value);
		}
		const profilePath = join(root, "profile.json");
		await writeFile(
			profilePath,
			JSON.stringify({
				model: "p0/fixture-model",
				provider: {
					p0: {
						npm: "@ai-sdk/openai-compatible",
						options: {
							baseURL: `http://127.0.0.1:${Number(line.trim())}/v1`,
							apiKey: "p0-fixture-key",
						},
						models: {
							"fixture-model": {
								name: "Fixture",
								tool_call: true,
								limit: { context: 32768, output: 2048 },
							},
						},
					},
				},
			}),
			{ mode: 0o600 },
		);
		const request = async (path: string, options?: RequestInit) => {
			const r = await app.request(`/api/v1${path}`, options);
			if (!r.ok) throw new Error(`server ${r.status}: ${await r.text()}`);
			return r.json();
		};
		const provider = createManagedOpenCodeProvider(
			{
				id: "p1-host",
				serverUrl: "http://localhost",
				hostName: "fixture",
				platform: "linux",
				arch: "x64",
				version: "test",
				trustedRoots: [root],
				capabilities: {
					version: 1,
					agentTypes: ["opencode"],
					launchModes: ["managed_opencode"],
					os: "linux",
					terminalSupport: [],
					features: ["managed_opencode"],
					executables: {
						opencode: {
							available: true,
							command: "opencode",
							resolvedPath: process.env.AGENTPULSE_OPENCODE_COMMAND ?? "opencode",
							source: "config",
						},
					},
				},
				opencodeProfilePath: profilePath,
			},
			root,
			{ request, verdict: () => "send" },
		);
		try {
			const row = await claimed("native-integration");
			await getDb()
				.update(launchRequests)
				.set({ cwd, taskPrompt: "P0_PERMISSION" })
				.where(eq(launchRequests.id, row.id));
			const [updated] = await getDb()
				.select()
				.from(launchRequests)
				.where(eq(launchRequests.id, row.id));
			const instance = await reserveOpenCodeInstance("p1-host", row.id);
			await provider.launch(
				{ ...mapLaunchRequest(updated), openCodeInstance: { id: instance.id, generation: 1 } },
				{
					reportState: (body) => upsertManagedSessionState("p1-host", body),
					reportEvents: async () => {
						throw new Error("unfenced events forbidden");
					},
				},
			);
			let interaction: Awaited<ReturnType<typeof listOpenCodeInteractions>>[number] | undefined;
			for (let i = 0; i < 60; i++) {
				await provider.poll();
				[interaction] = await listOpenCodeInteractions("native-integration");
				if (interaction) break;
				await Bun.sleep(100);
			}
			expect(interaction?.kind).toBe("permission");
			if (!interaction) throw new Error("no interaction");
			await queueOpenCodeAction(
				"native-integration",
				"interaction_response",
				{ interactionId: interaction.id, revision: interaction.revision, decision: "once" },
				admin,
			);
			const action = await claimNextControlAction("p1-host");
			if (!action) throw new Error("no action");
			await provider.control(action);
			await updateControlAction({
				actionId: action.id,
				supervisorId: "p1-host",
				status: "succeeded",
			});
			for (let i = 0; i < 60; i++) {
				await provider.poll();
				const rows = await getDb().select().from(events);
				if (rows.some((r) => r.content === "P0_DONE")) break;
				await Bun.sleep(100);
			}
			const before = await getDb().select().from(events);
			expect(before.some((r) => r.toolResponse?.includes("P0_PERMISSION_OUTPUT"))).toBe(true);
			expect(before.some((r) => r.content === "P0_DONE")).toBe(true);
			await provider.poll();
			expect(await getDb().select().from(events)).toHaveLength(before.length);
			const stop = await queueOpenCodeAction("native-integration", "stop", {}, admin);
			await provider.control({ ...stop, actionType: "stop", status: "queued" });
			expect((await inspectOpenCodeProvenance("native-integration"))?.bindingValid).toBe(false);
		} finally {
			await provider.close();
			mock.kill();
			await mock.exited;
			await rm(root, { recursive: true, force: true });
		}
	},
	120000,
);

test("verified native children stay separate and observe-only; unrelated native sessions are ignored", async () => {
	const { instance } = await managedFixture();
	const { acceptOpenCodeSnapshot } = await import("./opencode-managed.js");
	const child = {
		session: {
			id: "ses_childfixture",
			parentID: "ses_nativefixture",
			directory: "/tmp/p1",
			title: "Child fixture",
		},
		messages: [],
	};
	await acceptOpenCodeSnapshot("p1-host", instance.id, {
		generation: 1,
		nativeSessionId: "ses_nativefixture",
		status: { type: "idle" },
		messages: [],
		permissions: [],
		questions: [],
		children: [
			child,
			{
				session: {
					id: "ses_foreignfixture",
					parentID: "ses_otherroot",
					directory: "/tmp/p1",
					title: "Unrelated",
				},
				messages: [],
			},
		],
	});
	const rows = await getDb().select().from(sessions);
	expect(rows).toHaveLength(2);
	const imported = rows.find((row) => row.sessionId.includes(":opencode-child:"));
	expect(imported?.metadata?.opencode).toMatchObject({
		nativeParentId: "ses_nativefixture",
		parentSessionId: "managed",
		managedChildObservedOnly: true,
	});
	await expect(assertSessionControlOrigin(imported?.sessionId ?? "missing", admin)).rejects.toThrow(
		"session_observe_only",
	);
});

test("an older supervisor never claims a managed OpenCode launch", async () => {
	const { claimNextLaunchRequest } = await import("./launch-dispatch.js");
	const launch = await claimed("old-supervisor-launch");
	await getDb()
		.update(launchRequests)
		.set({ status: "validated", requestedSupervisorId: "p1-host", claimedBySupervisorId: null })
		.where(eq(launchRequests.id, launch.id));
	expect(await claimNextLaunchRequest("p1-host")).toBeNull();
	const [row] = await getDb().select().from(launchRequests).where(eq(launchRequests.id, launch.id));
	expect(row.status).toBe("validated");
});
