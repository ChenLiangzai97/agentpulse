import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "../db/__test_db.js";
import { eq } from "drizzle-orm";
import { getDb, initializeDatabase } from "../db/client.js";
import { events, aiDailySpend, llmProviders, sessions, settings } from "../db/schema/index.js";
import { createProvider } from "./ai/providers-service.js";
import { upsertSetting } from "./settings-service.js";
import {
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
		const body = (await req.json()) as { messages: Array<{ content: string }> };
		modelInputs.push(body.messages.map((m) => m.content).join("\n"));
		if (block) await block;
		return Response.json({
			choices: [
				{
					message: { content: "- 已完成：修复接收消息；测试通过。\n- 下一步：部署验证。" },
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
async function seed(id: string, at: string, content: string, category = "prompt") {
	await getDb()
		.insert(sessions)
		.values({ sessionId: id, agentType: "codex_cli", displayName: id })
		.onConflictDoNothing();
	await getDb()
		.insert(events)
		.values({ sessionId: id, eventType: "test", category, content, createdAt: at, rawPayload: {} });
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
	expect(deliveries).toHaveLength(1);
	expect(deliveries[0].body.markdown).toBe(run.markdown);
	expect(deliveries[0].key).toBe("agentpulse-worklog:Asia/Shanghai:2026-01-01:daily-log");
	await runWorklog("2026-01-01", true);
	expect(deliveries).toHaveLength(1);
	expect(modelInputs).toHaveLength(1);
});
test("document retry reuses persisted summary and stable idempotency key", async () => {
	await seed("one", "2026-01-01 05:00:00", "本日任务");
	documentStatus = 500;
	await expect(runWorklog("2026-01-01", true)).rejects.toThrow("HTTP 500");
	expect((await listWorklogs())[0].status).toBe("failed");
	documentStatus = 200;
	await runWorklog("2026-01-01", true);
	expect(modelInputs).toHaveLength(1);
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
	expect(modelInputs).toHaveLength(1);
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
