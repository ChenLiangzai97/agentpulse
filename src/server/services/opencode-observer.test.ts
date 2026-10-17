import "../db/__test_db.js";
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { AGENT_TYPES, isLaunchable } from "../../shared/constants.js";
import { getDb, initializeDatabase } from "../db/client.js";
import { events, sessions } from "../db/schema/index.js";
import { OpenCodeObserver, cleanOpenCodeText } from "./opencode-observer.js";

const dir = mkdtempSync(join(tmpdir(), "opencode-observer-"));
const path = join(dir, "source.db");
const source = new Database(path);
source.exec(`PRAGMA journal_mode=WAL;
 CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, directory TEXT, parent_id TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER, cost REAL, tokens_input INTEGER);
 CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT, time_created INTEGER, time_updated INTEGER);
 CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT, message_id TEXT, data TEXT, time_created INTEGER, time_updated INTEGER);`);
let observer: OpenCodeObserver;
const now = Date.now();
function message(id: string, session: string, role: string, stamp: number, completed = false) {
	source.query("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run(
		id,
		session,
		JSON.stringify({
			role,
			time: { created: stamp, ...(completed ? { completed: stamp } : {}) },
		}),
		stamp,
		stamp,
	);
}
function part(id: string, session: string, msg: string, data: unknown, stamp: number) {
	source
		.query("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)")
		.run(id, session, msg, JSON.stringify(data), stamp, stamp);
}
async function rows(id = "parent") {
	return getDb()
		.select()
		.from(events)
		.where(eq(events.sessionId, observer.sessionId(id)));
}
async function session(id = "parent") {
	return (
		await getDb()
			.select()
			.from(sessions)
			.where(eq(sessions.sessionId, observer.sessionId(id)))
	)[0];
}
beforeAll(async () => {
	await initializeDatabase();
	observer = new OpenCodeObserver(path, "observer-test");
	for (const [id, parent] of [
		["parent", null],
		["child", "parent"],
	]) {
		source
			.query("INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, NULL, 1.5, 42)")
			.run(id, `Title ${id}`, "/tmp/project", parent, now - 10000, now);
	}
	message("user", "parent", "user", now - 3);
	part(
		"prompt",
		"parent",
		"user",
		{
			type: "text",
			text: "<botmux_routing>secret</botmux_routing><session_id>hidden</session_id><user_message>run tool</user_message>",
		},
		now - 3,
	);
	message("assistant", "parent", "assistant", now - 2);
	part(
		"tool",
		"parent",
		"assistant",
		{
			type: "tool",
			tool: "bash",
			callID: "call-1",
			state: { status: "running", input: { command: "botmux send 'result'" } },
		},
		now - 1,
	);
});
afterAll(() => {
	observer.close();
	source.close();
	rmSync(dir, { recursive: true, force: true });
});

test("observed-only registration and hidden context cleaning", () => {
	expect(AGENT_TYPES).toContain("opencode");
	expect(isLaunchable("opencode")).toBe(false);
	expect(cleanOpenCodeText("<identity>x\ny</identity>正文")).toBe("正文");
});
test("imports native identities, title, parent and prompt/tool evidence", async () => {
	const result = await observer.sync();
	expect(result.changedEvents).toBe(2);
	expect(await session()).toMatchObject({
		agentType: "opencode",
		displayName: "Title parent",
		cwd: "/tmp/project",
		totalToolUses: 1,
		isWorking: true,
	});
	const child = await session("child");
	expect(
		(child.metadata as { opencode: { parentSessionId: string } }).opencode.parentSessionId,
	).toBe(observer.sessionId("parent"));
	expect((await rows()).find((e) => e.category === "prompt")?.content).toBe("run tool");
	expect((await rows()).find((e) => e.category === "tool_event")?.toolInput).toEqual({
		command: "botmux send 'result'",
	});
	expect(source.query("SELECT COUNT(*) AS n FROM part").get()).toEqual({ n: 2 });
});
test("WAL writer continues; running to completed updates one row and counts once", async () => {
	const before = (await rows()).find((e) => e.category === "tool_event");
	source.query("UPDATE part SET data = ?, time_updated = ? WHERE id = 'tool'").run(
		JSON.stringify({
			type: "tool",
			tool: "bash",
			callID: "call-1",
			state: {
				status: "completed",
				input: { command: "botmux send 'result'" },
				output: "sent successfully",
			},
		}),
		now + 1,
	);
	source
		.query("UPDATE message SET data = ?, time_updated = ? WHERE id = 'assistant'")
		.run(JSON.stringify({ role: "assistant", time: { completed: now + 1 } }), now + 1);
	part("reply", "parent", "assistant", { type: "text", text: "delivered" }, now + 1);
	await observer.sync();
	const after = (await rows()).find((e) => e.category === "tool_event");
	expect(after).toMatchObject({
		id: before?.id,
		eventType: "PostToolUse",
		toolResponse: "sent successfully",
	});
	expect(await session()).toMatchObject({ totalToolUses: 1, isWorking: false, status: "idle" });
	expect((await rows()).length).toBe(3);
	expect((await observer.sync()).changedEvents).toBe(0);
	expect((await observer.sync()).changedEvents).toBe(0);
});
test("restart replays safely, fills offline changes and handles archived session", async () => {
	observer.close();
	message("child-user", "child", "user", now + 2);
	part("child-text", "child", "child-user", { type: "text", text: "offline prompt" }, now + 2);
	source
		.query("UPDATE session SET time_archived = ?, time_updated = ? WHERE id = 'child'")
		.run(now + 2, now + 2);
	observer = new OpenCodeObserver(path, "observer-test");
	expect((await observer.sync()).changedEvents).toBe(1);
	expect(await session("child")).toMatchObject({
		isArchived: true,
		status: "idle",
		semanticStatus: "waiting",
	});
	expect((await rows()).length).toBe(3);
	expect((await rows("child")).length).toBe(1);
});
test("independent source instances cannot merge equal native IDs", async () => {
	const second = new OpenCodeObserver(path, "second-instance");
	try {
		expect(second.sessionId("parent")).not.toBe(observer.sessionId("parent"));
		await second.sync();
		expect(
			(
				await getDb()
					.select()
					.from(events)
					.where(eq(events.sessionId, second.sessionId("parent")))
			).length,
		).toBe(3);
	} finally {
		second.close();
	}
});
test("schema validation fails read-only without modifying unknown storage", () => {
	const badPath = join(dir, "unsupported.db");
	const bad = new Database(badPath);
	bad.exec("CREATE TABLE session(id TEXT)");
	bad.close();
	expect(() => new OpenCodeObserver(badPath)).toThrow("Unsupported OpenCode schema");
	const check = new Database(badPath, { readonly: true });
	expect(check.query("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").get()).toEqual({
		n: 1,
	});
	check.close();
});
