/** OpenCode source inspection only: no AgentPulse destination DB is loaded here. */
import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";

const REQUIRED_COLUMNS = {
	session: ["id", "title", "directory", "parent_id", "time_created", "time_updated"],
	message: ["id", "session_id", "data", "time_created", "time_updated"],
	part: ["id", "session_id", "message_id", "data", "time_created", "time_updated"],
};

export class OpenCodeSchemaError extends Error {
	constructor(table: string, missing: string[]) {
		super(`Unsupported OpenCode schema: ${table} missing ${missing.join(", ")}`);
		this.name = "OpenCodeSchemaError";
	}
}

export function validateOpenCodeSchema(source: Database): void {
	for (const [table, required] of Object.entries(REQUIRED_COLUMNS)) {
		const columns = source.query(`PRAGMA table_info("${table}")`).all() as { name: string }[];
		const missing = required.filter((key) => !columns.some((column) => column.name === key));
		if (missing.length) throw new OpenCodeSchemaError(table, missing);
	}
}

export function defaultOpenCodeDbPath(): string {
	return join(
		process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
		"opencode",
		"opencode.db",
	);
}

/** Schema shape, not a claim about an installed OpenCode release or payload version. */
export function inspectOpenCodeSource(path: string) {
	const source = new Database(path, { readonly: true, create: false });
	try {
		return source.transaction(() => {
			validateOpenCodeSchema(source);
			const counts: Record<string, number> = {};
			for (const table of Object.keys(REQUIRED_COLUMNS)) {
				counts[table] = (
					source.query(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }
				).n;
			}
			return {
				adapter: "v1" as const,
				schemaCompatible: true,
				schemaVersion: (source.query("PRAGMA schema_version").get() as { schema_version: number })
					.schema_version,
				counts,
				observeOnly: true,
			};
		})();
	} finally {
		source.close();
	}
}
