#!/usr/bin/env bun
/** Import once, or poll when --watch is supplied. Uses the server's database configuration. */
import { initializeDatabase } from "../src/server/db/client.js";
import {
	OpenCodeObserver,
	defaultOpenCodeDbPath,
} from "../src/server/services/opencode-observer.js";
import { loadEager } from "../src/server/services/projects/cache.js";

await initializeDatabase();
await loadEager();
const observer = new OpenCodeObserver(
	process.env.AGENTPULSE_OPENCODE_DB || defaultOpenCodeDbPath(),
	process.env.AGENTPULSE_OPENCODE_INSTANCE_ID,
);
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
