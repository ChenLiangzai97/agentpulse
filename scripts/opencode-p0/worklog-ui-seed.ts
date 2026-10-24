/** Worklog UI E2E fixture: stub model + seed + generate a dual-view run. */
process.env.SQLITE_PATH = "/tmp/agentpulse-wl-e2e/e2e.db";
process.env.DATA_DIR = "/tmp/agentpulse-wl-e2e/data";
process.env.DISABLE_AUTH = "true";
process.env.AGENTPULSE_AI_ENABLED = "true";
// Isolation guards: never inherit a production DATABASE_URL or observer
// switches (Bun auto-loads .env from the repo cwd — explicitly neutralize).
process.env.DATABASE_URL = "";
process.env.AGENTPULSE_OPENCODE_ENABLED = "";
process.env.AGENTPULSE_OPENCODE_DB = "";
import { serve } from "bun";

// 1. deterministic stub model (loopback; facts JSON for extraction, markdown for team draft)
const modelInputs: string[] = [];
const stub = serve({
	port: 0,
	hostname: "127.0.0.1",
	async fetch(req) {
		const body = (await req.json()) as { messages: Array<{ role: string; content: string }> };
		const system = body.messages.find((m) => m.role === "system")?.content ?? "";
		const user = body.messages.map((m) => m.content).join("\n");
		modelInputs.push(user);
		if (system.includes("抽取工作事实")) {
			const facts = [
				...user.matchAll(/\[#(\d+)\] (prompt|assistant_message|tool_event):([^\n]*)/g),
			].map((m) => ({
				category:
					m[2] === "tool_event"
						? "tool_action"
						: m[2] === "assistant_message"
							? "agent_claim"
							: "user_goal",
				text: `事实：${m[3].trim().slice(0, 60)}`,
				evidenceEventId: Number(m[1]),
			}));
			return Response.json({
				choices: [{ message: { content: JSON.stringify({ facts }), finish_reason: "stop" } }],
				usage: { prompt_tokens: 10, completion_tokens: 5 },
			});
		}
		return Response.json({
			choices: [
				{
					message: {
						content:
							"## 成果\n- 完成工作台页签与命令矩阵\n## 进行中\n- 日志双视图\n## 阻塞\n- 无\n## 下一步\n- 浏览器验收",
						finish_reason: "stop",
					},
				},
			],
			usage: { prompt_tokens: 10, completion_tokens: 5 },
		});
	},
});

const { config } = await import("/home/ch/project/work_station/agentpulse/src/server/config.js");
if (config.dialect !== "sqlite")
	throw new Error("Refusing to run: DATABASE_URL leaked (postgres dialect)");
if (!process.env.SQLITE_PATH?.startsWith("/tmp/agentpulse-wl-e2e/"))
	throw new Error(
		`Refusing to truncate: SQLITE_PATH is not the dedicated test db (${process.env.SQLITE_PATH})`,
	);
const { initializeDatabase, getDb } = await import(
	"/home/ch/project/work_station/agentpulse/src/server/db/client.js"
);
await initializeDatabase();
const { events, sessions, settings } = await import(
	"/home/ch/project/work_station/agentpulse/src/server/db/schema/index.js"
);
for (const t of [events, sessions, settings]) await getDb().delete(t);
await getDb()
	.insert(sessions)
	.values([
		{ sessionId: "e2e-main", agentType: "codex_cli", displayName: "会话工作台开发" },
		{ sessionId: "e2e-aux", agentType: "codex_cli", displayName: "日志双视图开发" },
	]);
await getDb()
	.insert(events)
	.values([
		{
			sessionId: "e2e-main",
			eventType: "UserPromptSubmit",
			category: "prompt",
			content: "实现页签工作台与命令矩阵",
			createdAt: "2026-10-16 05:00:00",
			rawPayload: {},
		},
		{
			sessionId: "e2e-main",
			eventType: "AssistantMessage",
			category: "assistant_message",
			content: "我已经完成了页签与命令矩阵",
			createdAt: "2026-10-16 05:30:00",
			rawPayload: {},
		},
		{
			sessionId: "e2e-main",
			eventType: "PostToolUse",
			category: "tool_event",
			content: "bash",
			toolResponse: "bun test src/server/services 3154 pass",
			createdAt: "2026-10-16 05:40:00",
			rawPayload: {},
		},
		{
			sessionId: "e2e-aux",
			eventType: "UserPromptSubmit",
			category: "prompt",
			content: "实现日志统一事实与双视图",
			createdAt: "2026-10-16 08:00:00",
			rawPayload: {},
		},
		{
			sessionId: "e2e-aux",
			eventType: "PostToolUseFailure",
			category: "tool_event",
			content: "bash",
			toolResponse: "exit 1: suite failed",
			createdAt: "2026-10-16 08:30:00",
			rawPayload: {},
		},
	]);
const { upsertSetting } = await import(
	"/home/ch/project/work_station/agentpulse/src/server/services/settings-service.js"
);
await upsertSetting("ai.enabled", true, { allowProtected: true });
await upsertSetting("ai.killSwitch", false, { allowProtected: true });
const { saveWorklogConfig, runWorklog } = await import(
	"/home/ch/project/work_station/agentpulse/src/server/services/worklog-service.js"
);
const { createProvider } = await import(
	"/home/ch/project/work_station/agentpulse/src/server/services/ai/providers-service.js"
);
const provider = await createProvider({
	name: "stub",
	kind: "openai_compatible",
	apiKey: "k",
	model: "stub-model",
	baseUrl: `http://127.0.0.1:${stub.port}/v1`,
});
await saveWorklogConfig({
	enabled: false,
	timezone: "Asia/Shanghai",
	time: "00:05",
	providerId: provider.id,
	model: "stub-model",
	documentUrl: "",
	documentId: "",
});
const run = await runWorklog("2026-10-16");
console.log(
	JSON.stringify({
		status: run.status,
		facts: run.facts?.length,
		versions: run.versions?.map((v) => v.kind),
		adopted: run.adoptedVersionId,
		modelCalls: modelInputs.length,
		stubPort: stub.port,
	}),
);
stub.stop(true);
process.exit(0);
