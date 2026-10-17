#!/usr/bin/env bun
/** Import once, or poll when --watch is supplied. Uses the server's database configuration. */
import {
	OpenCodeSchemaError,
	defaultOpenCodeDbPath,
	inspectOpenCodeSource,
} from "../src/server/services/opencode-source.js";

const path = process.env.AGENTPULSE_OPENCODE_DB || defaultOpenCodeDbPath();
if (process.argv.includes("--check")) {
	try {
		console.log(JSON.stringify({ path, ...inspectOpenCodeSource(path) }));
	} catch (error) {
		console.error(
			JSON.stringify({
				path,
				schemaCompatible: false,
				error:
					error instanceof OpenCodeSchemaError
						? error.message
						: "Source unavailable or unreadable; check the path and server account permissions.",
			}),
		);
		process.exitCode = 1;
	}
} else {
	const { initializeDatabase } = await import("../src/server/db/client.js");
	const { OpenCodeObserver } = await import("../src/server/services/opencode-observer.js");
	const { loadEager } = await import("../src/server/services/projects/cache.js");

	await initializeDatabase();
	await loadEager();
	const observer = new OpenCodeObserver(path, process.env.AGENTPULSE_OPENCODE_INSTANCE_ID);
	try {
		console.log(JSON.stringify(await observer.sync()));
		if (process.argv.includes("--watch")) {
			let stopping = false;
			process.on("SIGINT", () => {
				stopping = true;
			});
			process.on("SIGTERM", () => {
				stopping = true;
			});
			while (!stopping) {
				await Bun.sleep(3000);
				if (!stopping) console.log(JSON.stringify(await observer.sync()));
			}
		}
	} finally {
		observer.close();
	}
}
