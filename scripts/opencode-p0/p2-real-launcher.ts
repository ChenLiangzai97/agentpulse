/**
 * P2: the supervisor-side launcher. It starts the REAL run service DETACHED
 * (new session, no stdio pipes), reports its identity and exits immediately.
 * From this moment the service owns OpenCode; nothing in this process can keep
 * the native turn alive or kill it by exiting.
 *
 * Usage: bun p2-real-launcher.ts <root> <instanceId> <generation> <cwd> <profilePath> <stateDirectory>
 */
import { spawn } from "node:child_process";
import { join } from "node:path";
import { processStartTicks } from "../../src/supervisor/providers/opencode-recovery.js";

const args = process.argv.slice(2);
if (args.length !== 6) throw new Error("p2_real_launcher_invalid_arguments");
const child = spawn(process.execPath, [join(import.meta.dir, "p2-real-daemon.ts"), ...args], {
	detached: true,
	stdio: "ignore",
});
child.unref();
const startTicks = child.pid ? await processStartTicks(child.pid) : null;
console.log(JSON.stringify({ launchedPid: child.pid ?? null, startTicks }));
process.exit(0);
