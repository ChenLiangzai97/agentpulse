/**
 * PG upgrade probe: a database that already applied migrations up to 0015 must
 * keep its data when 0016 (protected stop epoch) is applied.
 *
 * Uses a scratch database on the server named by AGENTPULSE_PG_PROBE_URL.
 * Writes pg-upgrade-evidence.json next to this script.
 */
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const baseUrl = process.env.AGENTPULSE_PG_PROBE_URL;
if (!baseUrl) {
	console.error("set AGENTPULSE_PG_PROBE_URL (e.g. postgres://user@127.0.0.1:4521/postgres?sslmode=disable)");
	process.exit(2);
}
const probe = `ap_upgrade_probe_${crypto.randomUUID().replaceAll("-", "_")}`;
const url = new URL(baseUrl);
const withDatabase = (database: string) => {
	const next = new URL(baseUrl);
	next.pathname = `/${database}`;
	return next.toString();
};
const evidence: Record<string, unknown> = { probe };

const admin = postgres(baseUrl, { max: 1, onnotice: () => {} });
try {
	await admin.unsafe(`CREATE DATABASE "${probe}"`);
	const oldDir = await mkdtemp(join(tmpdir(), "ap-migrations-old-"));
	await cp("drizzle/postgres", oldDir, { recursive: true });
	await rm(join(oldDir, "0016_session_stop_epoch.sql"));
	const journal = JSON.parse(await readFile(join(oldDir, "meta/_journal.json"), "utf8")) as {
		entries: { tag: string }[];
	};
	journal.entries = journal.entries.filter((entry) => entry.tag !== "0016_session_stop_epoch");
	await writeFile(join(oldDir, "meta/_journal.json"), JSON.stringify(journal));

	const scratch = postgres(withDatabase(probe), { max: 1, onnotice: () => {} });
	try {
		// 1) Up to 0015 (the pre-stop-epoch schema).
		await migrate(drizzle(scratch), { migrationsFolder: oldDir });
		const before = (await scratch`
			SELECT column_name FROM information_schema.columns
			WHERE table_name = 'session_control_bindings'
		`) as { column_name: string }[];
		evidence.columnsBefore = before.map((row) => row.column_name).sort();
		await scratch`
			INSERT INTO sessions (id, session_id, agent_type, cwd)
			VALUES (${crypto.randomUUID()}, 'upgrade-1', 'opencode', '/tmp')
		`;
		await scratch`
			INSERT INTO session_control_bindings (session_id, origin, native_session_id, generation)
			VALUES ('upgrade-1', 'external_observer', NULL, NULL)
		`;
		await rm(oldDir, { recursive: true, force: true });

		// 2) Apply the REAL migrations (adds 0016).
		await migrate(drizzle(scratch), { migrationsFolder: "drizzle/postgres" });
		const after = (await scratch`
			SELECT column_name FROM information_schema.columns
			WHERE table_name = 'session_control_bindings'
		`) as { column_name: string }[];
		evidence.columnsAfter = after.map((row) => row.column_name).sort();
		const [row] = (await scratch`
			SELECT session_id, stop_state, stop_epoch FROM session_control_bindings WHERE session_id = 'upgrade-1'
		`) as { session_id: string; stop_state: string; stop_epoch: number }[];
		evidence.preservedRow = row ?? null;
		// 3) The protected-row lock path works on PG.
		await scratch.begin(async (tx) => {
			await tx`SELECT session_id FROM session_control_bindings WHERE session_id = 'upgrade-1' FOR UPDATE`;
		});
		evidence.forUpdate = true;
		evidence.ok =
			evidence.columnsAfter instanceof Array &&
			(evidence.columnsAfter as string[]).includes("stop_state") &&
			(evidence.columnsAfter as string[]).includes("stop_epoch") &&
			row?.stop_state === "active" &&
			Number(row?.stop_epoch) === 0;
	} finally {
		await scratch.end({ timeout: 5 }).catch(() => {});
	}
} finally {
	await admin.unsafe(`DROP DATABASE IF EXISTS "${probe}"`).catch(() => {});
	await admin.end({ timeout: 5 }).catch(() => {});
}
await writeFile(join(import.meta.dir, "pg-upgrade-evidence.json"), JSON.stringify(evidence, null, 1));
console.log(JSON.stringify(evidence, null, 1));
if (evidence.ok !== true) process.exit(1);
