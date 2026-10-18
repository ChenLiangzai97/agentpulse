/** Disposable browser fixture: real isolated CLI + fake loopback model + fresh temporary AgentPulse DB. */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
if (process.env.AGENTPULSE_OPENCODE_ACCEPTANCE_FIXTURE !== "1")
	throw new Error("Set AGENTPULSE_OPENCODE_ACCEPTANCE_FIXTURE=1 to create disposable test data");
const root = await mkdtemp(join(tmpdir(), "agentpulse-opencode-browser-"));
process.env.SQLITE_PATH = join(root, "agentpulse.db");
delete process.env.DATABASE_URL;
process.env.DISABLE_AUTH = "true";
process.env.NODE_ENV = "production";
process.env.AGENTPULSE_AI_ENABLED = "false";
process.env.AGENTPULSE_OPENCODE_OBSERVER = "off";
const { app } = await import("../../src/server/app.js");
const { initializeDatabase, getDb } = await import("../../src/server/db/client.js");
const { sessions, supervisors, launchRequests } = await import(
	"../../src/server/db/schema/index.js"
);
const { reserveOpenCodeInstance, recordExternalOpenCodeSession } = await import(
	"../../src/server/services/opencode-control-provenance.js"
);
const { upsertManagedSessionState } = await import(
	"../../src/server/services/managed-session-state.js"
);
const { createManagedOpenCodeProvider } = await import(
	"../../src/supervisor/providers/opencode-managed.js"
);
const { claimNextControlAction, updateControlAction } = await import(
	"../../src/server/services/control-actions.js"
);
const { mapLaunchRequest } = await import("../../src/server/services/launch-validator.js");
await initializeDatabase();
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
const cwd = join(root, "project");
await mkdir(cwd);
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
const { handleServerRequest } = await import("../../src/server/server-fetch.js");
const { handleWsOpen, handleWsMessage, handleWsClose, initWsBroadcaster } = await import(
	"../../src/server/ws/handler.js"
);
const { sessionBus } = await import("../../src/server/services/notifier.js");
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch: handleServerRequest,
	websocket: { open: handleWsOpen, message: handleWsMessage, close: handleWsClose },
});
initWsBroadcaster(sessionBus);
const request = async (path: string, options?: RequestInit) => {
	const response = await app.request(`/api/v1${path}`, options);
	if (!response.ok)
		throw Object.assign(new Error(`fixture_http_${response.status}`), { status: response.status });
	return response.json();
};
const provider = createManagedOpenCodeProvider(
	{
		id: "fixture-host",
		serverUrl: server.url.origin,
		hostName: "Acceptance fixture",
		platform: "linux",
		arch: "x64",
		version: "fixture",
		trustedRoots: [root],
		opencodeProfilePath: profilePath,
		capabilities: {
			version: 1,
			os: "linux",
			agentTypes: ["opencode"],
			launchModes: ["managed_opencode"],
			terminalSupport: [],
			features: ["managed_opencode"],
			executables: {
				opencode: {
					available: true,
					command: "opencode",
					resolvedPath: process.env.AGENTPULSE_OPENCODE_COMMAND ?? "opencode",
					source: "config",
					binaryVersion: "1.18.35",
				},
				opencodeProfile: {
					configured: true,
					health: "ready",
					maxInstances: 2,
					maxQueuedLaunches: 4,
					idleTimeoutMs: 1800000,
					stopGraceMs: 5000,
				},
			},
		},
	},
	root,
	{ request, verdict: () => "send" },
);
await getDb()
	.insert(supervisors)
	.values({
		id: "fixture-host",
		hostName: "Acceptance fixture",
		platform: "linux",
		arch: "x64",
		version: "fixture",
		status: "connected",
		trustedRoots: [root],
		// Lease in the future (refreshed below) so mapSupervisor derives
		// "connected" — the new-session dialog only lists connected hosts.
		heartbeatLeaseExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
		// Mirrors the provider config above so the new-session dialog can
		// offer OpenCode launches against this fixture host.
		capabilities: {
			version: 1,
			os: "linux",
			agentTypes: ["opencode"],
			launchModes: ["managed_opencode"],
			terminalSupport: [],
			features: ["managed_opencode"],
			executables: {
				opencode: {
					available: true,
					command: "opencode",
					resolvedPath: "opencode",
					source: "config",
					binaryVersion: "1.18.35",
				},
			},
		},
	});
const sessionId = crypto.randomUUID();
const [row] = await getDb()
	.insert(launchRequests)
	.values({
		launchCorrelationId: sessionId,
		agentType: "opencode",
		cwd,
		requestedLaunchMode: "managed_opencode",
		claimedBySupervisorId: "fixture-host",
		status: "launching",
		taskPrompt: "P0_HELLO",
		desiredDisplayName: "OpenCode managed acceptance",
	})
	.returning();
const instance = await reserveOpenCodeInstance("fixture-host", row.id);
await provider.launch(
	{
		...mapLaunchRequest(row),
		openCodeInstance: { id: instance.id, generation: instance.generation },
	},
	{
		reportState: (input) => upsertManagedSessionState("fixture-host", input),
		reportEvents: async () => {
			throw new Error("unfenced event path");
		},
	},
);
// Second managed session (B) for A/B draft-isolation evidence: launched the
// same direct way as the first, so browser tests need no dialog round-trip.
const sessionIdB = crypto.randomUUID();
const [rowB] = await getDb()
	.insert(launchRequests)
	.values({
		launchCorrelationId: sessionIdB,
		agentType: "opencode",
		cwd,
		requestedLaunchMode: "managed_opencode",
		claimedBySupervisorId: "fixture-host",
		status: "launching",
		taskPrompt: "P0_HELLO_B",
		desiredDisplayName: "OpenCode managed B",
	})
	.returning();
const instanceB = await reserveOpenCodeInstance("fixture-host", rowB.id);
await provider.launch(
	{
		...mapLaunchRequest(rowB),
		openCodeInstance: { id: instanceB.id, generation: instanceB.generation },
	},
	{
		reportState: (input) => upsertManagedSessionState("fixture-host", input),
		reportEvents: async () => {
			throw new Error("unfenced event path");
		},
	},
);
await getDb()
	.insert(sessions)
	.values({
		sessionId: "external-browser-fixture",
		agentType: "opencode",
		cwd,
		displayName: "External observe-only fixture",
		metadata: { origin: "agentpulse_launch", controlCapabilities: { send: true } },
	});
await recordExternalOpenCodeSession("external-browser-fixture");
const leaseTimer = setInterval(
	() =>
		void getDb()
			.update(supervisors)
			.set({ heartbeatLeaseExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString() })
			.where(eq(supervisors.id, "fixture-host"))
			.catch(() => {}),
	60_000,
);
const timer = setInterval(
	() =>
		void (async () => {
			const action = await claimNextControlAction("fixture-host");
			if (!action) return;
			try {
				await provider.control(action);
				await updateControlAction({
					actionId: action.id,
					supervisorId: "fixture-host",
					status: "succeeded",
				});
			} catch (error) {
				await updateControlAction({
					actionId: action.id,
					supervisorId: "fixture-host",
					status: "failed",
					error: error instanceof Error ? error.message : "fixture_action_failed",
				});
			}
		})().catch(() => {}),
	250,
);
const state = {
	root,
	url: server.url.origin,
	managedUrl: `${server.url.origin}/sessions/${sessionId}`,
	managedUrlB: `${server.url.origin}/sessions/${sessionIdB}`,
	externalUrl: `${server.url.origin}/sessions/external-browser-fixture`,
	sessionId,
	instanceId: instance.id,
};
await writeFile(join(root, "fixture.json"), JSON.stringify(state), { mode: 0o600 });
console.log(JSON.stringify(state));
let closing = false;
async function close() {
	if (closing) return;
	closing = true;
	clearInterval(timer);
	clearInterval(leaseTimer);
	await provider.close();
	mock.kill();
	await mock.exited;
	server.stop(true);
	await rm(root, { recursive: true, force: true });
	process.exit(0);
}
process.on("SIGTERM", () => void close());
process.on("SIGINT", () => void close());
