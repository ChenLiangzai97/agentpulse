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
	// HISTORICAL DDL: the pre-release 0015 (no FKs, no provider/native/generation
	// columns, no identity_json) exactly as released at commit 8849856.
	const { execSync } = await import("node:child_process");
	const historical = execSync("git show 8849856:drizzle/postgres/0015_fork_infra.sql", {
		encoding: "utf8",
	});
	await writeFile(join(oldDir, "0015_fork_infra.sql"), historical);
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
		// Lineage + ledger + a child binding + notes: all must survive.
		await scratch`
			INSERT INTO sessions (id, session_id, agent_type, cwd, notes)
			VALUES (${crypto.randomUUID()}, 'upgrade-child', 'opencode', '/tmp', 'keep my notes')
		`;
		await scratch`
			INSERT INTO opencode_forks (child_session_id, parent_session_id, request_action_id, parent_label_json)
			VALUES ('upgrade-child', 'upgrade-1', 'upgrade-action', '{"directParentSessionId":"upgrade-1"}')
		`;
		await scratch`
			INSERT INTO opencode_fork_requests (action_id, request_hash, parent_snapshot_json)
			VALUES ('upgrade-action', 'hash', '{"version":1,"messages":[]}')
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
		const [child] = (await scratch`
			SELECT child_session_id, parent_session_id FROM opencode_forks WHERE child_session_id = 'upgrade-child'
		`) as { child_session_id: string; parent_session_id: string | null }[];
		const [notes] = (await scratch`
			SELECT notes FROM sessions WHERE session_id = 'upgrade-child'
		`) as { notes: string }[];
		evidence.lineage = child ?? null;
		evidence.childNotes = notes?.notes ?? null;
		const fks = (await scratch`
			SELECT conname, confdeltype FROM pg_constraint
			WHERE conrelid = 'opencode_forks'::regclass AND contype = 'f'
			ORDER BY conname
		`) as { conname: string; confdeltype: string }[];
		evidence.forksFks = fks;
		const [ledger] = (await scratch`
			SELECT action_id FROM opencode_fork_requests WHERE action_id = 'upgrade-action'
		`) as { action_id: string }[];
		evidence.ledger = ledger ?? null;
		const [idem] = (await scratch`
			SELECT indexname FROM pg_indexes WHERE indexname = 'uq_fork_action_idem'
		`) as { indexname: string }[];
		evidence.idemIndex = idem ?? null;
		// Delete semantics: removing the parent session must SET NULL, not cascade.
		await scratch`DELETE FROM sessions WHERE session_id = 'upgrade-1'`;
		const [afterDelete] = (await scratch`
			SELECT parent_session_id FROM opencode_forks WHERE child_session_id = 'upgrade-child'
		`) as { parent_session_id: string | null }[];
		evidence.parentAfterDelete = afterDelete ?? null;
		// Deleting the child cascades its lineage row.
		await scratch`DELETE FROM sessions WHERE session_id = 'upgrade-child'`;
		const [childFork] = (await scratch`
			SELECT child_session_id FROM opencode_forks WHERE child_session_id = 'upgrade-child'
		`) as { child_session_id: string }[];
		evidence.childForkAfterDelete = childFork ?? null;
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
			Number(row?.stop_epoch) === 0 &&
			child?.parent_session_id === "upgrade-1" &&
			notes?.notes === "keep my notes" &&
			fks.some((fk) => fk.conname.endsWith("child_session_id_sessions_session_id_fk") && fk.confdeltype === "c") &&
			fks.some((fk) => fk.conname.endsWith("parent_session_id_sessions_session_id_fk") && fk.confdeltype === "n") &&
			Boolean(ledger) &&
			Boolean(idem) &&
			evidence.parentAfterDelete !== null &&
			(afterDelete?.parent_session_id ?? null) === null &&
			evidence.childForkAfterDelete === null;
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
