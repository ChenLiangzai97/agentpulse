/**
 * Report ownership for OpenCode actions: a provider that STARTED its result
 * report and then lost the response must not trigger a second (failed) report.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ControlAction } from "../shared/types.js";
import { type ControlProviders, createControlActionHandler } from "./control-actions.js";
import { createReportGate } from "./services/report-gate.js";

const SUPERVISOR_ID = "sup-1";
let home: string;

beforeEach(() => {
	home = realpathSync(mkdtempSync(join(tmpdir(), "ap-report-own-")));
	mkdirSync(join(home, "trusted", "p"), { recursive: true });
	mkdirSync(join(home, ".agentpulse"), { recursive: true, mode: 0o700 });
	chmodSync(join(home, ".agentpulse"), 0o700);
	rmSync(join(home, ".agentpulse", "supervisor-gate-state.json"), { force: true });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function harness(openCodeControl: ControlProviders["openCodeControl"]) {
	const calls: { path: string; body: Record<string, unknown> }[] = [];
	const request = async (path: string, options?: RequestInit) => {
		calls.push({ path, body: options?.body ? JSON.parse(String(options.body)) : {} });
		return { session: { displayName: "x" }, managedSession: {}, events: [] };
	};
	const gate = createReportGate({ request, supervisorId: SUPERVISOR_ID, home, now: () => 0, log: () => {} });
	const handle = createControlActionHandler({
		gate,
		trustedRoots: [join(home, "trusted")],
		providers: {
			stopManagedCodexSession: async () => {},
			promptClaudeHeadlessSession: async () => ({}) as never,
			promptClaudeInteractiveSession: async () => ({}) as never,
			openCodeControl,
		} as unknown as ControlProviders,
		executeCleanupWorkArea: (async () => ({ removed: false, resolvedPath: "" })) as never,
		log: () => {},
	});
	return { calls, handle };
}

const action = () => ({
	id: "act-1",
	sessionId: "sess-1",
	launchRequestId: null,
	requestedBy: null,
	status: "claimed",
	error: null,
	metadata: { agentType: "opencode", cwd: join(home, "trusted", "p") },
	actionType: "opencode_resume",
}) as unknown as ControlAction;

const statusReports = (calls: { path: string; body: Record<string, unknown> }[]) =>
	calls.filter((call) => call.path.endsWith("/control-actions/act-1/status"));

test("a report STARTED then lost produces exactly ONE status report (no failed fallback)", async () => {
	const { calls, handle } = harness(async (_action, report) => {
		await report({ status: "succeeded" });
		throw new Error("response_lost");
	});
	await handle(action());
	const reports = statusReports(calls);
	expect(reports).toHaveLength(1);
	expect(reports[0]?.body.status).toBe("succeeded");
});

test("an error BEFORE any report still reports failed once", async () => {
	const { calls, handle } = harness(async () => {
		throw new Error("pre_report_failure");
	});
	await handle(action());
	const reports = statusReports(calls);
	expect(reports).toHaveLength(1);
	expect(reports[0]?.body.status).toBe("failed");
});

test("the DEFAULT success delivery also owns its report (lost response -> no failed fallback)", async () => {
	const calls: { path: string; body: Record<string, unknown> }[] = [];
	const { handle } = (() => {
		const request = async (path: string, options?: RequestInit) => {
			calls.push({ path, body: options?.body ? JSON.parse(String(options.body)) : {} });
			if (path.endsWith("/control-actions/act-1/status"))
				throw new Error("status_response_lost");
			return { session: { displayName: "x" }, managedSession: {}, events: [] };
		};
		const gate = createReportGate({ request, supervisorId: SUPERVISOR_ID, home, now: () => 0, log: () => {} });
		return {
			handle: createControlActionHandler({
				gate,
				trustedRoots: [join(home, "trusted")],
				providers: {
					stopManagedCodexSession: async () => {},
					promptClaudeHeadlessSession: async () => ({}) as never,
					promptClaudeInteractiveSession: async () => ({}) as never,
					// Provider returns WITHOUT reporting: the handler's default path runs.
					openCodeControl: async () => {},
				} as unknown as ControlProviders,
				executeCleanupWorkArea: (async () => ({ removed: false, resolvedPath: "" })) as never,
				log: () => {},
			}),
		};
	})();
	await handle(action());
	const reports = statusReports(calls);
	// Exactly ONE attempt: the default success. The thrown response must NOT
	// trigger a second (failed) report.
	expect(reports).toHaveLength(1);
	expect(reports[0]?.body.status).toBe("succeeded");
});
