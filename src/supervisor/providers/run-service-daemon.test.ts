import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processStartTicks } from "./opencode-recovery.js";
import { connectRunService, fetchRunServiceIdentity } from "./run-service-connection.js";
import { startRunServiceDaemon } from "./run-service-daemon.js";

const root = await mkdtemp(join(tmpdir(), "ap-daemon-"));
afterAll(() => rm(root, { recursive: true, force: true }));

function fakeRuntime() {
	const calls: string[] = [];
	return {
		calls,
		runtime: {
			nativeSessionId: "ses_daemon",
			async prompt(text: string) {
				calls.push(`prompt:${text}`);
			},
			async snapshot() {
				return { messages: [{ info: { id: "m" } }], status: { type: "idle" } };
			},
			async abort() {
				calls.push("abort");
			},
			async stop() {
				calls.push("stop");
			},
		},
	};
}

test("daemon serves identity/messages/prompt/abort/shutdown behind Basic auth", async () => {
	const fake = fakeRuntime();
	let shutdown = false;
	const { url } = await startRunServiceDaemon({
		root,
		instanceId: "daemon",
		generation: 2,
		runtime: fake.runtime,
		token: "tok",
		startTicks: await processStartTicks(process.pid),
		onShutdown: () => {
			shutdown = true;
		},
	});
	const auth = { Authorization: `Basic ${btoa("agentpulse:tok")}` };
	expect((await fetch(`${url}/identity`)).status).toBe(401);
	const identity = (await (await fetch(`${url}/identity`, { headers: auth })).json()) as Record<
		string,
		unknown
	>;
	expect(identity.nativeSessionId).toBe("ses_daemon");
	expect(identity.generation).toBe(2);
	await fetch(`${url}/prompt`, {
		method: "POST",
		headers: { ...auth, "Content-Type": "application/json" },
		body: JSON.stringify({ text: "hello" }),
	});
	expect((await (await fetch(`${url}/messages`, { headers: auth })).json())).toMatchObject({
		status: { type: "idle" },
	});
	await fetch(`${url}/abort`, { method: "POST", headers: auth });
	expect(fake.calls).toEqual(["prompt:hello", "abort"]);
	await fetch(`${url}/shutdown`, { method: "POST", headers: auth });
	expect(fake.calls).toContain("stop");
	expect(shutdown).toBe(true);
});

test("the SAME resolver connects to the daemon (and refuses a wrong token)", async () => {
	const fake = fakeRuntime();
	const { url } = await startRunServiceDaemon({
		root,
		instanceId: "resolve-daemon",
		generation: 1,
		runtime: fake.runtime,
		token: "tok2",
		startTicks: await processStartTicks(process.pid),
	});
	const expected = { instanceId: "resolve-daemon", generation: 1, nativeSessionId: "ses_daemon" };
	expect(await connectRunService(root, "resolve-daemon", expected)).toMatchObject({ ok: true });
	// Wrong token in the protected store -> authentication_failed.
	const { createRunServiceStore } = await import("./run-service-connection.js");
	const store = createRunServiceStore(root);
	const manifest = await store.readManifest("resolve-daemon");
	await store.write("resolve-daemon", manifest, "wrong");
	expect(await connectRunService(root, "resolve-daemon", expected)).toEqual({
		ok: false,
		reason: "authentication_failed",
	});
	// Restore the right token and shut down.
	await store.write("resolve-daemon", manifest, "tok2");
	expect(await fetchRunServiceIdentity(url, "tok2")).toMatchObject({ status: 200 });
	await fetch(`${url}/shutdown`, {
		method: "POST",
		headers: { Authorization: `Basic ${btoa("agentpulse:tok2")}` },
	});
});
