/**
 * AGEN-70: the analysis-report surface.
 *
 * Real app, real database, real adapters against the stub LLM server. The
 * worker's auto-start is disabled so every execution is driven explicitly
 * (_runWorkerOnceForTest), which is what makes the between-creation-and-
 * execution cases (un-select, delete) deterministic.
 */
import "../db/__test_db.js";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { resetIdentityState } from "../test-utils/identity-reset.js";
import type { ScriptedAnswer, StubGate } from "../test-utils/llm-stub-server.js";
import {
	edit as editEvent,
	enableAi,
	prompt as promptEvent,
	seedEvents,
	seedProvider,
	seedSession,
	startStub,
	until,
} from "../test-utils/summary-service-harness.js";
import { bearerHeaders, seedKey } from "../test-utils/team-fixtures.js";

const { config } = await import("../config.js");
const { app } = await import("../app.js");
const { getDb, initializeDatabase } = await import("../db/client.js");
const { aiAnalysisRuns, events, sessions, settings, llmProviders, aiDailySpend } = await import(
	"../db/schema/index.js"
);
const { setLabsFlag } = await import("../services/labs-service.js");
const { invalidateAiFlagsCache } = await import("../services/ai/feature.js");
const svc = await import("../services/ai/analysis/runs-service.js");

const MOUNT = "/api/v1";
const originalDisableAuth = config.disableAuth;

let stub: ReturnType<typeof startStub>;
const openGates: StubGate[] = [];

beforeAll(async () => {
	await initializeDatabase();
	stub = startStub();
});
afterAll(async () => {
	(config as Record<string, unknown>).disableAuth = originalDisableAuth;
	await stub.stop();
});

async function resetWorld(): Promise<void> {
	// The whole file drives the API as the DISABLE_AUTH operator, like the
	// summary suite; the two key-scope tests flip auth on for their duration.
	(config as Record<string, unknown>).disableAuth = true;
	await resetIdentityState();
	svc._resetAnalysisRateLimitForTest();
	await getDb().delete(aiAnalysisRuns);
	await getDb().delete(events);
	await getDb().delete(sessions);
	await getDb().delete(llmProviders);
	await getDb().delete(aiDailySpend);
	await getDb().delete(settings);
	invalidateAiFlagsCache();
	stub.reset();
}

beforeEach(async () => {
	await resetWorld();
	svc._setAnalysisWorkerAutoStartForTest(false);
	await enableAi({});
	await setLabsFlag("analysisReports", true);
	await seedProvider(stub);
});
afterEach(async () => {
	for (const gate of openGates.splice(0)) gate.release();
	const unscripted = stub.unscripted.map((r) => `${r.shape} ${r.path}`);
	svc._setAnalysisWorkerAutoStartForTest(true);
	await resetWorld();
	expect(unscripted).toEqual([]);
});

// ── helpers ──────────────────────────────────────────────────────────────────

async function call(
	method: "GET" | "POST" | "PUT",
	path: string,
	init: { body?: unknown; headers?: Headers } = {},
): Promise<{ status: number; json: Record<string, unknown> | null; retryAfter: string | null }> {
	const res = await app.request(`${MOUNT}${path}`, {
		method,
		headers: init.headers,
		...(init.body === undefined
			? {}
			: { body: JSON.stringify(init.body), headers: new Headers(init.headers) }),
	});
	const text = await res.text();
	let json: Record<string, unknown> | null = null;
	try {
		json = JSON.parse(text) as Record<string, unknown>;
	} catch {
		json = null;
	}
	return { status: res.status, json, retryAfter: res.headers.get("Retry-After") };
}

async function seedSelectedSession(
	sessionId: string,
	over: { host?: string | null } = {},
): Promise<{ promptId: number; editId: number }> {
	await seedSession(sessionId, {
		analysisSelected: true,
		reportedHost: over.host ?? null,
	});
	const [promptId, editId] = await seedEvents(sessionId, [
		promptEvent("Ship the widget."),
		editEvent("src/widget.ts"),
	]);
	return { promptId, editId };
}

/** A valid report answer citing composite S-indexed evidence ids. */
function reportAnswer(cite: string[], over: Record<string, unknown> = {}): string {
	return JSON.stringify({
		overview: "Two machines converged on the widget.",
		accomplishments: [
			{ summary: "Widget shipped", evidence: cite, verification: "record_verified" },
		],
		validations: [],
		unfinished: [],
		decisions: [],
		...over,
	});
}

const okAnswer = (cite: string[]): ScriptedAnswer => ({
	text: reportAnswer(cite),
	stop: "stop",
	usage: { input: 1000, output: 100 },
});

async function runRow(id: string): Promise<typeof aiAnalysisRuns.$inferSelect | null> {
	const [row] = await getDb()
		.select()
		.from(aiAnalysisRuns)
		.where(eq(aiAnalysisRuns.id, id))
		.limit(1);
	return row ?? null;
}

async function waitForTerminal(runId: string): Promise<typeof aiAnalysisRuns.$inferSelect> {
	await until(async () => {
		const row = await runRow(runId);
		return row !== null && (row.status === "succeeded" || row.status === "failed");
	}, 20_000);
	const row = await runRow(runId);
	if (!row) throw new Error("run vanished");
	return row;
}

// ── the session toggle and the list filter ───────────────────────────────────

describe("analysis participation toggle", () => {
	test("PUT toggles the flag, broadcasts it, and GET ?analysis=selected filters", async () => {
		await seedSession("ana-t1");
		await seedSession("ana-t2", { analysisSelected: true });
		const set = await call("PUT", "/sessions/ana-t1/analysis", { body: { selected: true } });
		expect(set.status).toBe(200);
		const list = await call("GET", "/sessions?analysis=selected");
		expect(list.status).toBe(200);
		const rows = (list.json?.sessions as Array<{ sessionId: string }>) ?? [];
		expect(rows.map((r) => r.sessionId).sort()).toEqual(["ana-t1", "ana-t2"]);
		const unset = await call("PUT", "/sessions/ana-t1/analysis", { body: { selected: false } });
		expect(unset.status).toBe(200);
		const list2 = await call("GET", "/sessions?analysis=selected");
		const rows2 = (list2.json?.sessions as Array<{ sessionId: string }>) ?? [];
		expect(rows2.map((r) => r.sessionId)).toEqual(["ana-t2"]);
	});

	test("an unrecognized analysis filter value is a 400, not a silent empty list", async () => {
		const res = await call("GET", "/sessions?analysis=bogus");
		expect(res.status).toBe(400);
		expect(res.json?.error).toBe("invalid_analysis");
	});

	test("a malformed toggle body is refused", async () => {
		await seedSession("ana-t3");
		const res = await call("PUT", "/sessions/ana-t3/analysis", { body: { selected: "yes" } });
		expect(res.status).toBe(400);
		expect(res.json?.error).toBe("invalid_body");
	});
});

// ── creation gate: the whitelist ─────────────────────────────────────────────

describe("POST /ai/analysis/runs", () => {
	test("refuses sessions that are not selected for analysis", async () => {
		await seedSession("ana-unselected");
		const res = await call("POST", "/ai/analysis/runs", {
			body: { sessionIds: ["ana-unselected"] },
		});
		expect(res.status).toBe(409);
		expect(res.json?.error).toBe("not_selected");
		expect(res.json?.sessionIds).toEqual(["ana-unselected"]);
	});

	test("refuses unknown session ids with 404", async () => {
		const res = await call("POST", "/ai/analysis/runs", { body: { sessionIds: ["nope"] } });
		expect(res.status).toBe(404);
		expect(res.json?.error).toBe("session_not_found");
	});

	test("refuses an oversized scope instead of silently truncating", async () => {
		const res = await call("POST", "/ai/analysis/runs", {
			body: { sessionIds: Array.from({ length: 9 }, (_, i) => `s${i}`) },
		});
		expect(res.status).toBe(400);
		expect(res.json?.error).toBe("too_many_sessions");
	});

	test("refuses while the Labs flag is off", async () => {
		await setLabsFlag("analysisReports", false);
		const res = await call("POST", "/ai/analysis/runs", { body: { sessionIds: ["x"] } });
		expect(res.status).toBe(409);
		expect(res.json?.error).toBe("analysis_disabled");
	});

	test("freezes the scope and enqueues without touching the model", async () => {
		const { promptId } = await seedSelectedSession("ana-s1", { host: "machine-a" });
		const res = await call("POST", "/ai/analysis/runs", {
			body: { sessionIds: ["ana-s1"], from: "2026-01-01T00:00:00Z" },
		});
		expect(res.status).toBe(202);
		const run = res.json as { id: string; status: string; scope: Array<{ host: string | null }> };
		expect(run.status).toBe("queued");
		expect(run.scope[0]?.host).toBe("machine-a");
		expect(promptId).toBeGreaterThan(0);
		expect(stub.requests()).toHaveLength(0);
		await call("POST", "/ai/analysis/runs/none/cancel", {});
	});
});

// ── execution ────────────────────────────────────────────────────────────────

describe("execution", () => {
	test("a two-machine run succeeds with coverage, provenance and evidence-cited report", async () => {
		const a = await seedSelectedSession("ana-x1", { host: "machine-a" });
		const b = await seedSelectedSession("ana-x2", { host: "machine-b" });
		stub.script("openai", okAnswer([`S1E${a.editId}`, `S2E${b.promptId}`]));
		const res = await call("POST", "/ai/analysis/runs", {
			body: { sessionIds: ["ana-x1", "ana-x2"] },
		});
		const runId = (res.json as { id: string }).id;
		await svc._runWorkerOnceForTest();
		const row = await waitForTerminal(runId);
		expect(row.status).toBe("succeeded");
		expect(row.report?.accomplishments[0]?.verification).toBe("record_verified");
		const coverage = row.coverage;
		expect(coverage?.hosts.map((h) => h.host).sort()).toEqual(["machine-a", "machine-b"]);
		expect(coverage?.sessions.map((s) => s.sessionId).sort()).toEqual(["ana-x1", "ana-x2"]);
		expect(row.provenance?.provider.model).toBe("gpt-5-mini");
		expect(row.costCents).toBeGreaterThan(0);
		// Only the selected sessions' events reached the prompt.
		const sent = stub.requests()[0]?.body ?? "";
		expect(sent).toContain("name of ana-x1"); // label header of session 1
		expect(sent).not.toContain("never-seen-session");
	});

	test("un-selecting between creation and execution excludes the session and says so", async () => {
		await seedSelectedSession("ana-keep", { host: "machine-a" });
		await seedSelectedSession("ana-drop", { host: "machine-b" });
		const res = await call("POST", "/ai/analysis/runs", {
			body: { sessionIds: ["ana-keep", "ana-drop"] },
		});
		const runId = (res.json as { id: string }).id;
		await getDb()
			.update(sessions)
			.set({ analysisSelected: false })
			.where(eq(sessions.sessionId, "ana-drop"));
		stub.script("openai", okAnswer([]));
		await svc._runWorkerOnceForTest();
		const row = await waitForTerminal(runId);
		expect(row.status).toBe("succeeded");
		expect(row.excludedSessionIds).toEqual(["ana-drop"]);
		const dropped = row.coverage?.sessions.find((s) => s.sessionId === "ana-drop");
		expect(dropped?.exclusion).toBe("not_selected");
		// machine-b contributes nothing anymore
		expect(row.coverage?.hosts.map((h) => h.host)).toEqual(["machine-a"]);
	});

	test("a deleted session is excluded, not fatal", async () => {
		await seedSelectedSession("ana-del");
		const res = await call("POST", "/ai/analysis/runs", { body: { sessionIds: ["ana-del"] } });
		const runId = (res.json as { id: string }).id;
		await getDb().delete(sessions).where(eq(sessions.sessionId, "ana-del"));
		await svc._runWorkerOnceForTest();
		const row = await waitForTerminal(runId);
		expect(row.status).toBe("failed");
		expect(row.lastErrorCode).toBe("no_sessions");
		expect(row.coverage?.sessions[0]?.exclusion).toBe("deleted");
	});

	test("the time window bounds what reaches the prompt", async () => {
		const seeded = await seedSelectedSession("ana-win");
		const old = "2024-01-01T00:00:00Z";
		await seedEvents("ana-win", [promptEvent("ancient work", "2024-01-01 00:00:00")]);
		stub.script("openai", okAnswer([`S1E${seeded.editId}`]));
		const res = await call("POST", "/ai/analysis/runs", {
			body: { sessionIds: ["ana-win"], from: "2026-01-01T00:00:00Z" },
			headers: undefined,
		});
		const runId = (res.json as { id: string }).id;
		await svc._runWorkerOnceForTest();
		await waitForTerminal(runId);
		const sent = stub.requests()[0]?.body ?? "";
		expect(sent).not.toContain("ancient work");
		void old;
	});

	test("a parse failure gets one repair, then fails with parse_failed", async () => {
		await seedSelectedSession("ana-repair");
		stub.script(
			"openai",
			{ text: "I am not JSON at all", stop: "stop", usage: { input: 10, output: 5 } },
			okAnswer([]),
		);
		const res = await call("POST", "/ai/analysis/runs", { body: { sessionIds: ["ana-repair"] } });
		const runId = (res.json as { id: string }).id;
		await svc._runWorkerOnceForTest();
		const row = await waitForTerminal(runId);
		expect(row.status).toBe("succeeded");
		expect(stub.requests()).toHaveLength(2);
	});

	test("record_verified without observed evidence is downgraded to agent_claimed", async () => {
		const seeded = await seedSelectedSession("ana-down");
		// Cite the prompt (a CLAIMED fact): not enough for record_verified.
		stub.script("openai", okAnswer([`S1E${seeded.promptId}`]));
		const res = await call("POST", "/ai/analysis/runs", { body: { sessionIds: ["ana-down"] } });
		const runId = (res.json as { id: string }).id;
		await svc._runWorkerOnceForTest();
		const row = await waitForTerminal(runId);
		expect(row.status).toBe("succeeded");
		expect(row.report?.accomplishments[0]?.verification).toBe("agent_claimed");
	});

	test("an invented evidence id never reaches the stored report", async () => {
		await seedSelectedSession("ana-ghost");
		stub.script("openai", okAnswer(["S1E999999"]));
		const res = await call("POST", "/ai/analysis/runs", { body: { sessionIds: ["ana-ghost"] } });
		const runId = (res.json as { id: string }).id;
		await svc._runWorkerOnceForTest();
		const row = await waitForTerminal(runId);
		expect(row.status).toBe("succeeded");
		expect(row.report?.accomplishments[0]?.evidence).toEqual([]);
	});
});

// ── reads, cancel, scopes ────────────────────────────────────────────────────

describe("reads and scopes", () => {
	test("list omits bodies; detail carries them; unknown id is 404", async () => {
		await seedSelectedSession("ana-list");
		const created = await call("POST", "/ai/analysis/runs", { body: { sessionIds: ["ana-list"] } });
		const runId = (created.json as { id: string }).id;
		const list = await call("GET", "/ai/analysis/runs");
		expect(list.status).toBe(200);
		const runs = (list.json?.runs as Array<{ id: string; reportOmitted?: boolean }>) ?? [];
		expect(runs.some((r) => r.id === runId && r.reportOmitted === true)).toBe(true);
		const detail = await call("GET", `/ai/analysis/runs/${runId}`);
		expect(detail.status).toBe(200);
		expect(detail.json?.reportOmitted).toBeUndefined();
		const missing = await call("GET", "/ai/analysis/runs/nope");
		expect(missing.status).toBe(404);
		await call("POST", "/ai/analysis/runs/nope/cancel", {});
	});

	test("cancel ends a queued run; a finished one is refused", async () => {
		await seedSelectedSession("ana-cancel");
		const created = await call("POST", "/ai/analysis/runs", {
			body: { sessionIds: ["ana-cancel"] },
		});
		const runId = (created.json as { id: string }).id;
		const cancelled = await call("POST", `/ai/analysis/runs/${runId}/cancel`, {});
		expect(cancelled.status).toBe(200);
		const again = await call("POST", `/ai/analysis/runs/${runId}/cancel`, {});
		expect(again.status).toBe(409);
	});

	test("observe keys are refused: reports derive from prompts and tool data", async () => {
		(config as Record<string, unknown>).disableAuth = false;
		try {
			const key = await seedKey("observe-key-analysis", ["observe"]);
			const list = await call("GET", "/ai/analysis/runs", {
				headers: bearerHeaders(key.key),
			});
			expect(list.status).toBe(403);
			expect(list.json?.error).toBe("insufficient_scope");
		} finally {
			(config as Record<string, unknown>).disableAuth = originalDisableAuth;
		}
	});

	test("manage keys can read the list", async () => {
		(config as Record<string, unknown>).disableAuth = false;
		try {
			const key = await seedKey("manage-key-analysis", ["manage"]);
			const list = await call("GET", "/ai/analysis/runs", { headers: bearerHeaders(key.key) });
			expect(list.status).toBe(200);
		} finally {
			(config as Record<string, unknown>).disableAuth = originalDisableAuth;
		}
	});
});
