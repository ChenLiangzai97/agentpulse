/**
 * Test fixture: REAL OpenCode native fork, then an immediate process death
 * (exit 9) inside the fork callback — after the native child exists but before
 * any result can be recorded or reported. Recovery must refuse, not re-fork.
 *
 * argv: <cwd> <profilePath> <stateDirectory> <instanceId> <actionId> <markerPath>
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { executeOrReportFork } from "../fork-pending.js";
import { OpenCodeRuntimePool } from "../opencode-runtime.js";

const [cwd, profilePath, stateDirectory, instanceId, actionId, markerPath] = process.argv.slice(2);
await mkdir(cwd, { recursive: true });
const pool = new OpenCodeRuntimePool({
	executable: process.env.AGENTPULSE_OPENCODE_COMMAND || "opencode",
	profilePath,
	stateDirectory,
	maxInstances: 1,
	idleTimeoutMs: 60000,
	stopGraceMs: 1000,
});
const runtime = await pool.start({
	instanceId,
	generation: 1,
	sessionId: "native-fork-crash",
	cwd,
	title: "native fork crash",
});
await runtime.prompt("P0_HELLO");
for (let i = 0; i < 120; i++) {
	const snapshot = await runtime.snapshot();
	if (snapshot.status && (snapshot.status as { type?: string }).type === "idle") {
		const last = (snapshot.messages as { info?: { time?: { completed?: unknown } } }[]).at(-1);
		if (last?.info?.time?.completed) break;
	}
	await Bun.sleep(100);
}
await runtime.withExclusiveFork(() =>
	executeOrReportFork({
		directory: runtime.ledgerDirectory,
		identity: { actionId, instanceId, generation: 1 },
		nativeSessionId: runtime.nativeSessionId,
		claimToken: "crash-token",
		forkPointMessageId: null,
		capture: () => runtime.captureForkSnapshot(null),
		fork: async () => {
			const created = await runtime.forkSession(undefined, {});
			// The native child EXISTS from here on: record its id for the test.
			await mkdir(dirname(markerPath), { recursive: true });
			await writeFile(markerPath, JSON.stringify({ child: created.id, parent: runtime.nativeSessionId }));
			process.exit(9);
		},
		report: async (record) => ({ token: record.claimToken }),
		register: () => {},
	}),
);
