import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "../db/__test_db.js";
import { eq } from "drizzle-orm";
import { getDb, initializeDatabase } from "../db/client.js";
import { events, aiDailySpend, llmProviders, sessions, settings } from "../db/schema/index.js";
import { createProvider } from "./ai/providers-service.js";
import { upsertSetting } from "./settings-service.js";
import {
	adoptWorklogVersion,
	dayWindow,
	getWorklogIncluded,
	listWorklogs,
	localDate,
	queueWorklog,
	runScheduledWorklogs,
	runWorklog,
	saveWorklogConfig,
	setWorklogIncluded,
	validateDate,
} from "./worklog-service.js";

let modelInputs: string[] = [];
let deliveries: Array<{ key: string | null; body: Record<string, unknown> }> = [];
let documentStatus = 200;
let block: Promise<void> | null = null;
let release: (() => void) | null = null;
const stub = Bun.serve({
	port: 0,
	async fetch(req) {
		if (new URL(req.url).pathname === "/document") {
			deliveries.push({
				key: req.headers.get("Idempotency-Key"),
				body: (await req.json()) as Record<string, unknown>,
			});
			return new Response("{}", { status: documentStatus });
		}
		const body = (await req.json()) as { messages: Array<{ role: string; content: string }> };
		modelInputs.push(body.messages.map((m) => m.content).join("\n"));
		if (block) await block;
		const system = body.messages.find((m) => m.role === "system")?.content ?? "";
		const user = body.messages.map((m) => m.content).join("\n");
		if (system.includes("抽取工作事实")) {
			if (user.includes("PARSE_FAIL_MARKER")) {
				return Response.json({
					choices: [{ message: { content: "今天心情不错，无法输出", finish_reason: "stop" } }],
					usage: { prompt_tokens: 1, completion_tokens: 1 },
				});
			}
			// Adversarial-ish deterministic stub: honest categories per line kind,
			// but always claims a fabricated occurredAt the server must ignore,
			// and upgrades assistant lines to verified_result when the input
			// carries the HOSTILE marker (server must downgrade).
			const hostile = user.includes("HOSTILE_MARKER");
			const facts = [
				...user.matchAll(/\[#(\d+)\] (prompt|assistant_message|tool_event): ([^\n]*)/g),
			].map((m) => ({
				category:
					m[2] === "tool_event"
						? "verified_result"
						: hostile && m[2] === "assistant_message"
							? "verified_result"
							: m[2] === "assistant_message"
								? "agent_claim"
								: "user_goal",
				text: `stub事实：${m[3].slice(0, 60)}`,
				evidenceEventId: Number(m[1]),
				occurredAt: "1970-01-01T00:00:00.000Z",
				confidence: hostile ? "verified" : "stated",
			}));
			return Response.json({
				choices: [{ message: { content: JSON.stringify({ facts }), finish_reason: "stop" } }],
				usage: { prompt_tokens: 100, completion_tokens: 30 },
			});
		}
		return Response.json({
			choices: [
				{
					message: { content: "## 成果\n- 修复接收消息；测试通过。\n## 下一步\n- 部署验证。" },
					finish_reason: "stop",
				},
			],
			usage: { prompt_tokens: 100, completion_tokens: 30 },
		});
	},
});
let providerId: string;
beforeAll(async () => {
	await initializeDatabase();
});
beforeEach(async () => {
	for (const table of [events, sessions, settings, llmProviders, aiDailySpend])
		await getDb().delete(table);
	await upsertSetting("ai.enabled", true, { allowProtected: true });
	await upsertSetting("ai.killSwitch", false, { allowProtected: true });
	const provider = await createProvider({
		name: "worklog-test",
		kind: "openai_compatible",
		apiKey: "test-key",
		model: "local-model",
		baseUrl: `http://127.0.0.1:${stub.port}/v1`,
	});
	providerId = provider.id;
	await saveWorklogConfig({
		enabled: false,
		timezone: "Asia/Shanghai",
		time: "00:05",
		providerId,
		model: "local-model",
		documentUrl: `http://127.0.0.1:${stub.port}/document`,
		documentId: "daily-log",
	});
	modelInputs = [];
	deliveries = [];
	documentStatus = 200;
	block = null;
	release = null;
});
afterAll(() => stub.stop(true));
async function seed(
	id: string,
	at: string,
	content: string,
	category = "prompt",
	tool?: { eventType?: string; toolResponse?: string },
) {
	await getDb()
		.insert(sessions)
		.values({ sessionId: id, agentType: "codex_cli", displayName: id })
		.onConflictDoNothing();
	await getDb()
		.insert(events)
		.values({
			sessionId: id,
			eventType: tool?.eventType ?? "test",
			category,
			content,
			createdAt: at,
			toolResponse: tool?.toolResponse ?? null,
			rawPayload: {},
		});
}
async function waitUntil(fn: () => boolean) {
	for (let i = 0; i < 200; i++) {
		if (fn()) return;
		await Bun.sleep(5);
	}
	throw new Error("Timed out");
}

describe("work log calendar boundaries", () => {
	test("Shanghai and DST days include exactly the local calendar day", () => {
		const china = dayWindow("2026-01-01", "Asia/Shanghai");
		expect(china.start.toISOString()).toBe("2025-12-31T16:00:00.000Z");
		expect(china.end.toISOString()).toBe("2026-01-01T16:00:00.000Z");
		const dst = dayWindow("2026-03-08", "America/New_York");
		expect(dst.end.getTime() - dst.start.getTime()).toBe(23 * 3600000);
		expect(localDate(new Date("2026-01-01T16:00:00Z"), "Asia/Shanghai")).toBe("2026-01-02");
		expect(() => validateDate("2026-02-30")).toThrow();
	});
});
test("uses today's actual messages across hosts, skips excluded sessions, never exports raw secrets", async () => {
	await seed(
		"included",
		"2025-12-31 16:00:00",
		"修复消息转发，api_key=sk-abcdefghijklmnopqrstuvwxyz123456789",
	);
	await seed("included", "2026-01-01 15:59:59", "完成并验证", "assistant_message");
	await seed("excluded", "2026-01-01 04:00:00", "PRIVATE_EXCLUDED_CONTENT");
	await seed("tomorrow", "2026-01-01 16:00:00", "TOMORROW_CONTENT");
	await seed("yesterday", "2025-12-31 15:59:59", "YESTERDAY_CONTENT");
	await setWorklogIncluded("excluded", false);
	expect(await getWorklogIncluded("included")).toBe(true);
	const run = await runWorklog("2026-01-01", true);
	expect(run.status).toBe("delivered");
	expect(run.sessionIds).toEqual(["included"]);
	const inputs = modelInputs.join("\n");
	expect(inputs).toContain("修复消息转发");
	expect(inputs).toContain("完成并验证");
	for (const forbidden of [
		"PRIVATE_EXCLUDED_CONTENT",
		"TOMORROW_CONTENT",
		"YESTERDAY_CONTENT",
		"sk-abcdefghijklmnopqrstuvwxyz123456789",
	])
		expect(inputs).not.toContain(forbidden);
	// ── P4 fact pipeline: evidence-linked facts + two view versions ──
	const seededRows = await getDb()
		.select({ id: events.id, createdAt: events.createdAt })
		.from(events)
		.where(eq(events.sessionId, "included"));
	const seededIds = seededRows.map((row) => row.id);
	expect(run.facts?.length).toBeGreaterThanOrEqual(2);
	for (const fact of run.facts ?? []) expect(seededIds).toContain(fact.evidenceEventId);
	const factText = (run.facts ?? []).map((f) => f.text).join("\n");
	expect(factText).toContain("修复消息转发");
	expect(factText).not.toContain("sk-");
	expect(run.factMeta?.deduped).toBe(0);
	// No tool evidence was seeded, so nothing may claim to be verified.
	expect((run.facts ?? []).some((f) => f.category === "verified_result")).toBe(false);
	// occurrence times come from the source events, never the stub's 1970 claim
	for (const fact of run.facts ?? []) {
		const row = seededRows.find((r) => r.id === fact.evidenceEventId);
		if (!row) throw new Error("fact cites unknown event");
		expect(fact.occurredAt).toBe(row.createdAt);
	}
	const personal = run.versions?.find((v) => v.kind === "personal");
	const team = run.versions?.find((v) => v.kind === "team");
	if (!personal || !team) throw new Error("dual view versions missing");
	expect(personal.markdown).toContain("事件 #");
	expect(personal.markdown).toContain("目标与指令");
	expect(team.markdown).toContain("## 成果");
	expect(run.adoptedVersionId).toBe(team.versionId);
	expect(run.markdown).toBe(team.markdown);
	expect(deliveries).toHaveLength(1);
	expect(deliveries[0].body.markdown).toBe(run.markdown);
	expect(deliveries[0].key).toBe("agentpulse-worklog:Asia/Shanghai:2026-01-01:daily-log");
	await runWorklog("2026-01-01", true);
	expect(deliveries).toHaveLength(1);
	// one extraction call + one team call; the retry reuses the persisted run
	expect(modelInputs).toHaveLength(2);
});
test("document retry reuses persisted summary and stable idempotency key", async () => {
	await seed("one", "2026-01-01 05:00:00", "本日任务");
	documentStatus = 500;
	await expect(runWorklog("2026-01-01", true)).rejects.toThrow("HTTP 500");
	expect((await listWorklogs())[0].status).toBe("failed");
	documentStatus = 200;
	await runWorklog("2026-01-01", true);
	// retry after delivery failure reuses the persisted run (no new model calls)
	expect(modelInputs).toHaveLength(2);
	expect(deliveries).toHaveLength(2);
	expect(deliveries[0].key).toBe(deliveries[1].key);
});
test("exclusion changes stop delivery of an older draft", async () => {
	await seed("one", "2026-01-01 05:00:00", "work");
	await runWorklog("2026-01-01");
	await setWorklogIncluded("one", false);
	await expect(runWorklog("2026-01-01", true)).rejects.toThrow("scope changed");
	expect(deliveries).toHaveLength(0);
});
test("concurrent workers cannot generate or deliver the same date twice", async () => {
	await seed("one", "2026-01-01 05:00:00", "work");
	block = new Promise<void>((resolve) => {
		release = resolve;
	});
	const first = runWorklog("2026-01-01", true);
	await waitUntil(() => modelInputs.length > 0);
	await expect(runWorklog("2026-01-01", true)).rejects.toThrow("already running");
	release?.();
	await first;
	expect(modelInputs).toHaveLength(2);
	expect(deliveries).toHaveLength(1);
});
test("a stale worker cannot delete a new worker's lease or deliver its content", async () => {
	await seed("one", "2026-01-01 05:00:00", "work");
	block = new Promise<void>((resolve) => {
		release = resolve;
	});
	const first = runWorklog("2026-01-01", true);
	await waitUntil(() => modelInputs.length > 0);
	const key = "worklog.lock.Asia/Shanghai.2026-01-01";
	await getDb()
		.update(settings)
		.set({ value: { token: "new-owner" } })
		.where(eq(settings.key, key));
	release?.();
	await expect(first).rejects.toThrow("lease lost");
	const [lock] = await getDb().select().from(settings).where(eq(settings.key, key));
	expect(lock.value).toEqual({ token: "new-owner" });
	expect(deliveries).toHaveLength(0);
});
test("invalid/incomplete days are rejected before accepting a background task", async () => {
	await expect(queueWorklog("2999-01-01", false)).rejects.toThrow("completed");
	await expect(queueWorklog("bad-date", false)).rejects.toThrow("Invalid");
});

test("scheduler follows the configured timezone, catches up complete days and never redelivers successes", async () => {
	await seed("one", "2026-01-01 05:00:00", "本日任务");
	await saveWorklogConfig({
		enabled: true,
		timezone: "Asia/Shanghai",
		time: "00:05",
		providerId,
		model: "local-model",
		documentUrl: `http://127.0.0.1:${stub.port}/document`,
		documentId: "daily-log",
	});
	await upsertSetting("worklog.firstDay", "2026-01-01", { allowProtected: true });
	await runScheduledWorklogs(new Date("2026-01-01T16:04:00Z"));
	expect(deliveries).toHaveLength(0);
	await runScheduledWorklogs(new Date("2026-01-01T16:05:00Z"));
	expect(deliveries).toHaveLength(1);
	await runScheduledWorklogs(new Date("2026-01-01T17:05:00Z"));
	expect(deliveries).toHaveLength(1);
});

test("without a proven copy mapping, same-text work is conservatively kept", async () => {
	await seed("parent", "2026-01-01 05:00:00", "完成了迁移脚本并验证");
	await seed("parent", "2026-01-01 05:30:00", "迁移全部通过", "assistant_message");
	// A managed child session ingests identical content — but content equality
	// plus lineage naming is NOT proof of copying, so nothing is dropped yet.
	await seed("parent:opencode-child:ses_t", "2026-01-01 07:00:00", "完成了迁移脚本并验证");
	await seed(
		"parent:opencode-child:ses_t",
		"2026-01-01 07:30:00",
		"迁移全部通过",
		"assistant_message",
	);
	// Unrelated sessions doing the same work.
	await seed("hostA-proj", "2026-01-01 08:00:00", "完成了迁移脚本并验证");
	await seed("hostB-proj", "2026-01-01 09:00:00", "完成了迁移脚本并验证");
	const run = await runWorklog("2026-01-01");
	expect(run.sessionIds).toHaveLength(4);
	expect(run.facts).toHaveLength(6);
	expect(run.factMeta?.deduped).toBe(0);
});

test("a hostile model cannot launder assistant claims into verified results", async () => {
	await seed("hostile", "2026-01-01 05:00:00", "HOSTILE_MARKER 修复完成");
	await seed("hostile", "2026-01-01 05:30:00", "我确信全部测试通过了", "assistant_message");
	const run = await runWorklog("2026-01-01");
	// The stub claimed verified_result + confidence verified on BOTH lines;
	// the assistant-cited fact must come back as an unverified claim.
	const categories = (run.facts ?? []).map((f) => f.category).sort();
	expect(categories).toEqual(["agent_claim", "user_goal"]);
	expect(run.factMeta?.downgraded).toBe(1);
	expect((run.facts ?? []).every((f) => f.confidence !== "verified")).toBe(true);
});

test("running or failed tools cannot be laundered into verified results", async () => {
	await seed("toolstate", "2026-01-01 05:00:00", "HOSTILE_MARKER 开始验证");
	await seed("toolstate", "2026-01-01 05:10:00", "bash", "tool_event", { eventType: "PreToolUse" });
	await seed("toolstate", "2026-01-01 05:20:00", "bash", "tool_event", {
		eventType: "PostToolUseFailure",
		toolResponse: "exit 1: suite failed",
	});
	const run = await runWorklog("2026-01-01");
	// The stub labels every tool line verified_result; the server must return
	// plain tool executions with stated confidence.
	expect((run.facts ?? []).some((f) => f.category === "verified_result")).toBe(false);
	expect((run.facts ?? []).some((f) => f.category === "tool_action")).toBe(true);
	expect(run.factMeta?.downgraded).toBe(2);
	expect((run.facts ?? []).every((f) => f.confidence === "stated")).toBe(true);
});

test("tool evidence backs verified results and occurrence times bind to source events", async () => {
	await seed("toolev", "2026-01-01 05:00:00", "请运行回归");
	await seed("toolev", "2026-01-01 05:30:00", "bash", "tool_event", {
		eventType: "PostToolUse",
		toolResponse: "20 passed, 0 failed",
	});
	const run = await runWorklog("2026-01-01");
	const verified = (run.facts ?? []).filter((f) => f.category === "verified_result");
	expect(verified).toHaveLength(1);
	expect(verified[0]?.confidence).toBe("verified");
	const rows = await getDb()
		.select({ id: events.id, createdAt: events.createdAt })
		.from(events)
		.where(eq(events.sessionId, "toolev"));
	for (const fact of run.facts ?? []) {
		const row = rows.find((r) => r.id === fact.evidenceEventId);
		if (!row) throw new Error("fact cites unknown event");
		expect(fact.occurredAt).toBe(row.createdAt);
	}
});

test("unparseable extraction output fails the run instead of producing an empty log", async () => {
	await seed("parsefail", "2026-01-01 05:00:00", "PARSE_FAIL_MARKER 内容");
	await expect(runWorklog("2026-01-01")).rejects.toThrow("unparseable fact extraction");
	const [run] = (await listWorklogs()).filter((r) => r.date === "2026-01-01");
	expect(run.status).toBe("failed");
	expect(run.error).toContain("unparseable");
});

test("forced regeneration appends versions and never overwrites old drafts", async () => {
	await seed("regen", "2026-01-01 06:00:00", "第一轮工作");
	const first = await runWorklog("2026-01-01");
	expect(first.versions).toHaveLength(2);
	const firstPersonal = first.versions?.[0];
	await seed("regen", "2026-01-01 07:00:00", "第二轮工作");
	const second = await runWorklog("2026-01-01", false, {
		token: await claimTestToken(),
		config: await testConfig(),
		force: true,
	});
	expect(second.versions?.length).toBeGreaterThanOrEqual(4);
	// The old personal draft is preserved verbatim.
	expect(second.versions?.some((v) => v.versionId === firstPersonal?.versionId)).toBe(true);
	expect(second.facts?.length).toBeGreaterThan(first.facts?.length ?? 0);
	// The adopted (delivered) markdown is the LATEST team version.
	const lastTeam = second.versions?.filter((v) => v.kind === "team").at(-1);
	expect(second.adoptedVersionId).toBe(lastTeam?.versionId);
});

test("adopting the personal view switches delivery content", async () => {
	await seed("adopt", "2026-01-01 08:00:00", "采纳视图测试");
	const run = await runWorklog("2026-01-01");
	const personal = run.versions?.find((v) => v.kind === "personal");
	if (!personal) throw new Error("personal version missing");
	const adopted = await adoptWorklogVersion("2026-01-01", personal.versionId);
	expect(adopted.adoptedVersionId).toBe(personal.versionId);
	expect(adopted.markdown).toBe(personal.markdown);
	await expect(adoptWorklogVersion("2026-01-01", "v0-nonexistent")).rejects.toThrow(
		"Unknown version",
	);
	// Delivery now exports the adopted personal view.
	const delivered = await runWorklog("2026-01-01", true);
	expect(delivered.status).toBe("delivered");
	expect(deliveries.at(-1)?.body.markdown).toBe(personal.markdown);
	// A delivered log is locked against re-adoption.
	await expect(adoptWorklogVersion("2026-01-01", personal.versionId)).rejects.toThrow("delivered");
});

async function claimTestToken(): Promise<string> {
	// Reuse the service's lease claim through the public path: queueWorklog is
	// async, so tests drive runWorklog directly with a lease they claim here.
	const { readWorklogValue } = await import("./worklog-service.js");
	void readWorklogValue;
	const leaseKey = "worklog.lock.Asia/Shanghai.2026-01-01";
	// claim() is module-private; take the lease through a throwaway run instead.
	// Simplest correct route: use queueWorklog's admission — but it is also
	// private. We claim by writing the setting the way claim() does.
	const token = `test-${crypto.randomUUID()}`;
	await upsertSetting(leaseKey, { token }, { allowProtected: true });
	return token;
}

async function testConfig() {
	const { getWorklogConfig } = await import("./worklog-service.js");
	return getWorklogConfig();
}
