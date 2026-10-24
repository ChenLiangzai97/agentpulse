/** FK integrity probe: delete semantics + orphan rejection + rebuild consistency, both engines. */
process.env.SQLITE_PATH ??= "/tmp/agentpulse-fk-integrity.db";
process.env.DISABLE_AUTH = "true";
process.env.DATABASE_URL = process.env.DATABASE_URL ?? "";
process.env.AGENTPULSE_OPENCODE_ENABLED = "";
import { eq } from "drizzle-orm";
const { initializeDatabase, getDb } = await import(
	"/home/ch/project/work_station/agentpulse/src/server/db/client.js"
);
const { config } = await import("/home/ch/project/work_station/agentpulse/src/server/config.js");
await initializeDatabase();
const db = getDb() as any;
const raw = (q: any) => (db.run ? db.run(q) : db.execute(q));
const readAll = async (q: any): Promise<any[]> => {
	// pg: drizzle execute() returns the driver result — postgres-js gives an
	// array-like of rows directly on PG.
	const r = await raw(q);
	if (Array.isArray(r)) return r;
	if (r && Array.isArray(r.rows)) return r.rows;
	return [];
};
const { sessions, controlActions, supervisors } = await import(
	"/home/ch/project/work_station/agentpulse/src/server/db/schema/index.js"
);
await db
	.execute(await import("drizzle-orm").then(({ sql }) => sql`DELETE FROM opencode_fork_requests`))
	.catch(() => {});
await db
	.execute(await import("drizzle-orm").then(({ sql }) => sql`DELETE FROM opencode_forks`))
	.catch(() => {});
await db.delete(controlActions);
await db.delete(sessions);
await db.delete(supervisors);
// seed: parent + child sessions, one control action, lineage row + ledger row
await db.insert(sessions).values({ sessionId: "fk-par", agentType: "opencode", cwd: "/tmp" });
await db.insert(sessions).values({ sessionId: "fk-chi", agentType: "opencode", cwd: "/tmp" });
await db
	.insert(supervisors)
	.values({
		id: "fki-host",
		hostName: "fki",
		platform: "linux",
		arch: "x64",
		version: "t",
		status: "connected",
		trustedRoots: ["/tmp"],
		capabilities: {},
	});
await db.insert(sessions).values({ sessionId: "fki-sess", agentType: "opencode", cwd: "/tmp" });
const [action] = await db
	.insert(controlActions)
	.values({
		sessionId: "fki-sess",
		actionType: "opencode_fork",
		requestedBy: "user",
		idempotencyKey: null,
		status: "queued",
	})
	.returning();
await raw(
	await import("drizzle-orm").then(
		({ sql }) =>
			sql`INSERT INTO opencode_forks (child_session_id, parent_session_id, fork_point_message_id, request_action_id) VALUES ('fk-chi', 'fk-par', 'msg_x', ${action.id})`,
	),
);
await raw(
	await import("drizzle-orm").then(
		({ sql }) =>
			sql`INSERT INTO opencode_fork_requests (action_id, request_hash) VALUES (${action.id}, 'h1')`,
	),
);
const results: Record<string, unknown> = { dialect: config.dialect };
// orphan lineage insert must be rejected
try {
	await raw(
		await import("drizzle-orm").then(
			({ sql }) =>
				sql`INSERT INTO opencode_forks (child_session_id, parent_session_id) VALUES ('no-such-child', 'fk-par')`,
		),
	);
	results.orphanRejected = false;
} catch {
	results.orphanRejected = true;
}
// delete parent → parent ref NULL, child lineage retained
await db.delete(sessions).where(eq(sessions.sessionId, "fk-par"));
const { Database: RawDb } = await import("bun:sqlite");
const sqliteDb =
	config.dialect === "sqlite" ? new RawDb(process.env.SQLITE_PATH!, { readonly: true }) : null;
const lineage = {
	rows: sqliteDb
		? sqliteDb
				.prepare(
					"SELECT child_session_id, parent_session_id FROM opencode_forks WHERE child_session_id = 'fk-chi'",
				)
				.all()
		: await readAll(
				await import("drizzle-orm").then(
					({ sql }) =>
						sql`SELECT child_session_id, parent_session_id FROM opencode_forks WHERE child_session_id = 'fk-chi'`,
				),
			),
};
const row = lineage.rows[0] as
	| { child_session_id: string; parent_session_id: string | null }
	| undefined;
results.parentDelete = row
	? { kept: true, parentNull: row.parent_session_id === null }
	: { kept: false };
// delete action → ledger row gone
if (config.dialect === "postgres") {
	await raw(
		await import("drizzle-orm").then(
			({ sql }) => sql`DELETE FROM control_actions WHERE id = ${action.id}`,
		),
	);
} else {
	await db.delete(controlActions).where(eq(controlActions.id, action.id));
}
const ledger = {
	rows: sqliteDb
		? sqliteDb.prepare("SELECT count(*) c FROM opencode_fork_requests").all()
		: await readAll(
				await import("drizzle-orm").then(
					({ sql }) => sql`SELECT count(*) c FROM opencode_fork_requests`,
				),
			),
};
results.ledgerGoneWithAction = Number((ledger.rows[0] as { c: string | number }).c) === 0;
// delete child → lineage row gone
if (config.dialect === "postgres") {
	await raw(
		await import("drizzle-orm").then(
			({ sql }) => sql`DELETE FROM sessions WHERE session_id = 'fk-chi'`,
		),
	);
} else {
	await db.delete(sessions).where(eq(sessions.sessionId, "fk-chi"));
}
const afterChild = {
	rows: sqliteDb
		? sqliteDb.prepare("SELECT count(*) c FROM opencode_forks").all()
		: await readAll(
				await import("drizzle-orm").then(({ sql }) => sql`SELECT count(*) c FROM opencode_forks`),
			),
};
results.lineageGoneWithChild = Number((afterChild.rows[0] as { c: string | number }).c) === 0;
// SQLite: FK set on the LIVE table (post-rebuild)
if (config.dialect === "sqlite") {
	const { Database } = await import("bun:sqlite");
	const raw = new Database(process.env.SQLITE_PATH!, { readonly: true });
	const fks = raw.prepare("PRAGMA foreign_key_list(opencode_forks)").all() as Array<{
		from: string;
		on_delete: string;
	}>;
	results.sqliteFks = fks.map((f) => `${f.from}:${f.on_delete}`).sort();
}
console.log(JSON.stringify(results));
process.exit(
	Object.values(results).every(
		(v) =>
			v !== false &&
			!(
				typeof v === "object" &&
				v &&
				"kept" in (v as object) &&
				(v as { kept: boolean }).kept === false
			),
	)
		? 0
		: 1,
);
