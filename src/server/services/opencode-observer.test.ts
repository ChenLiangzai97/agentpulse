/**
 * AGEN-71: the OpenCode observer (AGEN-71). Real temp SQLite shaped like
 * OpenCode's own database; a fake fetch captures every self-POST so the
 * assertions see exactly what ingest would receive.
 */
import "./ai/__test_db.js";

import { Database } from "bun:sqlite";
import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DELIVERY_ID_HEADER, ORIGIN_HEADER } from "../../shared/hook-headers.js";

const { runScan, loadState, deliveryIdFor, mapMessage } = await import("./opencode-observer.js");

const TMP = mkdtempSync(join(tmpdir(), "ap-opencode-observer-"));
afterAll(() => {
	if (process.platform === "win32") return;
	rmSync(TMP, { recursive: true, force: true });
});

interface Captured {
	method: string;
	url: string;
	headers: Record<string, string>;
	body: Record<string, unknown>;
}

function makeDb(path: string): Database {
	const db = new Database(path);
	db.exec("PRAGMA journal_mode = WAL;");
	db.exec(`CREATE TABLE session (
		id TEXT PRIMARY KEY, project_id TEXT, workspace_id TEXT, parent_id TEXT,
		slug TEXT, directory TEXT, path TEXT, title TEXT, version TEXT,
		share_url TEXT, summary_additions INTEGER, summary_deletions INTEGER,
		summary_files INTEGER, summary_diffs TEXT, metadata TEXT, cost REAL,
		tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER,
		tokens_cache_read INTEGER, tokens_cache_write INTEGER, revert TEXT,
		permission TEXT, agent TEXT, model TEXT, time_created INTEGER,
		time_updated INTEGER, time_compacting INTEGER, time_archived INTEGER
	)`);
	db.exec(`CREATE TABLE message (
		id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT
	)`);
	db.exec(`CREATE TABLE part (
		id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT,
		time_created INTEGER, time_updated INTEGER, data TEXT
	)`);
	return db;
}

const OLD = 1_000_000;

function seedConversation(db: Database, sessionId: string, directory: string, title: string) {
	db.prepare(
		"INSERT INTO session (id, directory, title, model, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)",
	).run(sessionId, directory, title, "zhipuai-coding-plan/glm-5.3", OLD, OLD);
	db.prepare(
		"INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
	).run("msg-u1", sessionId, OLD, OLD, JSON.stringify({ role: "user" }));
	db.prepare(
		"INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
	).run(
		"prt-u1",
		"msg-u1",
		sessionId,
		OLD,
		OLD,
		JSON.stringify({ type: "text", text: "Fix the login bug." }),
	);
	db.prepare(
		"INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
	).run("msg-a1", sessionId, OLD, OLD, JSON.stringify({ role: "assistant" }));
	db.prepare(
		"INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
	).run(
		"prt-t1",
		"msg-a1",
		sessionId,
		OLD,
		OLD,
		JSON.stringify({
			type: "tool",
			tool: "edit",
			callID: "call_1",
			state: { status: "completed", input: { file_path: "src/auth.ts" }, output: "ok" },
		}),
	);
	db.prepare(
		"INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
	).run(
		"prt-t2",
		"msg-a1",
		sessionId,
		OLD,
		OLD,
		JSON.stringify({
			type: "tool",
			tool: "bash",
			callID: "call_2",
			state: { status: "error", input: { command: "npm test" }, error: "exit 1" },
		}),
	);
	db.prepare(
		"INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
	).run(
		"prt-a1",
		"msg-a1",
		sessionId,
		OLD,
		OLD,
		JSON.stringify({ type: "text", text: "Fixed the guard clause." }),
	);
}

function makeDeps(home: string, captured: Captured[]) {
	return {
		hooksUrl: "http://server",
		apiUrl: "http://server",
		apiKey: null,
		now: () => OLD + 60_000,
		home,
		fetchImpl: (async (url: string, init?: RequestInit) => {
			captured.push({
				method: init?.method ?? "GET",
				url,
				headers: (init?.headers ?? {}) as Record<string, string>,
				body: JSON.parse((init?.body as string) ?? "{}") as Record<string, unknown>,
			});
			return new Response(JSON.stringify({ ok: true }), { status: 200 });
		}) as unknown as typeof fetch,
	};
}

let db: Database;
let captured: Captured[];
let deps: ReturnType<typeof makeDeps>;
let statePath: string;
let home: string;

beforeEach(() => {
	db?.close();
	home = join(TMP, `home-${crypto.randomUUID()}`);
	mkdirSync(join(home, ".agentpulse"), { recursive: true });
	db = makeDb(join(TMP, `db-${crypto.randomUUID()}.db`));
	captured = [];
	deps = makeDeps(home, captured);
	statePath = join(home, ".agentpulse", "opencode-observer-state.json");
});

const hooks = () => captured.filter((c) => c.url.endsWith("/api/v1/hooks"));

test("a settled conversation replays as canonical hook deliveries, in order", async () => {
	seedConversation(db, "ses_a1", "/work/proj", "Fix login");
	const state = loadState(statePath);
	await runScan(db, state, deps, { statePath });
	const posts = hooks();
	const names = posts.map((p) => p.body.hook_event_name);
	expect(names).toEqual([
		"SessionStart",
		"UserPromptSubmit",
		"PostToolUse",
		"PostToolUseFailure",
		"Stop",
	]);
	const start = posts[0];
	expect(start.body.session_id).toBe("ses_a1");
	expect(start.body.cwd).toBe("/work/proj");
	expect(start.body.model).toBe("zhipuai-coding-plan/glm-5.3");
	expect(start.headers["X-Agent-Type"]).toBe("opencode");
	expect(start.headers[ORIGIN_HEADER]).toBe("opencode-observer");
	expect(typeof start.headers[DELIVERY_ID_HEADER]).toBe("string");
	const prompt = posts[1];
	expect(prompt.body.prompt).toBe("Fix the login bug.");
	const toolOk = posts[2];
	expect(toolOk.body.tool_name).toBe("edit");
	expect(toolOk.body.tool_input).toEqual({ file_path: "src/auth.ts" });
	expect(toolOk.body.tool_response).toBe("ok");
	expect(toolOk.body.tool_use_id).toBe("call_1");
	const toolFail = posts[3];
	expect(toolFail.body.hook_event_name).toBe("PostToolUseFailure");
	expect(toolFail.body.tool_response).toBe("exit 1");
	const stop = posts[4];
	expect(stop.body.last_assistant_message).toBe("Fixed the guard clause.");
	expect(stop.body.turn_id).toBe("msg-a1");
});

test("the session title goes through the native-name pull", async () => {
	seedConversation(db, "ses_t1", "/work/proj", "My Important Session");
	await runScan(db, loadState(statePath), deps, { statePath });
	const pull = captured.find((c) => c.url.includes("/native-name"));
	expect(pull?.method).toBe("PUT");
	expect(pull?.body.name).toBe("My Important Session");
});

test("a second scan delivers nothing new (cursor advanced, title unchanged)", async () => {
	seedConversation(db, "ses_b1", "/work/proj", "Stable");
	const state = loadState(statePath);
	await runScan(db, state, deps, { statePath });
	const first = hooks().length;
	captured.length = 0;
	await runScan(db, state, deps, { statePath });
	expect(hooks()).toHaveLength(0);
	expect(captured.filter((c) => c.url.includes("native-name"))).toHaveLength(0);
	void first;
});

test("a still-streaming message blocks delivery and the cursor stays put", async () => {
	seedConversation(db, "ses_c1", "/work/proj", "Live");
	db.prepare("UPDATE message SET time_updated = ? WHERE id = ?").run(deps.now?.() + 1, "msg-a1");
	await runScan(db, loadState(statePath), deps, { statePath });
	const names = hooks().map((p) => p.body.hook_event_name);
	// SessionStart + the settled user prompt went out; the streaming assistant
	// message and everything behind it wait.
	expect(names).toEqual(["SessionStart", "UserPromptSubmit"]);
});

test("an excluded directory posts nothing, and its cursor still advances", async () => {
	const sid = "ses_e1";
	seedConversation(db, sid, "/secret/dir", "Hidden");
	writeFileSync(join(home, ".agentpulse", "exclude"), "/secret/dir\n");
	await runScan(db, loadState(statePath), deps, { statePath });
	expect(hooks()).toHaveLength(0);
	const state = loadState(statePath);
	expect(state.sessions[sid]?.excluded).toBe(true);
	expect(state.sessions[sid]?.msgCursor).toBeGreaterThan(0);
});

test("an archived session gets SessionEnd and no message processing", async () => {
	seedConversation(db, "ses_f1", "/work/proj", "Done");
	db.prepare("UPDATE session SET time_archived = ? WHERE id = ?").run(OLD, "ses_f1");
	await runScan(db, loadState(statePath), deps, { statePath });
	const names = hooks().map((p) => p.body.hook_event_name);
	expect(names).toEqual(["SessionStart", "SessionEnd"]);
});

test("delivery ids are deterministic across replays", () => {
	expect(deliveryIdFor("message", "ses_a1", 7)).toBe(deliveryIdFor("message", "ses_a1", 7));
	expect(deliveryIdFor("message", "ses_a1", 7)).not.toBe(deliveryIdFor("message", "ses_a1", 8));
	expect(deliveryIdFor("part", "ses_a1", 7)).not.toBe(deliveryIdFor("message", "ses_a1", 7));
	expect(deliveryIdFor("message", "ses_a1", 7)).toMatch(/^[0-9a-f]{32}$/);
});

test("mapMessage ignores non-text/non-tool parts and unsettled tools", () => {
	const message = {
		rowid: 1,
		id: "msg_a",
		session_id: "ses_a",
		time_created: OLD,
		time_updated: OLD,
		data: JSON.stringify({ role: "assistant" }),
	};
	const parts = [
		{
			rowid: 1,
			id: "p1",
			message_id: "msg_a",
			time_updated: OLD,
			data: JSON.stringify({ type: "step-start" }),
		},
		{
			rowid: 2,
			id: "p2",
			message_id: "msg_a",
			time_updated: OLD,
			data: JSON.stringify({
				type: "tool",
				tool: "bash",
				callID: "c",
				state: { status: "running" },
			}),
		},
		{
			rowid: 3,
			id: "p3",
			message_id: "msg_a",
			time_updated: OLD,
			data: JSON.stringify({ type: "reasoning", text: "hmm" }),
		},
		{
			rowid: 4,
			id: "p4",
			message_id: "msg_a",
			time_updated: OLD,
			data: JSON.stringify({ type: "text", text: "Done." }),
		},
	];
	const mapped = mapMessage(message, parts);
	expect(mapped.payloads).toHaveLength(1);
	expect(mapped.payloads[0]?.payload.hook_event_name).toBe("Stop");
});

test("oversized tool output is capped before posting", async () => {
	db.prepare(
		"INSERT INTO session (id, directory, title, time_created, time_updated) VALUES (?, ?, ?, ?, ?)",
	).run("ses_g1", "/work/proj", "Big", OLD, OLD);
	db.prepare(
		"INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
	).run("msg_g1", "ses_g1", OLD, OLD, JSON.stringify({ role: "assistant" }));
	db.prepare(
		"INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
	).run(
		"prt_g1",
		"msg_g1",
		"ses_g1",
		OLD,
		OLD,
		JSON.stringify({
			type: "tool",
			tool: "read",
			callID: "cg1",
			state: { status: "completed", input: { path: "x" }, output: "x".repeat(10_000) },
		}),
	);
	await runScan(db, loadState(statePath), deps, { statePath });
	const tool = hooks().find((p) => p.body.hook_event_name === "PostToolUse");
	expect((tool?.body.tool_response as string).length).toBeLessThanOrEqual(4_100);
	expect(tool?.body.tool_response as string).toContain("[truncated by opencode observer]");
});
