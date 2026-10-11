/**
 * AGEN-70: the HTTP surface over the analysis-run service.
 *
 * Gates follow ai-session-summary.ts's split: scope is decided before any
 * handler here (requireOperatorScope on the AI router), each handler calls its
 * own gates, and the service never reads instance mode, gates, flags or rates.
 * Stored reports stay readable while AI is paused (build + flag only); the
 * creating POST additionally requires runtime-active AI, a good origin and the
 * per-caller rate limit.
 */
import type { Context } from "hono";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ANALYSIS_MAX_SESSIONS, type AnalysisRefusalBody } from "../../shared/analysis-report.js";
import type { AuthUser } from "../auth/middleware.js";
import { getRequestActor, getRequestMode, refuseBadOrigin } from "../auth/route-scope-policy.js";
import { isShuttingDown } from "../drain-state.js";
import {
	analysisRetryAfterSeconds,
	cancelAnalysisRun,
	createAnalysisRun,
	getAnalysisRun,
	listAnalysisRuns,
	previewAnalysisScope,
	tryConsumeAnalysisRequest,
} from "../services/ai/analysis/runs-service.js";
import { logAdminAction } from "../services/audit-log.js";
import { isLabsFlagEnabled } from "../services/labs-service.js";
import { requireAiActive, requireAiBuild } from "./ai-gates.js";

const aiAnalysisRouter = new Hono();

const REFUSAL_STATUS: Record<string, ContentfulStatusCode> = {
	ai_disabled: 409,
	ai_paused: 409,
	analysis_disabled: 409,
	invalid_body: 400,
	too_many_sessions: 400,
	session_not_found: 404,
	not_selected: 409,
	no_sessions: 409,
	rate_limited: 429,
	shutting_down: 503,
	spend_cap_reached: 409,
	busy: 503,
};

function refuse(c: Context, body: AnalysisRefusalBody, status?: ContentfulStatusCode) {
	if (body.retryAfterSeconds !== undefined) c.header("Retry-After", String(body.retryAfterSeconds));
	return c.json(body, status ?? REFUSAL_STATUS[body.error] ?? 400);
}

async function asContractRefusal(c: Context, gate: Response) {
	const { error } = (await gate.json()) as { error: "ai_disabled" | "ai_paused" };
	return refuse(c, { error }, gate.status as ContentfulStatusCode);
}

/** Server-enforced: the Labs flag is the consent gate, like sessionSummary (D-6). */
async function requireAnalysisFlag(c: Context) {
	if (await isLabsFlagEnabled("analysisReports")) return null;
	return refuse(c, { error: "analysis_disabled" });
}

function callerSubject(c: Context): string {
	const authUser = c.get("authUser") as AuthUser | undefined;
	return authUser?.userId ?? authUser?.keyId ?? "anon";
}

interface RunRequestBody {
	sessionIds?: unknown;
	from?: unknown;
	to?: unknown;
}

function parseTimeField(value: unknown): { ok: true; time: string | null } | { ok: false } {
	if (value === undefined || value === null || value === "") return { ok: true, time: null };
	if (typeof value !== "string" || Number.isNaN(Date.parse(value))) return { ok: false };
	return { ok: true, time: value };
}

async function parseRunBody(
	c: Context,
): Promise<{ sessionIds: string[]; from: string | null; to: string | null } | Response> {
	const body = (await c.req.json().catch(() => null)) as RunRequestBody | null;
	if (!body || !Array.isArray(body.sessionIds)) return refuse(c, { error: "invalid_body" });
	const sessionIds = body.sessionIds;
	if (
		sessionIds.length === 0 ||
		sessionIds.length > ANALYSIS_MAX_SESSIONS ||
		!sessionIds.every((id) => typeof id === "string" && id.length > 0 && id.length <= 200)
	) {
		return refuse(c, {
			error: sessionIds.length > ANALYSIS_MAX_SESSIONS ? "too_many_sessions" : "invalid_body",
		});
	}
	const from = parseTimeField(body.from);
	if (!from.ok) return refuse(c, { error: "invalid_body" });
	const to = parseTimeField(body.to);
	if (!to.ok) return refuse(c, { error: "invalid_body" });
	if (from.time !== null && to.time !== null && Date.parse(to.time) < Date.parse(from.time)) {
		return refuse(c, { error: "invalid_body" });
	}
	return { sessionIds: [...new Set(sessionIds as string[])], from: from.time, to: to.time };
}

// GET /ai/analysis/runs — recent runs, bodies omitted. Build + flag (D-5).
aiAnalysisRouter.get("/ai/analysis/runs", async (c) => {
	const build = await requireAiBuild(c);
	if (build) return asContractRefusal(c, build);
	const flag = await requireAnalysisFlag(c);
	if (flag) return flag;
	const limitParam = Number(c.req.query("limit") ?? "30");
	const limit =
		Number.isInteger(limitParam) && limitParam > 0 && limitParam <= 100 ? limitParam : 30;
	return c.json({ runs: await listAnalysisRuns(limit) });
});

// GET /ai/analysis/runs/:id — one run with the report body.
aiAnalysisRouter.get("/ai/analysis/runs/:id", async (c) => {
	const build = await requireAiBuild(c);
	if (build) return asContractRefusal(c, build);
	const flag = await requireAnalysisFlag(c);
	if (flag) return flag;
	const run = await getAnalysisRun(c.req.param("id") ?? "");
	if (!run) return c.json({ error: "run_not_found" }, 404);
	return c.json(run);
});

// POST /ai/analysis/preview — coverage facts before any model call. No spend,
// no run row; reports unselected sessions instead of refusing on them.
aiAnalysisRouter.post("/ai/analysis/preview", async (c) => {
	const build = await requireAiBuild(c);
	if (build) return asContractRefusal(c, build);
	const flag = await requireAnalysisFlag(c);
	if (flag) return flag;
	const parsed = await parseRunBody(c);
	if (parsed instanceof Response) return parsed;
	const result = await previewAnalysisScope(parsed);
	if (result.kind === "refused") return refuse(c, result);
	return c.json(result.preview);
});

// POST /ai/analysis/runs — freeze the scope and enqueue. The whitelist check
// (every session selected for analysis) is the service's, so it holds for any
// caller of createAnalysisRun alike.
aiAnalysisRouter.post("/ai/analysis/runs", async (c) => {
	const build = await requireAiBuild(c);
	if (build) return asContractRefusal(c, build);
	const active = await requireAiActive(c);
	if (active) return asContractRefusal(c, active);
	const flag = await requireAnalysisFlag(c);
	if (flag) return flag;
	const badOrigin = refuseBadOrigin(c);
	if (badOrigin) return badOrigin;
	const parsed = await parseRunBody(c);
	if (parsed instanceof Response) return parsed;

	const subject = callerSubject(c);
	if (!tryConsumeAnalysisRequest(subject)) {
		return refuse(c, {
			error: "rate_limited",
			retryAfterSeconds: analysisRetryAfterSeconds(subject),
		});
	}
	if (isShuttingDown()) {
		return refuse(c, { error: "shutting_down", retryAfterSeconds: 5 });
	}

	const mode = await getRequestMode(c);
	const actor = await getRequestActor(c, { mode });
	const result = await createAnalysisRun({
		sessionIds: parsed.sessionIds,
		from: parsed.from,
		to: parsed.to,
		requestedBy: subject,
	});
	if (result.kind === "refused") {
		return refuse(c, { error: result.error, sessionIds: result.sessionIds });
	}
	logAdminAction("analysis_run_requested", actor, {
		runId: result.run.id,
		sessions: result.run.scope.length,
		from: parsed.from,
		to: parsed.to,
	});
	return c.json(result.run, 202);
});

// POST /ai/analysis/runs/:id/cancel — queued only; a running or finished run
// is history and stays queryable.
aiAnalysisRouter.post("/ai/analysis/runs/:id/cancel", async (c) => {
	const build = await requireAiBuild(c);
	if (build) return asContractRefusal(c, build);
	const flag = await requireAnalysisFlag(c);
	if (flag) return flag;
	const cancelled = await cancelAnalysisRun(c.req.param("id") ?? "");
	if (!cancelled) return c.json({ error: "not_queued" }, 409);
	return c.json({ ok: true });
});

export default aiAnalysisRouter;
