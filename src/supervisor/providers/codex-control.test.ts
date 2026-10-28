import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import type { LaunchRequest, ManagedSessionEventInput, Session } from "../../shared/types.js";
import {
	codexApprovalPolicy,
	launchManagedCodexRequest,
	promptManagedCodexSession,
	respondManagedApproval,
	stopManagedCodexSession,
} from "./codex-managed.js";
import * as rpc from "./codex-rpc.js";

const previousState = process.env.AGENTPULSE_STATE_DIR;
let server: ReturnType<typeof Bun.serve> | undefined;
let spawnSpy: ReturnType<typeof spyOn> | undefined;
let portSpy: ReturnType<typeof spyOn> | undefined;
let directory: string | undefined;
afterEach(() => {
	spawnSpy?.mockRestore();
	portSpy?.mockRestore();
	server?.stop(true);
	if (directory) rmSync(directory, { recursive: true, force: true });
	if (previousState === undefined) process.env.AGENTPULSE_STATE_DIR = undefined;
	else process.env.AGENTPULSE_STATE_DIR = previousState;
});
test("native approval requests sharing an RPC response ID don't consume the response; follow-up and resume keep the same thread", async () => {
	directory = mkdtempSync(join(tmpdir(), "ap-codex-control-"));
	process.env.AGENTPULSE_STATE_DIR = directory;
	const requests: Array<{ method?: string; id?: string | number; result?: unknown }> = [];
	let socket: ServerWebSocket<unknown> | undefined;
	server = Bun.serve({
		port: 0,
		fetch(req, srv) {
			if (srv.upgrade(req, { data: {} })) return;
			return new Response("upgrade", { status: 400 });
		},
		websocket: {
			open(ws) {
				socket = ws;
			},
			message(ws, raw) {
				const msg = JSON.parse(String(raw));
				requests.push(msg);
				if (!msg.method || msg.id === undefined) return;
				if (msg.method === "initialize")
					ws.send(JSON.stringify({ id: msg.id, result: { protocolVersion: "test" } }));
				else if (["thread/start", "thread/resume", "thread/read"].includes(msg.method))
					ws.send(
						JSON.stringify({ id: msg.id, result: { thread: { id: "native-1", cwd: directory } } }),
					);
				else if (msg.method === "thread/name/set") {
					ws.send(JSON.stringify({ id: msg.id, result: {} }));
					ws.send(
						JSON.stringify({
							method: "thread/name/updated",
							params: { threadId: "native-1", threadName: msg.params.name },
						}),
					);
				} else if (msg.method === "turn/start") {
					ws.send(
						JSON.stringify({
							id: msg.id,
							method: "item/commandExecution/requestApproval",
							params: { threadId: "native-1", command: "echo hello" },
						}),
					);
					ws.send(JSON.stringify({ id: msg.id, result: { turn: { id: "turn-1" } } }));
				} else ws.send(JSON.stringify({ id: msg.id, result: {} }));
			},
		},
	});
	spawnSpy = spyOn(rpc, "spawnServer").mockResolvedValue({ pid: 1, kill() {} } as never);
	portSpy = spyOn(rpc, "findFreePort").mockResolvedValue(server.port!);
	const events: ManagedSessionEventInput[] = [];
	const callbacks = {
		reportState: async () => ({
			session: { displayName: "test" } as Session,
			managedSession: {} as never,
		}),
		reportEvents: async (batch: ManagedSessionEventInput[]) => {
			events.push(...batch);
		},
	};
	const launch = {
		id: "launch-1",
		launchCorrelationId: "control-test",
		cwd: directory,
		agentType: "codex_cli",
		taskPrompt: "first",
		baseInstructions: "",
		model: null,
	} as LaunchRequest;
	try {
		await launchManagedCodexRequest(launch, callbacks);
		for (let i = 0; i < 100 && !events.some((e) => e.eventType === "NativeApprovalRequested"); i++)
			await Bun.sleep(5);
		const approval = events.find((e) => e.eventType === "NativeApprovalRequested")!;
		expect(approval.rawPayload?.params).toEqual({ threadId: "native-1", command: "echo hello" });
		respondManagedApproval("control-test", String(approval.rawPayload?.approvalId), "decline");
		expect(() =>
			respondManagedApproval("control-test", String(approval.rawPayload?.approvalId), "accept"),
		).toThrow("expired");
		socket?.send(JSON.stringify({ method: "turn/completed", params: { turn: { id: "turn-1" } } }));
		await Bun.sleep(10);
		await promptManagedCodexSession("control-test", "second", callbacks);
		expect(events.filter((e) => e.category === "prompt").map((e) => e.content)).toEqual([
			"Task:\nfirst",
			"second",
		]);
		await stopManagedCodexSession("control-test");
		await Bun.sleep(10);
		await launchManagedCodexRequest(launch, callbacks, {
			resumeThreadId: "native-1",
			noPrompt: true,
		});
		expect(requests.filter((r) => r.method === "thread/resume")).toHaveLength(1);
		expect(requests.filter((r) => r.method === "turn/start")).toHaveLength(2);
	} finally {
		await stopManagedCodexSession("control-test").catch(() => {});
	}
});
test("workbench approval policies map to the native Codex enum", () => {
	expect(codexApprovalPolicy("manual")).toBe("on-request");
	expect(codexApprovalPolicy("default")).toBeUndefined();
	expect(codexApprovalPolicy("untrusted")).toBe("untrusted");
});
