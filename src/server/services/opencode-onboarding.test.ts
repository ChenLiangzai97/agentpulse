import "../db/__test_db.js";
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { count, eq, like } from "drizzle-orm";
import { getDb, initializeDatabase } from "../db/client.js";
import { events, sessions } from "../db/schema/index.js";
import { OpenCodeObserver } from "./opencode-observer.js";
import { inspectOpenCodeSource } from "./opencode-source.js";

const dir = mkdtempSync(join(tmpdir(), "opencode-onboarding-"));
const path = join(dir, "history.db");
const writer = new Database(path);
writer.exec(`PRAGMA journal_mode=WAL;
 CREATE TABLE session(id TEXT PRIMARY KEY, title TEXT, directory TEXT, parent_id TEXT, time_created INTEGER, time_updated INTEGER, time_archived INTEGER);
 CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT, data TEXT, time_created INTEGER, time_updated INTEGER);
 CREATE TABLE part(id TEXT PRIMARY KEY, session_id TEXT, message_id TEXT, data TEXT, time_created INTEGER, time_updated INTEGER);`);
const stamp = 1700000000000;
writer.transaction(() => {
	for (let i = 0; i < 313; i++) {
		writer
			.query("INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?)")
			.run(
				`s${i}`,
				`History ${i}`,
				"/tmp/example-project",
				i ? "s0" : null,
				stamp + i,
				stamp + i,
				i % 2 ? stamp + i : null,
			);
		for (const role of ["user", "assistant"]) {
			const id = `${role}${i}`;
			writer
				.query("INSERT INTO message VALUES (?, ?, ?, ?, ?)")
				.run(
					id,
					`s${i}`,
					JSON.stringify({ role, time: { completed: stamp + i } }),
					stamp + i,
					stamp + i,
				);
			writer
				.query("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)")
				.run(
					`p${id}`,
					`s${i}`,
					id,
					JSON.stringify({ type: "text", text: `${role} text ${i}` }),
					stamp + i,
					stamp + i,
				);
		}
	}
})();
let observer: OpenCodeObserver;
beforeAll(async () => {
	await initializeDatabase();
	observer = new OpenCodeObserver(path, dir);
});
afterAll(() => {
	observer.close();
	writer.close();
	rmSync(dir, { recursive: true, force: true });
});

test("preflight counts all 313 WAL sessions without importing or creating missing sources", async () => {
	expect(inspectOpenCodeSource(path)).toMatchObject({
		adapter: "v1",
		schemaCompatible: true,
		observeOnly: true,
		counts: { session: 313, message: 626, part: 626 },
	});
	expect(
		await getDb()
			.select()
			.from(sessions)
			.where(eq(sessions.sessionId, observer.sessionId("s0"))),
	).toEqual([]);
	const missing = join(dir, "missing.db");
	expect(() => inspectOpenCodeSource(missing)).toThrow();
	expect(existsSync(missing)).toBe(false);
});

test("imports all 313 sessions, including archives, and restart replays without duplicates", async () => {
	expect(await observer.sync()).toEqual({ sessions: 313, changedEvents: 626 });
	const scope = `opencode:${observer.instanceId}:%`;
	expect(
		await getDb().select({ n: count() }).from(sessions).where(like(sessions.sessionId, scope)),
	).toEqual([{ n: 313 }]);
	expect(
		await getDb().select({ n: count() }).from(events).where(like(events.sessionId, scope)),
	).toEqual([{ n: 626 }]);
	expect(
		(
			await getDb()
				.select()
				.from(sessions)
				.where(eq(sessions.sessionId, observer.sessionId("s1")))
		)[0].isArchived,
	).toBe(true);
	observer.close();
	observer = new OpenCodeObserver(path, dir);
	expect(await observer.sync()).toEqual({ sessions: 313, changedEvents: 0 });
	expect(
		await getDb().select({ n: count() }).from(events).where(like(events.sessionId, scope)),
	).toEqual([{ n: 626 }]);
}, 15000);

test("additive live migration replays older sessions without needing their timestamps to change", async () => {
	writer.exec("ALTER TABLE session ADD COLUMN tokens_input INTEGER DEFAULT 42");
	expect(inspectOpenCodeSource(path).schemaCompatible).toBe(true);
	expect(await observer.sync()).toEqual({ sessions: 313, changedEvents: 0 });
	const [session] = await getDb()
		.select()
		.from(sessions)
		.where(eq(sessions.sessionId, observer.sessionId("s0")));
	expect(session.metadata).toMatchObject({ opencode: { tokens: { input: 42 } } });
}, 15000);

test("breaking live migration fails before destination writes and resumes after schema repair", async () => {
	writer.exec("ALTER TABLE part RENAME COLUMN data TO incompatible_payload");
	expect(() => inspectOpenCodeSource(path)).toThrow(
		"Unsupported OpenCode schema: part missing data",
	);
	writer.query("UPDATE session SET title='must not import' WHERE id='s0'").run();
	await expect(observer.sync()).rejects.toThrow("Unsupported OpenCode schema");
	const [session] = await getDb()
		.select()
		.from(sessions)
		.where(eq(sessions.sessionId, observer.sessionId("s0")));
	expect(session.displayName).toBe("History 0");
	writer.exec("ALTER TABLE part RENAME COLUMN incompatible_payload TO data");
	expect((await observer.sync()).sessions).toBe(313);
}, 15000);

test("--check is independent of the destination and returns a nonzero status for incompatible sources", () => {
	const destination = join(dir, "must-not-create", "destination.db");
	const run = (source: string) =>
		Bun.spawnSync([process.execPath, "scripts/observe-opencode.ts", "--check"], {
			cwd: process.cwd(),
			env: {
				...process.env,
				SQLITE_PATH: destination,
				DATA_DIR: join(dir, "must-not-create"),
				AGENTPULSE_OPENCODE_DB: source,
				DATABASE_URL: "postgres://invalid.example.invalid/unused",
			},
		});
	const ok = run(path);
	expect(ok.exitCode).toBe(0);
	expect(JSON.parse(ok.stdout.toString()).counts.session).toBe(313);
	expect(existsSync(join(dir, "must-not-create"))).toBe(false);
	const bad = run(join(dir, "not-found.db"));
	expect(bad.exitCode).toBe(1);
	expect(JSON.parse(bad.stderr.toString()).schemaCompatible).toBe(false);
	expect(existsSync(join(dir, "not-found.db"))).toBe(false);
});
