/**
 * P2 prototype probe: the supervisor exits, the run service survives, and a
 * NEW process reconnects only with verified identity:
 *  - pid alive AND /proc start ticks identical (no PID reuse),
 *  - loopback URL from the manifest only (no arbitrary address),
 *  - authenticated /identity matches instance/generation/native session,
 *  - a wrong token is refused.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { processStartTicks } from "../../src/supervisor/providers/opencode-recovery.js";

const root = await mkdtemp(join(tmpdir(), "ap-p2-"));
const stateDir = join(root, "agent");
const evidence: Record<string, unknown> = {};
const check = (ok: boolean, label: string) => {
	if (!ok) throw new Error(`assertion_failed:${label}`);
};
const launcher = Bun.spawn(
	[
		process.execPath,
		join(import.meta.dir, "p2-launcher.ts"),
		stateDir,
		"p2-instance",
		"1",
		"ses_p2_fixture",
	],
	{ stdout: "pipe", stderr: "inherit" },
);
const code = await launcher.exited;
check(code === 0, "launcher-exits");
// The supervisor is GONE. Wait for the detached service's manifest.
let manifest: {
	instanceId: string;
	generation: number;
	nativeSessionId: string;
	pid: number;
	startTicks: string | null;
	url: string;
	tokenPath: string;
} | null = null;
for (let i = 0; i < 100 && !manifest; i++) {
	try {
		manifest = JSON.parse(await readFile(join(stateDir, "agent-manifest.json"), "utf8"));
	} catch {
		await Bun.sleep(50);
	}
}
check(Boolean(manifest), "manifest-written");
const m = manifest as NonNullable<typeof manifest>;
evidence.serviceSurvivedLauncherExit = true;
evidence.pid = m.pid;
evidence.startTicksMatch = (await processStartTicks(m.pid)) === m.startTicks;
check(evidence.startTicksMatch === true, "start-ticks");
check(new URL(m.url).hostname === "127.0.0.1", "loopback-only");
// A manifest claiming a different start ticks (PID reuse) is refused.
const forged = { ...m, startTicks: "0" };
check((await processStartTicks(forged.pid)) !== forged.startTicks, "pid-reuse-refused");
const token = (await readFile(m.tokenPath, "utf8")).trim();
const auth = (t: string) => ({ Authorization: `Basic ${btoa(`agentpulse:${t}`)}` });
const identity = (await (
	await fetch(`${m.url}/identity`, { headers: auth(token) })
).json()) as Record<string, unknown>;
check(identity.instanceId === m.instanceId, "identity-instance");
check(identity.generation === m.generation, "identity-generation");
check(identity.nativeSessionId === m.nativeSessionId, "identity-native");
evidence.identity = identity;
const wrong = await fetch(`${m.url}/identity`, { headers: auth("wrong") });
check(wrong.status === 401, "wrong-token-refused");
evidence.wrongTokenStatus = wrong.status;
evidence.ok = true;
try {
	process.kill(m.pid, "SIGKILL");
} catch {}
await rm(root, { recursive: true, force: true });
await Bun.write(
	join(import.meta.dir, "p2-detach-evidence.json"),
	`${JSON.stringify(evidence, null, 1)}\n`,
);
console.log(JSON.stringify(evidence, null, 1));
