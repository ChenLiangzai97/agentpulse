/**
 * P2 prototype: a fake "run service" that must survive its supervisor.
 * Loopback-only, Basic auth from a private token file, identity manifest with
 * (instanceId, generation, nativeSessionId, pid, startTicks).
 */
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { processStartTicks } from "../../src/supervisor/providers/opencode-recovery.js";

const [stateDir, instanceId, generationText, nativeSessionId] = process.argv.slice(2);
const generation = Number(generationText);
await mkdir(stateDir, { recursive: true, mode: 0o700 });
const token = randomBytes(24).toString("hex");
const tokenPath = join(stateDir, "agent-token");
await writeFile(tokenPath, token, { mode: 0o600 });
const startTicks = await processStartTicks(process.pid);
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		const auth = request.headers.get("authorization") ?? "";
		if (auth !== `Basic ${btoa(`agentpulse:${token}`)}`)
			return new Response("unauthorized", { status: 401 });
		const url = new URL(request.url);
		if (url.pathname !== "/identity") return new Response("not found", { status: 404 });
		return Response.json({
			instanceId,
			generation,
			nativeSessionId,
			pid: process.pid,
			startTicks,
		});
	},
});
const manifestPath = join(stateDir, "agent-manifest.json");
await writeFile(
	manifestPath,
	JSON.stringify({
		version: 1,
		instanceId,
		generation,
		nativeSessionId,
		pid: process.pid,
		startTicks,
		url: `http://127.0.0.1:${server.port}`,
		tokenPath,
		createdAt: new Date().toISOString(),
	}),
	{ mode: 0o600 },
);
setInterval(() => {}, 1 << 30);
