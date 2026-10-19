/** Upgrade-path probe, CORRECT ORDER (round 35): seed FIRST in the old shape,
 *  upgrade in a SEPARATE process from a real supported entry point (the legacy
 *  migration ledger INTACT — no __drizzle_migrations deletion), then verify in
 *  a THIRD process by comparing against a baseline snapshot written before the
 *  upgrade. Usage: bun scripts/opencode-p0/fk-upgrade-v2-probe.ts <seed|upgrade|verify>
 */
process.env.SQLITE_PATH ??= "/tmp/agentpulse-fk-upgrade-v2.db";
process.env.DISABLE_AUTH = "true";
process.env.DATABASE_URL = process.env.DATABASE_URL ?? "";
process.env.AGENTPULSE_OPENCODE_ENABLED = "";
process.env.AGENTPULSE_OPENCODE_DB = "";
const PHASE = process.argv[2] as "seed" | "upgrade" | "verify";
const BASELINE = `${process.env.SQLITE_PATH}.baseline.json`;
const root = process.cwd();
import { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";

if (PHASE === "seed") {
	// Phase 1 (own process): build a current-schema DB, then REGRESS the fork
	// tables to the FK-less first-0015 shape AND WRITE ALL SEED DATA — the
	// ledger (__drizzle_migrations) stays as the old install left it.
	process.env.AGENTPULSE_LEGACY_INIT = "false";
	{
		const { initializeDatabase } = await import(`${root}/src/server/db/client.js`);
		await initializeDatabase();
	}
	const db = new Database(process.env.SQLITE_PATH ?? ":memory:");
	db.exec("DROP TABLE IF EXISTS opencode_forks;");
	db.exec("DROP TABLE IF EXISTS opencode_fork_requests;");
	db.exec(`CREATE TABLE opencode_forks (
		child_session_id TEXT PRIMARY KEY,
		parent_session_id TEXT,
		parent_label_json TEXT,
		fork_point_message_id TEXT,
		request_action_id TEXT,
		created_at TEXT NOT NULL DEFAULT (datetime('now'))
	);`);
	db.exec(`CREATE TABLE opencode_fork_requests (
		action_id TEXT PRIMARY KEY,
		request_hash TEXT NOT NULL,
		parent_snapshot_json TEXT,
		child_map_json TEXT,
		created_at TEXT NOT NULL DEFAULT (datetime('now'))
	);`);
	db.close();

	const { getDb } = await import(`${root}/src/server/db/client.js`);
	const g = getDb() as unknown as {
		insert: (t: unknown) => { values: (v: unknown) => { returning: () => Promise<unknown[]> } };
		delete: (t: unknown) => { where: (c: unknown) => Promise<unknown> };
		update: (t: unknown) => { set: (v: unknown) => { where: (c: unknown) => Promise<unknown> } };
	};
	const { sessions, controlActions, supervisors } = await import(
		`${root}/src/server/db/schema/index.js`
	);
	// clean only our own seed rows (scoped deletes, correct columns)
	await g
		.delete(controlActions)
		.where(eq((controlActions as unknown as { sessionId: unknown }).sessionId, "seed-chi"));
	await g.delete(sessions).where(eq(sessions.sessionId, "seed-par"));
	await g.delete(sessions).where(eq(sessions.sessionId, "seed-chi"));
	await g.delete(supervisors).where(eq(supervisors.id, "seed-host"));
	await g
		.insert(supervisors)
		.values({
			id: "seed-host",
			hostName: "seed",
			platform: "linux",
			arch: "x64",
			version: "t",
			status: "connected",
			trustedRoots: ["/tmp"],
			capabilities: {},
		});
	await g
		.insert(sessions)
		.values({
			sessionId: "seed-par",
			agentType: "opencode",
			cwd: "/tmp",
			displayName: "父会话(基线)",
			notes: "基线笔记:升级不得丢失",
		});
	await g.insert(sessions).values({ sessionId: "seed-chi", agentType: "opencode", cwd: "/tmp" });
	const action = (await g
		.insert(controlActions)
		.values({
			sessionId: "seed-chi",
			actionType: "opencode_fork",
			requestedBy: "user",
			status: "succeeded",
		})
		.returning()) as Array<{ id: string }>;
	const { sql } = await import("drizzle-orm");
	const run = (q: unknown) => (g as unknown as { run: (q: unknown) => Promise<unknown> }).run(q);
	await run(
		sql`INSERT INTO opencode_forks (child_session_id, parent_session_id, parent_label_json, fork_point_message_id, request_action_id) VALUES ('seed-chi', 'seed-par', '{"parentName":"父会话(基线)"}', 'msg_base', ${action[0].id})`,
	);
	await run(
		sql`INSERT INTO opencode_fork_requests (action_id, request_hash, parent_snapshot_json) VALUES (${action[0].id}, 'h-seed', '{"pinned":true}')`,
	);

	// baseline snapshot — written BEFORE the upgrade process ever runs
	const raw = new Database(process.env.SQLITE_PATH ?? ":memory:", { readonly: true });
	const baseline = {
		lineage: raw
			.prepare(
				"SELECT child_session_id, parent_session_id, parent_label_json, request_action_id FROM opencode_forks",
			)
			.all(),
		ledger: raw.prepare("SELECT action_id, request_hash FROM opencode_fork_requests").all(),
		parentNotes: raw.prepare("SELECT notes FROM sessions WHERE session_id='seed-par'").all(),
	};
	await Bun.write(BASELINE, JSON.stringify(baseline));
	console.log("SEEDED baseline:", JSON.stringify(baseline).slice(0, 160));
	process.exit(0);
}

if (PHASE === "upgrade") {
	// Phase 2 (OWN process, real entry point): boot current code on the seeded
	// old-shape DB. The sessions table exists → legacy-init path runs its
	// migration array + FK rebuild; we do NOT touch __drizzle_migrations here.
	// (The old ledger is irrelevant to the legacy path; the FK rebuild is the
	// supported repair entry for legacy installs.)
	delete process.env.AGENTPULSE_LEGACY_INIT;
	const { initializeDatabase } = await import(`${root}/src/server/db/client.js`);
	await initializeDatabase();
	console.log("UPGRADE DONE");
	process.exit(0);
}

if (PHASE === "verify") {
	// Phase 3 (own process): compare the live DB against the pre-upgrade
	// baseline, then exercise delete semantics.
	const { initializeDatabase, getDb } = await import(`${root}/src/server/db/client.js`);
	await initializeDatabase();
	const g = getDb() as unknown as {
		delete: (t: unknown) => { where: (c: unknown) => Promise<unknown> };
	};
	const baseline = JSON.parse(await Bun.file(BASELINE).text()) as {
		lineage: Array<{
			child_session_id: string;
			parent_session_id: string;
			parent_label_json: string;
			request_action_id: string;
		}>;
		ledger: Array<{ action_id: string; request_hash: string }>;
		parentNotes: Array<{ notes: string }>;
	};
	const raw = new Database(process.env.SQLITE_PATH ?? ":memory:", { readonly: true });
	const results: Record<string, unknown> = {};
	const liveLineage = raw
		.prepare(
			"SELECT child_session_id, parent_session_id, parent_label_json, request_action_id FROM opencode_forks",
		)
		.all();
	results.lineagePreservedAcrossUpgrade =
		liveLineage.length === baseline.lineage.length &&
		liveLineage.every((r: unknown) => {
			const row = r as { child_session_id: string; parent_label_json: string };
			const base = baseline.lineage.find((b) => b.child_session_id === row.child_session_id);
			return base && base.parent_label_json === row.parent_label_json;
		});
	const liveLedger = raw
		.prepare("SELECT action_id, request_hash FROM opencode_fork_requests")
		.all();
	results.ledgerPreservedAcrossUpgrade =
		liveLedger.length === baseline.ledger.length &&
		(liveLedger[0] as { request_hash: string } | undefined)?.request_hash ===
			baseline.ledger[0]?.request_hash;
	const liveNotes = raw.prepare("SELECT notes FROM sessions WHERE session_id='seed-par'").all();
	results.parentNotesPreserved =
		(liveNotes[0] as { notes: string } | undefined)?.notes === baseline.parentNotes[0]?.notes;
	// delete semantics AFTER the repair
	const { sessions } = await import(`${root}/src/server/db/schema/index.js`);
	await g.delete(sessions).where(eq(sessions.sessionId, "seed-par"));
	const after = raw
		.prepare("SELECT parent_session_id FROM opencode_forks WHERE child_session_id='seed-chi'")
		.all();
	results.deleteSemanticsAfterRepair =
		(after[0] as { parent_session_id: string | null } | undefined)?.parent_session_id === null;
	results.liveFks = (
		raw.prepare("PRAGMA foreign_key_list(opencode_forks)").all() as Array<{
			from: string;
			on_delete: string;
		}>
	)
		.map((f) => `${f.from}:${f.on_delete}`)
		.sort();
	console.log(JSON.stringify(results));
	const pass =
		results.lineagePreservedAcrossUpgrade &&
		results.ledgerPreservedAcrossUpgrade &&
		results.parentNotesPreserved &&
		results.deleteSemanticsAfterRepair;
	process.exit(pass ? 0 : 1);
}

throw new Error("usage: fk-upgrade-v2-probe.ts <seed|upgrade|verify>");
