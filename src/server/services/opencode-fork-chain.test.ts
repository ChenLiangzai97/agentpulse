/**
 * CHAIN INTEGRATION (opt-in, REAL opencode CLI): native fork -> REAL claim ->
 * authenticated result -> finalize transaction -> REAL managed snapshot
 * ingestion (acceptOpenCodeSnapshot/normalizer) -> copyOf -> work-log dedupe.
 *
 * Still NOT a full production acceptance: requests are in-process (app.request,
 * no supervisor transport), the legacy observer is deliberately not involved
 * (managed sessions use snapshots), and the report day is pinned deterministically
 * AFTER asserting that ingestion preserved the native creation times.
 */
import "../db/__test_db.js";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";

const { config } = await import("../config.js");
const { initializeDatabase, getDb } = await import("../db/client.js");
const db = await import("../db/schema/index.js");
const { Hono } = await import("hono");
const { supervisorsAgentRouter } = await import("../routes/supervisors.js");
const { sessionsRouter } = await import("../routes/sessions.js");
const { reserveOpenCodeInstance } = await import("./opencode-control-provenance.js");
const { createProvider } = await import("./ai/providers-service.js");
const { upsertSetting } = await import("./settings-service.js");
const { getWorklogIncluded, getWorklogRun, localDate, runWorklog, saveWorklogConfig } =
	await import("./worklog-service.js");
const { OpenCodeRuntimePool } = await import("../../supervisor/providers/opencode-runtime.js");
type Runtime = import("../../supervisor/providers/opencode-runtime.js").OpenCodeRuntime;
const { loadCopiedEvents } = await import("./worklog-copy.js");
const { claimNextControlAction } = await import("./control-actions.js");

const supervisorApp = new Hono().route("/api/v1", supervisorsAgentRouter);
const sessionsApp = new Hono().route("/api/v1", sessionsRouter);
const originalDisableAuth = config.disableAuth;
const originalEntry = config.opencodeForkEntry;
let modelInputs: string[] = [];

const stub = Bun.serve({
	port: 0,
	async fetch(req) {
		if (new URL(req.url).pathname === "/document") return new Response("{}", { status: 200 });
		const body = (await req.json()) as { messages: Array<{ role: string; content: string }> };
		if (!Array.isArray(body?.messages)) return new Response("{}", { status: 200 });
		modelInputs.push(body.messages.map((m) => m.content).join("\n"));
		const user = body.messages.map((m) => m.content).join("\n");
		const facts = [...user.matchAll(/\[#(\d+)\] (prompt|assistant_message|tool_event): ([^\n]*)/g)].map(
			(m) => ({
				category: m[2] === "assistant_message" ? "agent_claim" : "user_goal",
				text: `fact: ${m[3].slice(0, 60)}`,
				evidenceEventId: Number(m[1]),
			}),
		);
		return Response.json({
			choices: [{ message: { content: JSON.stringify({ facts }), finish_reason: "stop" } }],
			usage: { prompt_tokens: 100, completion_tokens: 30 },
		});
	},
});

beforeAll(async () => {
	await initializeDatabase();
	(config as Record<string, unknown>).disableAuth = true;
	(config as Record<string, unknown>).opencodeForkEntry = true;
	await upsertSetting("ai.enabled", true, { allowProtected: true });
	await upsertSetting("ai.killSwitch", false, { allowProtected: true });
	const provider = await createProvider({
		name: "fork-chain",
		kind: "openai_compatible",
		apiKey: "test-key",
		model: "local-model",
		baseUrl: `http://127.0.0.1:${stub.port}/v1`,
	});
	await saveWorklogConfig({
		enabled: false,
		timezone: "Asia/Shanghai",
		time: "00:05",
		providerId: provider.id,
		model: "local-model",
		documentUrl: `http://127.0.0.1:${stub.port}/document`,
		documentId: "daily-log",
	});
});

afterAll(() => {
	stub.stop(true);
	(config as Record<string, unknown>).disableAuth = originalDisableAuth;
	(config as Record<string, unknown>).opencodeForkEntry = originalEntry;
});

const waitTurn = async (runtime: Runtime) => {
	for (let i = 0; i < 160; i++) {
		const snapshot = await runtime.snapshot();
		const assistants = (snapshot.messages as { info?: Record<string, unknown> }[]).filter(
			(message) => message.info?.role === "assistant",
		);
		const last = assistants.at(-1)?.info as
			| { time?: { completed?: unknown }; finish?: unknown }
			| undefined;
		if (
			(snapshot.status as { type?: string })?.type !== "busy" &&
			last?.time?.completed &&
			last?.finish !== "tool-calls"
		)
			return;
		await Bun.sleep(150);
	}
	throw new Error("turn timeout");
};

const dbTime = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);

test.skipIf(process.env.AGENTPULSE_OPENCODE_RUNTIME_TEST !== "1")(
	"native fork -> authenticated finalize -> ingestion -> copyOf -> daily report",
	async () => {
		const root = await mkdtemp(join(tmpdir(), "ap-chain-"));
		const mock = Bun.spawn(["python3", "scripts/opencode-p0/mock_model.py"], {
			stdout: "pipe",
			stderr: "ignore",
		});
		const reader = mock.stdout.getReader();
		let line = "";
		while (!line.includes("\n")) {
			const next = await reader.read();
			if (next.done) throw new Error("mock exited");
			line += new TextDecoder().decode(next.value);
		}
		const port = Number(line.trim());
		const profilePath = join(root, "profile.json");
		await writeFile(
			profilePath,
			JSON.stringify({
				model: "p0/fixture-model",
				provider: {
					p0: {
						npm: "@ai-sdk/openai-compatible",
						options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "p0-fixture-key" },
						models: {
							"fixture-model": { name: "Fixture", tool_call: true, limit: { context: 32768, output: 2048 } },
						},
					},
				},
			}),
			{ mode: 0o600 },
		);
		const cwd = join(root, "project");
		await mkdir(cwd);
		// Seed the instance BEFORE starting the runtime: the provider starts a
		// runtime FOR a DB instance id, so identity must be the DB id.
		await getDb().insert(db.supervisors).values({
			id: "chain-host",
			hostName: "chain-host",
			platform: "linux",
			arch: "x64",
			version: "t",
			status: "connected",
			trustedRoots: ["/tmp"],
			capabilities: {},
		});
		const parentId = "chain-parent";
		const [launch] = await getDb()
			.insert(db.launchRequests)
			.values({
				launchCorrelationId: parentId,
				agentType: "opencode",
				cwd,
				requestedLaunchMode: "managed_opencode",
				claimedBySupervisorId: "chain-host",
				status: "launching",
			})
			.returning();
		const instance = await reserveOpenCodeInstance("chain-host", launch.id);
		await getDb()
			.update(db.providerInstances)
			.set({ state: "running" })
			.where(eq(db.providerInstances.id, instance.id));
		const runtimePool = new OpenCodeRuntimePool({
			executable: process.env.AGENTPULSE_OPENCODE_COMMAND || "opencode",
			profilePath,
			stateDirectory: join(root, "instances"),
			maxInstances: 1,
			idleTimeoutMs: 60000,
			stopGraceMs: 1000,
		});
		const runtime = await runtimePool.start({
			instanceId: instance.id,
			generation: 1,
			sessionId: parentId,
			cwd,
			title: "chain parent",
		});
		try {
			await getDb().insert(db.sessions).values({ sessionId: parentId, agentType: "opencode", cwd });
			await getDb().insert(db.managedSessions).values({
				sessionId: parentId,
				launchRequestId: launch.id,
				supervisorId: "chain-host",
				providerSessionId: runtime.nativeSessionId,
				managedState: "managed",
			});
			await getDb().insert(db.sessionControlBindings).values({
				sessionId: parentId,
				origin: "agentpulse_launch",
				instanceId: instance.id,
				nativeSessionId: runtime.nativeSessionId,
				generation: 1,
			});
			// Parent history: one completed turn.
			await runtime.prompt("P0_HELLO");
			await waitTurn(runtime);
			await runtime.snapshot();
			// Accept a fork request through the REAL route, then simulate the
			// claim step (mint of the token is covered by its own test).
			const accepted = await sessionsApp.request(`/api/v1/sessions/${parentId}/fork`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ idempotencyKey: "chain-fork-0001", childDisplayName: "链式分支" }),
			});
			expect(accepted.status).toBe(202);
			const actionId = ((await accepted.json()) as { action: { id: string } }).action.id;
			// REAL claim: the token is minted by the server's claim path.
			const claimed = await claimNextControlAction("chain-host");
			expect(claimed?.id).toBe(actionId);
			const claimToken = String((claimed?.metadata as Record<string, unknown>).claimToken ?? "");
			expect(claimToken.length).toBeGreaterThan(0);

			// Native fork with the copyOf point = the parent's first message.
			const parentMessages = await runtime.request<
				{ info: { id: string; role: string; time?: { created?: number } }; parts: unknown[] }[]
			>(`/session/${encodeURIComponent(runtime.nativeSessionId)}/message`);
			expect(parentMessages.length).toBeGreaterThan(0);
			const snapshot = await runtime.captureForkSnapshot(null);
			const child = await runtime.forkSession(undefined, {});
			const childMap = await runtime.captureChildMap(child.id, snapshot);
			// The native timestamps are "now" (today is incomplete). Pin the
			// ledger's occurrence times into the completed report day so the test
			// exercises the same-day dedupe path.
			const reportDay = localDate(new Date(Date.now() - 24 * 3_600_000), "Asia/Shanghai");
			const reportWindow = (await import("./worklog-service.js")).dayWindow(
				reportDay,
				"Asia/Shanghai",
			);
			const reportAt = dbTime(new Date(reportWindow.start).getTime() + 6 * 3_600_000);
			for (const pair of childMap.pairs) {
				pair.parentOccurredAt = reportAt;
				for (const part of pair.parts) part.parentOccurredAt = reportAt;
			}
			const report = await supervisorApp.request(
				`/api/v1/supervisors/chain-host/control-actions/${actionId}/fork-result`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						claimToken,
						childNativeSessionId: child.id,
						parentSnapshot: snapshot,
						childMap,
					}),
				},
			);
			if (report.status !== 200)
				console.error("[chain-report]", report.status, await report.clone().text());
			expect(report.status).toBe(200);
			const finalized = (await report.json()) as { childSessionId: string; replayed: boolean };
			expect(finalized.replayed).toBe(false);

			// REAL MANAGED INGESTION: the supervisor snapshot route normalizes the
			// native messages. The legacy observer is NOT involved.
			const sendSnapshot = async (nativeSessionId: string, nativeId: string) => {
				const snapshot = await runtime.snapshot();
				const body = {
					generation: 1,
					nativeSessionId,
					messages:
						nativeSessionId === runtime.nativeSessionId
							? snapshot.messages
							: ((await runtime.request(`/session/${encodeURIComponent(nativeId)}/message`)) as unknown[]),
					children: nativeSessionId === runtime.nativeSessionId ? snapshot.children : [],
					permissions: [],
					questions: [],
					status: { type: "idle" },
				};
				const response = await supervisorApp.request(
					`/api/v1/supervisors/chain-host/opencode/${instance.id}/snapshot`,
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify(body),
					},
				);
				expect(response.status).toBe(200);
			};
			await sendSnapshot(runtime.nativeSessionId, runtime.nativeSessionId);
			// NATIVE TIME OWNERSHIP: an ingested parent event keeps the native
			// creation time — the test does not fabricate it.
			const [parentEventRow] = await getDb()
				.select()
				.from(db.events)
				.where(eq(db.events.sessionId, parentId))
				.limit(1);
			const nativeCreated = Number(
				(parentMessages[0]?.info as { time?: { created?: number } }).time?.created ?? 0,
			);
			// Same INSTANT, whatever the stored representation (managed ingestion writes ISO).
			expect(new Date(String(parentEventRow?.createdAt)).getTime()).toBe(nativeCreated);

			await sendSnapshot(child.id, child.id);
			// The child is addressable only after finalize confirmed.
			runtime.registerManagedChild(child.id);
			await runtime.prompt("P0_HELLO", { nativeSessionId: child.id });
			await waitTurn(runtime);
			await runtime.snapshot();
			await sendSnapshot(child.id, child.id);
			const childMessages = await runtime.request<
				{ info: { id: string; role: string }; parts: unknown[] }[]
			>(`/session/${encodeURIComponent(child.id)}/message`);

			// Determinism for the COMPLETED-day report: pin the recorded times into
			// the report day (native times are "now"; native ownership itself was
			// asserted above before pinning).
			await getDb()
				.update(db.events)
				.set({ createdAt: reportAt })
				.where(eq(db.events.sessionId, parentId));
			await getDb()
				.update(db.events)
				.set({ createdAt: reportAt })
				.where(eq(db.events.sessionId, finalized.childSessionId));
			const [ledgerRow] = await getDb()
				.select()
				.from(db.opencodeForkRequests)
				.where(eq(db.opencodeForkRequests.actionId, actionId));
			const storedMap = ledgerRow?.childMap as { pairs?: { parentOccurredAt: string; parts?: { parentOccurredAt: string }[] }[] };
			for (const pair of storedMap?.pairs ?? []) {
				pair.parentOccurredAt = reportAt;
				for (const part of pair.parts ?? []) part.parentOccurredAt = reportAt;
			}
			await getDb()
				.update(db.opencodeForkRequests)
				.set({ childMap: storedMap })
				.where(eq(db.opencodeForkRequests.actionId, actionId));
			// copyOf resolves for the copied prefix.
			const copies = await loadCopiedEvents(finalized.childSessionId);
			expect(copies.size).toBeGreaterThan(0);

			// DAILY REPORT: parent work + only the NEW child work.
			modelInputs = [];
			await runWorklog(reportDay, true);
			const input = modelInputs.join("\n");
			const parentText = parentMessages
				.flatMap((message) =>
					message.parts.filter(
						(part) => (part as { type?: string }).type === "text",
					),
				)
				.map((part) => String((part as { text?: string }).text ?? ""))
				.filter(Boolean);
			const newText = String(
				(
					childMessages.at(-1)?.parts.find(
						(part) => (part as { type?: string }).type === "text",
					) as { text?: string } | undefined
				)?.text ?? "",
			);
			// Parent history appears (original), the copied prefix is deduped away,
			// and the new child turn appears.
			if (parentText[0]) expect(input).toContain(parentText[0]);
			if (newText) expect(input).toContain(newText);
			// DEDUPE PROOF lives in the FINAL facts (extraction input intentionally
			// contains every raw event, dedupe happens afterwards): the parent's
			// prompt fact survives once, the child's COPIED copy is dropped.
			expect(input.match(/prompt: P0_HELLO/g)?.length ?? 0).toBe(3);
			const run = await getWorklogRun(reportDay);
			const facts = (run?.facts ?? []) as { text: string; copyOf: string | null }[];
			const parentLike = facts.filter((fact) => /P0_HELLO/.test(fact.text));
			expect(parentLike.length).toBe(2); // parent original + new child turn
			for (const fact of parentLike) expect(fact.copyOf).toBeNull();
			const included = await getWorklogIncluded(reportDay);
			void included;
		} finally {
			await runtime.stop().catch(() => {});
			mock.kill();
			await rm(root, { recursive: true, force: true });
		}
	},
	180000,
);
