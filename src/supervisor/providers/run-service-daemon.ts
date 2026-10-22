/**
 * Detached run-service control API (P2). Pure wiring: the caller supplies the
 * runtime (real OpenCode in the daemon script; a fake in tests) and the
 * protected store. Loopback-only, Basic auth, no redirects.
 */
import { join } from "node:path";
import { createRunServiceStore } from "./run-service-connection.js";

export interface RunServiceRuntime {
	nativeSessionId: string;
	prompt(text: string): Promise<void>;
	snapshot(): Promise<{ messages: unknown[]; status: unknown }>;
	abort(): Promise<void>;
	stop(): Promise<void>;
}

export async function startRunServiceDaemon(options: {
	root: string;
	instanceId: string;
	generation: number;
	runtime: RunServiceRuntime;
	token: string;
	startTicks: string | null;
	onShutdown?: () => void;
}) {
	const store = createRunServiceStore(options.root);
	const directory = await store.ensure(options.instanceId);
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			if (
				request.headers.get("authorization") !==
				`Basic ${btoa(`agentpulse:${options.token}`)}`
			)
				return new Response("unauthorized", { status: 401 });
			const url = new URL(request.url);
			if (url.pathname === "/identity")
				return Response.json({
					instanceId: options.instanceId,
					generation: options.generation,
					nativeSessionId: options.runtime.nativeSessionId,
					pid: process.pid,
					startTicks: options.startTicks,
				});
			if (url.pathname === "/messages" && request.method === "GET") {
				const snapshot = await options.runtime.snapshot();
				return Response.json(snapshot);
			}
			if (url.pathname === "/prompt" && request.method === "POST") {
				const body = (await request.json()) as { text?: unknown };
				await options.runtime.prompt(String(body.text ?? ""));
				return Response.json({ ok: true });
			}
			if (url.pathname === "/abort" && request.method === "POST") {
				await options.runtime.abort();
				return Response.json({ ok: true });
			}
			if (url.pathname === "/shutdown" && request.method === "POST") {
				await options.runtime.stop().catch(() => {});
				options.onShutdown?.();
				// Let the response leave before closing the listener.
				setTimeout(() => server.stop(true), 0);
				return Response.json({ ok: true });
			}
			return new Response("not found", { status: 404 });
		},
	});
	await store.write(
		options.instanceId,
		{
			version: 1,
			instanceId: options.instanceId,
			generation: options.generation,
			nativeSessionId: options.runtime.nativeSessionId,
			pid: process.pid,
			startTicks: options.startTicks,
			url: `http://127.0.0.1:${server.port}`,
			tokenPath: join(directory, "token"),
		},
		options.token,
	);
	return { url: `http://127.0.0.1:${server.port}`, server };
}
