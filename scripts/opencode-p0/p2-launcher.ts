/** P2 prototype: a supervisor-like launcher that exits immediately after starting
 *  the run service DETACHED (the service must survive). */
import { spawn } from "node:child_process";
import { join } from "node:path";

const [stateDir, instanceId, generation, nativeSessionId] = process.argv.slice(2);
const child = spawn(
	process.execPath,
	[join(import.meta.dir, "p2-agent.ts"), stateDir, instanceId, generation, nativeSessionId],
	{ detached: true, stdio: "ignore" },
);
child.unref();
console.log(JSON.stringify({ launchedPid: child.pid }));
process.exit(0);
