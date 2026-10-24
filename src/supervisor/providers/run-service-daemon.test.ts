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
				return { messageID: "msg_daemon_turn" };
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
	const promptResponse = (await (
		await fetch(`${url}/prompt`, {
			method: "POST",
			headers: { ...auth, "Content-Type": "application/json" },
			body: JSON.stringify({ text: "hello" }),
		})
	).json()) as { messageID?: string };
	expect(promptResponse.messageID).toBe("msg_daemon_turn");
	// Invalid inputs are 400, never coerced into a prompt.
	for (const body of [{ text: 1 }, { text: {} }, { text: "" }, { text: "x".repeat(12001) }]) {
		const response = await fetch(`${url}/prompt`, {
			method: "POST",
			headers: { ...auth, "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		expect(response.status).toBe(400);
	}
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

test("a failed shutdown stays observable; an init store failure reclaims the listener+runtime", async () => {
	const fake = fakeRuntime();
	const failing = { ...fake.runtime, async stop() { throw new Error("native_stop_failed"); } };
	const { url } = await startRunServiceDaemon({
		root,
		instanceId: "shutdown-fail",
		generation: 1,
		runtime: failing,
		token: "tok",
		startTicks: await processStartTicks(process.pid),
	});
	const auth = { Authorization: `Basic ${btoa("agentpulse:tok")}` };
	const response = await fetch(`${url}/shutdown`, { method: "POST", headers: auth });
	expect(response.status).toBe(500);
	expect(await response.json()).toMatchObject({ error: "stop_failed" });
	// Still serving (not falsely stopped).
	expect((await fetch(`${url}/identity`, { headers: auth })).status).toBe(200);

	// INIT FAILURE: a store write that cannot succeed must close the listener and
	// stop the runtime.
	const stopped: string[] = [];
	const runtime = { ...fake.runtime, async stop() { stopped.push("stop"); } };
	const failingStore = {
		ensure: async () => "/tmp/never",
		write: async () => {
			throw new Error("store_write_failed");
		},
		readManifest: async () => {
			throw new Error("unused");
		},
		readToken: async () => {
			throw new Error("unused");
		},
	} as never;
	await expect(
		startRunServiceDaemon({
			root,
			instanceId: "init-fail",
			generation: 1,
			runtime,
			token: "tok",
			startTicks: null,
			store: failingStore,
		}),
	).rejects.toThrow("store_write_failed");
	expect(stopped).toEqual(["stop"]);
});
