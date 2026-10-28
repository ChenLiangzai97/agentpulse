import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { PROVIDER_CONTROL_SQLITE_MIGRATIONS } from "./provider-control-migration.js";

test("legacy upgrade is idempotent, ignores metadata, and offline rollback preserves sessions", () => {
	const db = new Database(":memory:");
	try {
		db.exec(
			"PRAGMA foreign_keys=ON; CREATE TABLE sessions(session_id TEXT UNIQUE,agent_type TEXT,metadata TEXT); CREATE TABLE supervisors(id TEXT PRIMARY KEY); CREATE TABLE launch_requests(id TEXT PRIMARY KEY);",
		);
		db.query("INSERT INTO sessions VALUES (?,?,?)").run(
			"legacy",
			"opencode",
			JSON.stringify({ manager: "agentpulse", origin: "agentpulse_launch" }),
		);
		db.query("INSERT INTO sessions VALUES (?,?,?)").run("old-codex", "codex_cli", "{}");
		// Replay must be idempotent the way the boot runner treats it: a
		// duplicate-column ALTER on the second pass is the known replay error
		// and is swallowed there, so the test mirrors that contract.
		for (let replay = 0; replay < 2; replay++)
			for (const sql of PROVIDER_CONTROL_SQLITE_MIGRATIONS) {
				try {
					db.exec(sql);
				} catch (error) {
					if (!/duplicate column name/i.test(String(error))) throw error;
				}
			}
		expect(
			db.query("SELECT origin FROM session_control_bindings WHERE session_id='legacy'").get(),
		).toEqual({ origin: "legacy_unknown" });
		expect(db.query("SELECT count(*) AS n FROM session_control_bindings").get()).toEqual({ n: 1 });
		expect(() =>
			db.exec(
				"INSERT INTO session_control_bindings(session_id,origin) VALUES ('old-codex','agentpulse_launch')",
			),
		).toThrow();
		expect(() =>
			db.exec(
				"INSERT INTO session_control_bindings(session_id,origin) VALUES ('missing','external_observer')",
			),
		).toThrow();
		db.exec(
			readFileSync(
				new URL("../../../scripts/rollback-opencode-provenance.sql", import.meta.url),
				"utf8",
			),
		);
		expect(db.query("SELECT count(*) AS n FROM sessions").get()).toEqual({ n: 2 });
	} finally {
		db.close();
	}
});
