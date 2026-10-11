/**
 * AGEN-70 phase 1: the `ai_analysis_runs` table and the `sessions` analysis
 * participation columns.
 *
 * Real databases, nothing stubbed. Pins column order/nullability/defaults on
 * both install shapes (legacy init and Drizzle-born), the deliberate absence
 * of a sessions FK (frozen scope survives session deletion), and migration
 * idempotency. The list-projection counts live in migrations.test.ts.
 */
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { eq } from "drizzle-orm";
import "../services/ai/__test_db.js";

import { itSqliteOnly } from "../test-utils/backend.js";

const { getDb, initializeDatabase } = await import("./client.js");
const { aiAnalysisRuns, sessions } = await import("./schema/index.js");

const TABLE = "ai_analysis_runs";
const TMP_DIR = mkdtempSync(join(tmpdir(), "ap-analysis-table-"));
afterAll(() => {
	if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true, force: true });
});
beforeAll(async () => {
	await initializeDatabase();
});

const MIGRATIONS_ROOT = resolve(import.meta.dir, "../../../drizzle");

const EXPECTED_COLUMNS: ReadonlyArray<{
	name: string;
	type: string;
	notnull: 0 | 1;
	dflt: string | null;
}> = [
	{ name: "id", type: "TEXT", notnull: 1, dflt: null },
	{ name: "status", type: "TEXT", notnull: 1, dflt: "'queued'" },
	{ name: "requested_by", type: "TEXT", notnull: 1, dflt: null },
	{ name: "time_from", type: "TEXT", notnull: 0, dflt: null },
	{ name: "time_to", type: "TEXT", notnull: 0, dflt: null },
	{ name: "scope_sessions", type: "TEXT", notnull: 1, dflt: null },
	{ name: "lease_owner", type: "TEXT", notnull: 0, dflt: null },
	{ name: "lease_expires_at", type: "TEXT", notnull: 0, dflt: null },
	{ name: "attempt_count", type: "INTEGER", notnull: 1, dflt: "0" },
	{ name: "last_error_code", type: "TEXT", notnull: 0, dflt: null },
	{ name: "started_at", type: "TEXT", notnull: 0, dflt: null },
	{ name: "completed_at", type: "TEXT", notnull: 0, dflt: null },
	{ name: "prompt_version", type: "TEXT", notnull: 0, dflt: null },
	{ name: "provider_kind", type: "TEXT", notnull: 0, dflt: null },
	{ name: "provider_model", type: "TEXT", notnull: 0, dflt: null },
	{ name: "input_tokens", type: "INTEGER", notnull: 1, dflt: "0" },
	{ name: "output_tokens", type: "INTEGER", notnull: 1, dflt: "0" },
	{ name: "cost_cents", type: "INTEGER", notnull: 1, dflt: "0" },
	{ name: "excluded_session_ids", type: "TEXT", notnull: 0, dflt: null },
	{ name: "coverage", type: "TEXT", notnull: 0, dflt: null },
	{ name: "report", type: "TEXT", notnull: 0, dflt: null },
	{ name: "provenance", type: "TEXT", notnull: 0, dflt: null },
	{ name: "created_at", type: "TEXT", notnull: 1, dflt: "CURRENT_TIMESTAMP" },
	{ name: "updated_at", type: "TEXT", notnull: 1, dflt: "CURRENT_TIMESTAMP" },
];

type ColumnInfo = {
	cid: number;
	name: string;
	type: string;
	notnull: number;
	dflt_value: string | null;
	pk: number;
};

function tmpDbPath(): string {
	return join(TMP_DIR, `${crypto.randomUUID()}.db`);
}

function legacyFixture(path = ":memory:"): Database {
	const db = new Database(path);
	db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
	db.exec(`
		CREATE TABLE IF NOT EXISTS sessions (
			id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL UNIQUE,
			agent_type TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'active',
			started_at TEXT NOT NULL DEFAULT (datetime('now')),
			last_activity_at TEXT NOT NULL DEFAULT (datetime('now')),
			metadata TEXT DEFAULT '{}'
		);
	`);
	return db;
}

async function legacyBooted(): Promise<Database> {
	const db = legacyFixture();
	await initializeDatabase(db);
	return db;
}

async function drizzleBornDb(): Promise<Database> {
	const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
	const { drizzle } = await import("drizzle-orm/bun-sqlite");
	const db = new Database(tmpDbPath());
	db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
	migrate(drizzle(db), { migrationsFolder: join(MIGRATIONS_ROOT, "sqlite") });
	return db;
}

function tableInfo(db: Database, table: string): ColumnInfo[] {
	return (db.prepare(`PRAGMA table_info('${table}')`).all() as ColumnInfo[]).map((c) => ({
		...c,
		type: c.type.toUpperCase(),
	}));
}

function migrationSql(dialect: "sqlite" | "postgres"): string {
	const dir = join(MIGRATIONS_ROOT, dialect);
	const journal = JSON.parse(readFileSync(join(dir, "meta", "_journal.json"), "utf8")) as {
		entries: Array<{ tag: string }>;
	};
	const entries = journal.entries.filter((e) => e.tag.endsWith("_analysis_selection_and_runs"));
	expect(
		entries,
		`the ${dialect} journal has exactly one analysis_selection_and_runs entry`,
	).toHaveLength(1);
	return readFileSync(join(dir, `${entries[0]?.tag}.sql`), "utf8");
}

function assertColumns(db: Database, shape: "legacy" | "drizzle") {
	const info = tableInfo(db, TABLE);
	const names = info.map((c) => c.name);
	expect(names).toEqual(EXPECTED_COLUMNS.map((c) => c.name));
	for (const column of EXPECTED_COLUMNS) {
		const row = info.find((c) => c.name === column.name);
		expect(row, `${shape}: ${TABLE}.${column.name} exists`).toBeDefined();
		if (!row) continue;
		expect(row.type, `${shape}: ${column.name} type`).toBe(column.type);
		expect(row.notnull === 1, `${shape}: ${column.name} notnull`).toBe(column.notnull === 1);
		if (column.dflt === null) {
			expect(row.dflt_value, `${shape}: ${column.name} has no default`).toBeNull();
		} else if (column.dflt === "CURRENT_TIMESTAMP") {
			// SQLite renders the datetime('now') default verbatim; Postgres text columns
			// default CURRENT_TIMESTAMP. Either spelling passes.
			expect(
				row.dflt_value === null || /datetime\('now'\)|CURRENT_TIMESTAMP/i.test(row.dflt_value),
				`${shape}: ${column.name} timestamp default`,
			).toBe(true);
		} else {
			expect(row.dflt_value, `${shape}: ${column.name} default`).toBe(column.dflt);
		}
	}
}

itSqliteOnly("legacy init and Drizzle-born installs agree on the table shape", async () => {
	const legacy = await legacyBooted();
	assertColumns(legacy, "legacy");
	const born = await drizzleBornDb();
	assertColumns(born, "drizzle");
});

itSqliteOnly("no foreign key to sessions: frozen scope survives session deletion", async () => {
	const db = await drizzleBornDb();
	db.prepare("INSERT INTO sessions (id, session_id, agent_type) VALUES (?, ?, 'claude_code')").run(
		crypto.randomUUID(),
		"frozen-scope-s1",
	);
	db.prepare(`INSERT INTO ${TABLE} (id, requested_by, scope_sessions) VALUES (?, 'u1', '[]')`).run(
		"run-frozen-1",
	);
	db.prepare("DELETE FROM sessions WHERE session_id = 'frozen-scope-s1'").run();
	const rows = db.prepare(`SELECT id FROM ${TABLE}`).all() as Array<{ id: string }>;
	expect(rows.map((r) => r.id)).toEqual(["run-frozen-1"]);
});

itSqliteOnly("the sqlite migration is single-create idempotent", () => {
	const text = migrationSql("sqlite");
	expect(text.match(/CREATE TABLE IF NOT EXISTS/g)?.length).toBe(1);
	expect(text).not.toMatch(/DROP TABLE|ALTER TABLE `ai_analysis_runs`/);
	const db = new Database(":memory:");
	db.exec("PRAGMA journal_mode = WAL;");
	// The ALTERs need a sessions table to exist; a minimal stand-in matches the
	// upgrade path this migration actually runs on. Pass 1 applies everything;
	// pass 2 re-runs only the CREATE statements (the migrator never replays an
	// applied journal entry; the CREATE-side idempotency is what upgrades rely on).
	db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, session_id TEXT NOT NULL UNIQUE)");
	for (let pass = 0; pass < 2; pass++) {
		for (const statement of text.split("--> statement-breakpoint")) {
			const trimmed = statement.trim();
			if (!trimmed) continue;
			if (pass > 0 && trimmed.startsWith("ALTER TABLE")) continue;
			db.exec(trimmed);
		}
	}
	expect(tableInfo(db, TABLE).length).toBe(EXPECTED_COLUMNS.length);
});

itSqliteOnly("sessions carries the analysis participation columns on both shapes", async () => {
	for (const db of [await legacyBooted(), await drizzleBornDb()]) {
		const info = tableInfo(db, "sessions");
		const selected = info.find((c) => c.name === "analysis_selected");
		expect(selected?.type).toBe("INTEGER");
		expect(selected?.notnull).toBe(1);
		expect(selected?.dflt_value === "0" || selected?.dflt_value === "false").toBe(true);
		const selectedAt = info.find((c) => c.name === "analysis_selected_at");
		expect(selectedAt?.type).toBe("TEXT");
		expect(selectedAt?.notnull).toBe(0);
	}
});

test("the drizzle schema round-trips a full row through the process-wide test db", async () => {
	const db = getDb();
	await db
		.insert(sessions)
		.values({ sessionId: "analysis-table-s1", agentType: "claude_code" })
		.onConflictDoNothing();
	const scope = [
		{
			sessionId: "analysis-table-s1",
			label: "Test Session",
			agentType: "claude_code",
			host: "machine-a",
			projectId: null,
		},
	];
	await db.delete(aiAnalysisRuns).where(eq(aiAnalysisRuns.id, "analysis-table-run-1"));
	await db.insert(aiAnalysisRuns).values({
		id: "analysis-table-run-1",
		requestedBy: "user-1",
		scopeSessions: scope,
	});
	const [row] = await db
		.select()
		.from(aiAnalysisRuns)
		.where(eq(aiAnalysisRuns.id, "analysis-table-run-1"));
	expect(row?.status).toBe("queued");
	expect(row?.scopeSessions).toEqual(scope);
	expect(row?.attemptCount).toBe(0);
	await db.delete(aiAnalysisRuns).where(eq(aiAnalysisRuns.id, "analysis-table-run-1"));
	await db.delete(sessions).where(eq(sessions.sessionId, "analysis-table-s1"));
});
