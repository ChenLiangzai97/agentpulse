/**
 * P2: the REAL detached run service. The daemon OWNS the native OpenCode
 * process through OpenCodeRuntimePool and exposes only the loopback Basic-auth
 * control API from run-service-daemon.ts. Nothing here is reachable from the
 * supervisor's process: the supervisor can exit (or die) and this process, its
 * OpenCode child, and the in-flight native turn keep running.
 *
 * Usage: bun p2-real-daemon.ts <root> <instanceId> <generation> <cwd> <profilePath> <stateDirectory>
 */
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { writePrivateFileSyncNoFollow } from "../../src/shared/private-file.js";
import { processStartTicks } from "../../src/supervisor/providers/opencode-recovery.js";
import { OpenCodeRuntimePool } from "../../src/supervisor/providers/opencode-runtime.js";
import {
	type RunServiceRuntime,
	startRunServiceDaemon,
} from "../../src/supervisor/providers/run-service-daemon.js";

const [root, instanceId, generationText, cwd, profilePath, stateDirectory] = process.argv.slice(2);
const generation = Number(generationText);
if (
	!root ||
	!instanceId ||
	!cwd ||
	!profilePath ||
	!stateDirectory ||
	!Number.isInteger(generation) ||
	generation < 1
)
	throw new Error("p2_real_daemon_invalid_arguments");

mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
const statusPath = join(stateDirectory, "daemon-status.json");
const writeStatus = (status: Record<string, unknown>) => {
	try {
		writePrivateFileSyncNoFollow(
			statusPath,
			JSON.stringify({ ...status, at: new Date().toISOString() }),
		);
	} catch {
		// Diagnostics only: never let a status write change service semantics.
	}
};

const pool = new OpenCodeRuntimePool({
	executable: process.env.P0_OPENCODE_BIN ?? "opencode",
	profilePath,
	stateDirectory,
	maxInstances: 1,
	idleTimeoutMs: 60_000,
	stopGraceMs: 2000,
});

let runtime: Awaited<ReturnType<OpenCodeRuntimePool["start"]>> | undefined;
let shuttingDown = false;

const stopAndExit = async (code: number) => {
	try {
		await runtime?.stop();
	} catch {
		// Reported by /shutdown when it is the caller; here the process must end.
	}
	await pool.close().catch(() => {});
	process.exit(code);
};

for (const signal of ["SIGTERM", "SIGINT"] as const) {
	process.on(signal, () => {
		if (shuttingDown) return;
		shuttingDown = true;
		writeStatus({ phase: "signalled", signal, pid: process.pid });
		void stopAndExit(0);
	});
}

try {
	writeStatus({ phase: "starting", pid: process.pid });
	runtime = await pool.start({
		instanceId,
		generation,
		sessionId: instanceId,
		cwd,
		title: "P2 real detached run service",
	});
	const nativeSessionId = runtime.nativeSessionId;
	// Narrow the control surface to what reconnection needs; the full native
	// snapshot (providers/agents/commands/children) is not exposed here.
	const control: RunServiceRuntime = {
		nativeSessionId,
		prompt: (text) => runtime?.prompt(text) ?? Promise.reject(new Error("runtime_missing")),
		snapshot: async () => {
			const view = await (runtime as NonNullable<typeof runtime>).snapshot();
			return { messages: view.messages, status: view.status };
		},
		abort: () => runtime?.abort() ?? Promise.resolve(),
		stop: () => runtime?.stop() ?? Promise.resolve(),
	};
	const token = randomBytes(24).toString("hex");
	const startTicks = await processStartTicks(process.pid);
	const daemon = await startRunServiceDaemon({
		root,
		instanceId,
		generation,
		runtime: control,
		token,
		startTicks,
		onShutdown: () => {
			if (shuttingDown) return;
			shuttingDown = true;
			writeStatus({ phase: "stopping", pid: process.pid });
			// The response must leave before the listener/process goes away.
			setTimeout(() => void stopAndExit(0), 150);
		},
	});
	writeStatus({
		phase: "ready",
		pid: process.pid,
		startTicks,
		nativeSessionId,
		nativePid: runtime.pid,
		nativeStartTicks: await processStartTicks(runtime.pid),
		instanceDirectory: runtime.directory,
		url: daemon.url,
	});
} catch (error) {
	writeStatus({
		phase: "failed",
		error: error instanceof Error ? error.message : "unknown",
	});
	await stopAndExit(1);
}
