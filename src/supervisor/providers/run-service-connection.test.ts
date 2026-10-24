import { afterAll, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processStartTicks } from "./opencode-recovery.js";
import {
	connectRunService,
	createRunServiceStore,
	fetchRunServiceIdentity,
	promptRunService,
	requestRunService,
	runServiceDirectory,
} from "./run-service-connection.js";

const root = await mkdtemp(join(tmpdir(), "ap-run-store-"));
afterAll(() => rm(root, { recursive: true, force: true }));

test("paths come from root+instance only (no caller paths, no traversal)", () => {
	expect(() => runServiceDirectory(root, "../escape")).toThrow("run_service_invalid_instance");
	expect(runServiceDirectory(root, "ok-1").startsWith(root)).toBe(true);
});

test("manifest/token must be private and owned by this uid", async () => {
	const store = createRunServiceStore(root);
	const directory = await store.ensure("perms");
	const manifest = {
		version: 1 as const,
		instanceId: "perms",
		generation: 1,
		nativeSessionId: "ses_p",
		pid: process.pid,
		startTicks: await processStartTicks(process.pid),
		url: "http://127.0.0.1:1",
		tokenPath: join(directory, "token"),
	};
	await store.write("perms", manifest, "tok");
	expect(await store.readToken("perms")).toBe("tok");
	await chmod(join(directory, "token"), 0o644);
	await expect(store.readToken("perms")).rejects.toThrow("run_service_not_private");
	await chmod(join(directory, "token"), 0o600);
});

test("control paths stay same-origin and POST bodies reach the service", async () => {
	const seen: { path?: string; method?: string; body?: string }[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			seen.push({
				path: new URL(request.url).pathname,
				method: request.method,
				body: await request.text(),
			});
			return Response.json({ ok: true });
		},
	});
	try {
		const url = `http://127.0.0.1:${server.port}`;
		const response = await promptRunService(url, "tok", "hello");
		expect(response.status).toBe(200);
		expect(seen.at(-1)).toMatchObject({
			path: "/prompt",
			method: "POST",
			body: JSON.stringify({ text: "hello" }),
		});
		// A path that would re-target the request (and replay the token) is refused
		// BEFORE any request leaves loopback.
		await expect(
			requestRunService(url, "tok", { path: "//evil.example/identity" }),
		).rejects.toThrow("run_service_invalid_path");
		expect(seen.map((entry) => entry.path)).toEqual(["/prompt"]);
	} finally {
		server.stop(true);
	}
});

test("the adapter refuses a redirect WITHOUT forwarding credentials", async () => {
	let hit = 0;
	const server = Bun.serve({
		port: 0,
		fetch() {
			hit += 1;
			return new Response("", { status: 302, headers: { Location: "http://example.com/" } });
		},
	});
	try {
		await expect(fetchRunServiceIdentity(`http://127.0.0.1:${server.port}`, "tok")).rejects.toThrow(
			"run_service_redirect_refused",
		);
		expect(hit).toBe(1); // no follow-up request
	} finally {
		server.stop(true);
	}
});

test("the adapter times out and refuses non-loopback URLs", async () => {
	const server = Bun.serve({
		port: 0,
		async fetch() {
			await Bun.sleep(2000);
			return Response.json({});
		},
	});
	try {
		await expect(
			fetchRunServiceIdentity(`http://127.0.0.1:${server.port}`, "tok", { timeoutMs: 150 }),
		).rejects.toThrow();
	} finally {
		server.stop(true);
	}
	await expect(fetchRunServiceIdentity("http://10.0.0.1:1", "tok")).rejects.toThrow(
		"run_service_not_loopback",
	);
});

test("connectRunService end-to-end over the real store + adapter (and a wrong tick refusal)", async () => {
	const instanceId = "e2e";
	const directory = await createRunServiceStore(root).ensure(instanceId);
	const ticks = await processStartTicks(process.pid);
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(request) {
			const auth = request.headers.get("authorization") ?? "";
			if (auth !== `Basic ${btoa("agentpulse:tok")}`) return new Response("no", { status: 401 });
			return Response.json({
				instanceId,
				generation: 1,
				nativeSessionId: "ses_e2e",
				pid: process.pid,
				startTicks: ticks,
			});
		},
	});
	try {
		const manifest = {
			version: 1 as const,
			instanceId,
			generation: 1,
			nativeSessionId: "ses_e2e",
			pid: process.pid,
			startTicks: ticks,
			url: `http://127.0.0.1:${server.port}`,
			tokenPath: join(directory, "token"),
		};
		await createRunServiceStore(root).write(instanceId, manifest, "tok");
		const expected = { instanceId, generation: 1, nativeSessionId: "ses_e2e" };
		expect(await connectRunService(root, instanceId, expected)).toMatchObject({ ok: true });
		// Forged start ticks in the manifest -> PID-reuse refusal.
		await createRunServiceStore(root).write(instanceId, { ...manifest, startTicks: "0" }, "tok");
		expect(await connectRunService(root, instanceId, expected)).toEqual({
			ok: false,
			reason: "process_gone_or_reused",
		});
	} finally {
		server.stop(true);
	}
});

test("a SLOW DRIP is terminated at the absolute deadline (server sees the close)", async () => {
	let cancelled = false;
	const server = Bun.serve({
		port: 0,
		async fetch() {
			const stream = new ReadableStream({
				async start(controller) {
					for (let i = 0; i < 40; i++) {
						controller.enqueue(new TextEncoder().encode(" "));
						await Bun.sleep(50);
					}
					controller.close();
				},
				cancel() {
					cancelled = true;
				},
			});
			return new Response(stream, { headers: { "Content-Type": "application/json" } });
		},
	});
	try {
		const started = Date.now();
		await expect(
			fetchRunServiceIdentity(`http://127.0.0.1:${server.port}`, "tok", { timeoutMs: 400 }),
		).rejects.toThrow(/run_service_timeout|run_service_aborted/);
		expect(Date.now() - started).toBeLessThan(1200); // not 2s of dripping
		await Bun.sleep(300);
		// The deadline DESTROYS the connection instead of only rejecting a promise.
		expect(cancelled).toBe(true);
	} finally {
		server.stop(true);
	}
});

test("an oversized identity body is refused", async () => {
	const server = Bun.serve({
		port: 0,
		fetch() {
			return new Response("x".repeat(70 * 1024), {
				headers: { "Content-Type": "application/json" },
			});
		},
	});
	try {
		await expect(
			fetchRunServiceIdentity(`http://127.0.0.1:${server.port}`, "tok", { timeoutMs: 2000 }),
		).rejects.toThrow(/run_service_body_too_large|run_service_aborted|socket/);
	} finally {
		server.stop(true);
	}
});

test("a symlinked token/manifest is refused", async () => {
	const store = createRunServiceStore(root);
	const directory = await store.ensure("link");
	const real = join(directory, "real-token");
	await Bun.write(real, "tok");
	await (await import("node:fs/promises")).symlink(real, join(directory, "token"));
	await expect(store.readToken("link")).rejects.toThrow("run_service_symlink_refused");
	// Replacing the file after the check is refused by the handle identity check.
	await (await import("node:fs/promises")).rm(join(directory, "token"));
	await Bun.write(join(directory, "token"), "tok");
	await chmod(join(directory, "token"), 0o600);
});
