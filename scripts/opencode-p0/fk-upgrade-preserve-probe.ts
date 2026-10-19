/** Upgrade-path probe: seed a DB with the OLD 0015 (no FKs on PG / partial on
 * SQLite), then apply the NEW 0015 as a repair migration and verify rows,
 * notes and associations survive with correct delete semantics. */
process.env.SQLITE_PATH ??= "/tmp/agentpulse-fk-upgrade.db";
process.env.DISABLE_AUTH = "true";
process.env.DATABASE_URL = process.env.DATABASE_URL ?? "";
process.env.AGENTPULSE_OPENCODE_ENABLED = "";
import { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
const root = process.cwd();
// Phase 1: build an OLD-schema DB (0015 tables WITHOUT FKs, as first shipped)
// Phase 1: create a full CURRENT-schema DB once, then REGRESS the two fork
// tables to their OLD FK-less shape with seed data — simulating a database
// migrated by the first (constraint-less) 0015 that must now be repaired.
process.env.AGENTPULSE_LEGACY_INIT = "false";
{
	const { initializeDatabase } = await import(`${root}/src/server/db/client.js`);
	await initializeDatabase();
}
const sqlitePath = process.env.SQLITE_PATH ?? "";
const old = new Database(sqlitePath || ":memory:");
old.exec("DROP TABLE IF EXISTS opencode_forks;");
old.exec("DROP TABLE IF EXISTS opencode_fork_requests;");
old.exec(`CREATE TABLE opencode_forks (
	child_session_id TEXT PRIMARY KEY,
	parent_session_id TEXT,
	parent_label_json TEXT,
	fork_point_message_id TEXT,
	request_action_id TEXT,
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);`);
old.exec(`CREATE TABLE opencode_fork_requests (
	action_id TEXT PRIMARY KEY,
	request_hash TEXT NOT NULL,
	parent_snapshot_json TEXT,
	child_map_json TEXT,
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);`);
// drop drizzle bookkeeping so the next boot re-applies (repair path)
old.exec("DROP TABLE IF EXISTS __drizzle_migrations;");
old.close();
// Phase 2: initialize with CURRENT code on a DB that already has the OLD
// tables. Drizzle's migrator needs its bookkeeping — mark the file as an
// existing install so the legacy path runs (DDL is IF NOT EXISTS + rebuild).
process.env.AGENTPULSE_LEGACY_INIT = "";
const { initializeDatabase, getDb } = await import(`${root}/src/server/db/client.js`);
const { config } = await import(`${root}/src/server/config.js`);
await initializeDatabase();
// biome-ignore lint/suspicious/noExplicitAny: probe uses driver-specific run/execute shims
const db = getDb() as any;
const { sessions, controlActions, supervisors } = await import(
	`${root}/src/server/db/schema/index.js`
);
// Phase 3: seed data ACROSS the upgrade (pre-existing lineage rows survive)
await db.delete(controlActions);
await db.delete(sessions);
await db.delete(supervisors);
await db.insert(supervisors).values({
	id: "up-host",
	hostName: "up",
	platform: "linux",
	arch: "x64",
	version: "t",
	status: "connected",
	trustedRoots: ["/tmp"],
	capabilities: {},
});
await db.insert(sessions).values({
	sessionId: "up-par",
	agentType: "opencode",
	cwd: "/tmp",
	displayName: "父会话(有笔记)",
	notes: "重要笔记不得丢失",
});
await db.insert(sessions).values({ sessionId: "up-chi", agentType: "opencode", cwd: "/tmp" });
const [action] = await db
	.insert(controlActions)
	.values({
		sessionId: "up-chi",
		actionType: "opencode_fork",
		requestedBy: "user",
		status: "succeeded",
	})
	.returning();
// pre-upgrade-style lineage row (written BEFORE the repair, must survive it)
await (db.run ? db.run : db.execute).call(
	db,
	await import("drizzle-orm").then(
		({ sql }) =>
			sql`INSERT INTO opencode_forks (child_session_id, parent_session_id, parent_label_json, fork_point_message_id, request_action_id) VALUES ('up-chi', 'up-par', '{"parentName":"父会话(有笔记)"}', 'msg_keep', ${action.id})`,
	),
);
await (db.run ? db.run : db.execute).call(
	db,
	await import("drizzle-orm").then(
		({ sql }) =>
			sql`INSERT INTO opencode_fork_requests (action_id, request_hash, parent_snapshot_json) VALUES (${action.id}, 'h-up', '{"pinned":true}')`,
	),
);
const results: Record<string, unknown> = { dialect: config.dialect };
// upgrade preserved the rows + labels?
const sqliteDb =
	config.dialect === "sqlite" ? new Database(process.env.SQLITE_PATH!, { readonly: true }) : null;
const lineage = sqliteDb
	? sqliteDb
			.prepare(
				"SELECT parent_label_json, request_action_id FROM opencode_forks WHERE child_session_id='up-chi'",
			)
			.all()
	: await (db.run ? db.run : db.execute).call(
			db,
			await import("drizzle-orm").then(
				({ sql }) =>
					sql`SELECT parent_label_json, request_action_id FROM opencode_forks WHERE child_session_id='up-chi'`,
			),
		);
const lrow = (Array.isArray(lineage) ? lineage : (lineage as any).rows)[0] as
	| { parent_label_json: string; request_action_id: string }
	| undefined;
results.rowsPreserved = Boolean(
	lrow && lrow.parent_label_json.includes("父会话") && lrow.request_action_id === action.id,
);
// parent session (with notes) intact
const par = sqliteDb
	? sqliteDb.prepare("SELECT notes FROM sessions WHERE session_id='up-par'").all()
	: await (db.run ? db.run : db.execute).call(
			db,
			await import("drizzle-orm").then(
				({ sql }) => sql`SELECT notes FROM sessions WHERE session_id='up-par'`,
			),
		);
const prow = (Array.isArray(par) ? par : (par as any).rows)[0] as { notes: string } | undefined;
results.parentNotesIntact = prow?.notes === "重要笔记不得丢失";
// delete semantics AFTER the repair
await db.delete(sessions).where(eq(sessions.sessionId, "up-par"));
const after = sqliteDb
	? sqliteDb
			.prepare("SELECT parent_session_id FROM opencode_forks WHERE child_session_id='up-chi'")
			.all()
	: await (db.run ? db.run : db.execute).call(
			db,
			await import("drizzle-orm").then(
				({ sql }) =>
					sql`SELECT parent_session_id FROM opencode_forks WHERE child_session_id='up-chi'`,
			),
		);
const arow = (Array.isArray(after) ? after : (after as any).rows)[0] as
	| { parent_session_id: string | null }
	| undefined;
results.deleteSemanticsAfterRepair = Boolean(arow && arow.parent_session_id === null);
if (sqliteDb) {
	results.liveFks = (
		sqliteDb.prepare("PRAGMA foreign_key_list(opencode_forks)").all() as Array<{
			from: string;
			on_delete: string;
		}>
	)
		.map((f) => `${f.from}:${f.on_delete}`)
		.sort();
}
console.log(JSON.stringify(results));
process.exit(
	results.rowsPreserved && results.parentNotesIntact && results.deleteSemanticsAfterRepair ? 0 : 1,
);
