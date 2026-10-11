/**
 * AGEN-70: the analysis-report run service.
 *
 * Queue + lease + in-process executor for cross-session work reports over the
 * frozen selection scope a run was created with. Mirrors the discipline the
 * single-session summary established (session-summary-service.ts): the
 * whitelist is enforced at entry AND re-resolved at execution, money is
 * reserved worst-case before the send and settled at actuals, every terminal
 * write clears the lease, and retries never widen the frozen scope — a session
 * un-selected (or deleted) between creation and execution is excluded and the
 * coverage block says so, never silently dropped.
 *
 * Gates (AI build/runtime, Labs flag, shutdown, rate limit) live in the route,
 * not here — except the pre-send re-checks, which must hold for background
 * execution too.
 */
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import {
	ANALYSIS_MAX_SESSIONS,
	ANALYSIS_PROMPT_VERSION,
	ANALYSIS_SCHEMA_VERSION,
	type AnalysisErrorCode,
	type AnalysisEvidenceId,
	type AnalysisPreview,
	type AnalysisPreviewSession,
	type AnalysisProvenance,
	type AnalysisReport,
	type AnalysisRunCoverage,
	type AnalysisRunStatus,
	type AnalysisRunView,
	type AnalysisSessionCoverage,
	type AnalysisSessionExclusion,
	type AnalysisSessionScope,
} from "../../../../shared/analysis-report.js";
import type { SummarySuspectReason } from "../../../../shared/session-summary.js";
import { getDb } from "../../../db/client.js";
import { events, aiAnalysisRuns, sessions } from "../../../db/schema/index.js";
import { isShuttingDown } from "../../../drain-state.js";
import { OwnTurnBusyError } from "../../../util/own-turn.js";
import { isLabsFlagEnabled } from "../../labs-service.js";
import { parseDbTimestamp, toDbTimestamp } from "../../util/db-time.js";
import { isAiActive } from "../feature.js";
import { priceCompletion } from "../llm/pricing.js";
import { getAdapter } from "../llm/registry.js";
import { LlmError, type LlmResponse, estimateTokens } from "../llm/types.js";
import { getDefaultProvider, getProviderApiKey } from "../providers-service.js";
import { stripAndRedact } from "../redactor.js";
import { type EvidenceBundle, loadEvidence } from "../session-summary/evidence-loader.js";
import {
	type EvidenceRow,
	type Ledger,
	type ScanSummary,
	buildLedgerAsync,
	userPromptTexts,
} from "../session-summary/ledger.js";
import {
	type TripwireContext,
	checkText,
	collectUserPromptUrls,
} from "../session-summary/tripwire.js";
import {
	type SpendReservation,
	releaseReservedSpend,
	reserveSpendCents,
	settleReservedSpend,
	topUpReservation,
} from "../spend-service.js";
import { stripInvisibleKeepNewlines } from "../untrusted-text.js";
import {
	type RepairKind,
	classifyStopReason,
	parseAnalysisAnswer,
	repairTrailer,
} from "./output-schema.js";
import { type AnalysisSessionSection, buildAnalysisPrompt } from "./prompt.js";

export const ANALYSIS_LEASE_SECONDS = 900;
export const ANALYSIS_MAX_ATTEMPTS = 2;
const ANALYSIS_WORKER_INTERVAL_MS = 2500;
const ANALYSIS_MAX_OUTPUT_TOKENS = 4000;
const ANALYSIS_CALL_OPTIONS = {
	maxTokens: ANALYSIS_MAX_OUTPUT_TOKENS,
	temperature: 0.2,
	timeoutMs: 180_000,
	disableReasoning: true,
} as const;
/** Newest ledger-eligible rows per session after the time filter, before the ledger's own caps. */
const ANALYSIS_SESSION_ROWS_CAP = 400;
const ANALYSIS_REQUEST_LIMIT_PER_MINUTE = 3;

type RunRow = typeof aiAnalysisRuns.$inferSelect;

// ── rate limit (per caller subject, fixed 60s window, per process) ───────────

const requestWindows = new Map<string, { windowStart: number; count: number }>();

export function tryConsumeAnalysisRequest(subject: string, now = Date.now()): boolean {
	const entry = requestWindows.get(subject);
	if (!entry || now - entry.windowStart >= 60_000) {
		requestWindows.set(subject, { windowStart: now, count: 1 });
		return true;
	}
	if (entry.count >= ANALYSIS_REQUEST_LIMIT_PER_MINUTE) return false;
	entry.count += 1;
	return true;
}

export function analysisRetryAfterSeconds(subject: string, now = Date.now()): number {
	const entry = requestWindows.get(subject);
	if (!entry) return 0;
	return Math.max(1, Math.ceil((entry.windowStart + 60_000 - now) / 1000));
}

/** Test-only: clears the per-subject request windows. */
export function _resetAnalysisRateLimitForTest(): void {
	requestWindows.clear();
}

// ── small helpers ────────────────────────────────────────────────────────────

function isoOrNull(value: string | null | undefined): string | null {
	if (!value) return null;
	const ms = parseDbTimestamp(value);
	return ms === null ? null : new Date(ms).toISOString();
}

function windowBounds(
	from: string | null,
	to: string | null,
): { fromMs: number | null; toMs: number | null } {
	return {
		fromMs: from ? parseDbTimestamp(toDbTimestamp(new Date(from))) : null,
		toMs: to ? parseDbTimestamp(toDbTimestamp(new Date(to))) : null,
	};
}

async function withOneRetry(label: string, work: () => Promise<void>): Promise<void> {
	try {
		await work();
	} catch (error) {
		console.warn(`[analysis-runs] ${label} failed once, retrying`, error);
		await work();
	}
}

async function readScopeRows(sessionIds: string[]) {
	if (sessionIds.length === 0) return [];
	return getDb()
		.select({
			sessionId: sessions.sessionId,
			displayName: sessions.displayName,
			agentType: sessions.agentType,
			reportedHost: sessions.reportedHost,
			projectId: sessions.projectId,
			analysisSelected: sessions.analysisSelected,
			lastActivityAt: sessions.lastActivityAt,
		})
		.from(sessions)
		.where(inArray(sessions.sessionId, sessionIds));
}

// ── creation ─────────────────────────────────────────────────────────────────

export type CreateAnalysisRunResult =
	| { kind: "created"; run: AnalysisRunView }
	| { kind: "refused"; error: "session_not_found" | "not_selected"; sessionIds: string[] };

export async function createAnalysisRun(input: {
	sessionIds: string[];
	from: string | null;
	to: string | null;
	requestedBy: string;
}): Promise<CreateAnalysisRunResult> {
	const unique = [...new Set(input.sessionIds)];
	const rows = await readScopeRows(unique);
	const byId = new Map(rows.map((r) => [r.sessionId, r]));
	const missing = unique.filter((id) => !byId.has(id));
	if (missing.length > 0)
		return { kind: "refused", error: "session_not_found", sessionIds: missing };
	const unselected = unique.filter((id) => byId.get(id)?.analysisSelected !== true);
	if (unselected.length > 0)
		return { kind: "refused", error: "not_selected", sessionIds: unselected };
	const scope: AnalysisSessionScope[] = unique.map((id) => {
		const row = byId.get(id);
		return {
			sessionId: id,
			label: row?.displayName || id,
			agentType: row?.agentType ?? "unknown",
			host: row?.reportedHost ?? null,
			projectId: row?.projectId ?? null,
		};
	});
	const now = toDbTimestamp(new Date());
	const [inserted] = await getDb()
		.insert(aiAnalysisRuns)
		.values({
			status: "queued",
			requestedBy: input.requestedBy,
			timeFrom: input.from,
			timeTo: input.to,
			scopeSessions: scope,
			createdAt: now,
			updatedAt: now,
		})
		.returning();
	kickAnalysisWorker();
	return { kind: "created", run: runView(inserted, { omitBodies: false }) };
}

// ── preview (no model call, no whitelist refusal: it reports what it sees) ───

export type PreviewResult =
	| { kind: "ok"; preview: AnalysisPreview }
	| { kind: "refused"; error: "session_not_found"; sessionIds: string[] };

export async function previewAnalysisScope(input: {
	sessionIds: string[];
	from: string | null;
	to: string | null;
}): Promise<PreviewResult> {
	const unique = [...new Set(input.sessionIds)];
	const rows = await readScopeRows(unique);
	const byId = new Map(rows.map((r) => [r.sessionId, r]));
	const missing = unique.filter((id) => !byId.has(id));
	if (missing.length > 0)
		return { kind: "refused", error: "session_not_found", sessionIds: missing };
	const counts = new Map<string, { n: number; first: string | null; last: string | null }>();
	for (const id of unique) {
		const conditions = [eq(events.sessionId, id)];
		if (input.from) {
			conditions.push(sql`${events.createdAt} >= ${toDbTimestamp(new Date(input.from))}`);
		}
		if (input.to) {
			conditions.push(sql`${events.createdAt} <= ${toDbTimestamp(new Date(input.to))}`);
		}
		const [row] = await getDb()
			.select({
				n: sql<number>`COUNT(*)`,
				first: sql<string | null>`MIN(${events.createdAt})`,
				last: sql<string | null>`MAX(${events.createdAt})`,
			})
			.from(events)
			.where(and(...conditions));
		if (row) counts.set(id, { n: Number(row.n), first: row.first, last: row.last });
	}
	const previewSessions: AnalysisPreviewSession[] = unique.map((id) => {
		const row = byId.get(id);
		const count = counts.get(id);
		return {
			sessionId: id,
			label: row?.displayName || id,
			agentType: row?.agentType ?? "unknown",
			host: row?.reportedHost ?? null,
			projectId: row?.projectId ?? null,
			selected: row?.analysisSelected === true,
			eventsInRange: count?.n ?? 0,
			firstEventAt: isoOrNull(count?.first ?? null),
			lastEventAt: isoOrNull(count?.last ?? null),
			lastActivityAt: isoOrNull(row?.lastActivityAt ?? null),
		};
	});
	const hosts = new Map<string, { sessions: number; lastActivityAt: string | null }>();
	for (const s of previewSessions) {
		const key = s.host ?? "unknown";
		const entry = hosts.get(key) ?? { sessions: 0, lastActivityAt: null };
		entry.sessions += 1;
		if (s.lastActivityAt && (!entry.lastActivityAt || s.lastActivityAt > entry.lastActivityAt)) {
			entry.lastActivityAt = s.lastActivityAt;
		}
		hosts.set(key, entry);
	}
	const covered = previewSessions.filter((s) => s.eventsInRange > 0);
	const times = covered
		.flatMap((s) => [s.firstEventAt, s.lastEventAt])
		.filter((t): t is string => t !== null)
		.sort();
	return {
		kind: "ok",
		preview: {
			sessions: previewSessions,
			hosts: [...hosts.entries()].map(([host, h]) => ({ host, ...h })),
			coveredFrom: times[0] ?? null,
			coveredTo: times[times.length - 1] ?? null,
			unselectedSessionIds: previewSessions.filter((s) => !s.selected).map((s) => s.sessionId),
		},
	};
}

// ── views ────────────────────────────────────────────────────────────────────

export function runView(row: RunRow, opts: { omitBodies: boolean }): AnalysisRunView {
	const base = {
		id: row.id,
		status: row.status as AnalysisRunStatus,
		createdAt: isoOrNull(row.createdAt) ?? row.createdAt,
		startedAt: isoOrNull(row.startedAt),
		completedAt: isoOrNull(row.completedAt),
		requestedBy: row.requestedBy,
		timeFrom: row.timeFrom,
		timeTo: row.timeTo,
		attemptCount: row.attemptCount,
		errorCode: row.lastErrorCode,
		scope: row.scopeSessions ?? [],
		excludedSessionIds: row.excludedSessionIds ?? [],
		coverage: row.coverage ?? null,
	};
	if (opts.omitBodies) {
		return {
			...base,
			report: null,
			reportOmitted: true,
			provenance: null,
			provenanceOmitted: true,
		};
	}
	return { ...base, report: row.report ?? null, provenance: row.provenance ?? null };
}

export async function listAnalysisRuns(limit = 30): Promise<AnalysisRunView[]> {
	const rows = await getDb()
		.select()
		.from(aiAnalysisRuns)
		.orderBy(desc(aiAnalysisRuns.createdAt), desc(aiAnalysisRuns.id))
		.limit(limit);
	return rows.map((row) => runView(row, { omitBodies: true }));
}

export async function getAnalysisRun(id: string): Promise<AnalysisRunView | null> {
	const [row] = await getDb()
		.select()
		.from(aiAnalysisRuns)
		.where(eq(aiAnalysisRuns.id, id))
		.limit(1);
	return row ? runView(row, { omitBodies: false }) : null;
}

export async function cancelAnalysisRun(id: string): Promise<boolean> {
	const now = toDbTimestamp(new Date());
	const updated = await getDb()
		.update(aiAnalysisRuns)
		.set({
			status: "cancelled",
			completedAt: now,
			updatedAt: now,
			leaseOwner: null,
			leaseExpiresAt: null,
		})
		.where(and(eq(aiAnalysisRuns.id, id), eq(aiAnalysisRuns.status, "queued")))
		.returning({ id: aiAnalysisRuns.id });
	return updated.length > 0;
}

// ── queue, lease and worker ──────────────────────────────────────────────────

async function claimNextRun(): Promise<RunRow | null> {
	const [candidate] = await getDb()
		.select({ id: aiAnalysisRuns.id })
		.from(aiAnalysisRuns)
		.where(eq(aiAnalysisRuns.status, "queued"))
		.orderBy(aiAnalysisRuns.createdAt, aiAnalysisRuns.id)
		.limit(1);
	if (!candidate) return null;
	const now = new Date();
	const [claimed] = await getDb()
		.update(aiAnalysisRuns)
		.set({
			status: "running",
			leaseOwner: crypto.randomUUID(),
			leaseExpiresAt: toDbTimestamp(new Date(now.getTime() + ANALYSIS_LEASE_SECONDS * 1000)),
			attemptCount: sql`${aiAnalysisRuns.attemptCount} + 1`,
			startedAt: sql`COALESCE(${aiAnalysisRuns.startedAt}, ${toDbTimestamp(now)})`,
			updatedAt: toDbTimestamp(now),
			lastErrorCode: null,
		})
		.where(and(eq(aiAnalysisRuns.id, candidate.id), eq(aiAnalysisRuns.status, "queued")))
		.returning();
	return claimed ?? null;
}

async function reclaimExpiredRuns(): Promise<void> {
	const now = toDbTimestamp(new Date());
	const expired = await getDb()
		.update(aiAnalysisRuns)
		.set({
			status: "failed",
			lastErrorCode: "interrupted",
			completedAt: now,
			updatedAt: now,
			leaseOwner: null,
			leaseExpiresAt: null,
		})
		.where(
			and(
				eq(aiAnalysisRuns.status, "running"),
				sql`${aiAnalysisRuns.leaseExpiresAt} IS NOT NULL`,
				lt(aiAnalysisRuns.leaseExpiresAt, now),
				sql`${aiAnalysisRuns.attemptCount} >= ${ANALYSIS_MAX_ATTEMPTS}`,
			),
		)
		.returning({ id: aiAnalysisRuns.id });
	if (expired.length > 0) return;
	await getDb()
		.update(aiAnalysisRuns)
		.set({ status: "queued", leaseOwner: null, leaseExpiresAt: null, updatedAt: now })
		.where(
			and(
				eq(aiAnalysisRuns.status, "running"),
				sql`${aiAnalysisRuns.leaseExpiresAt} IS NOT NULL`,
				lt(aiAnalysisRuns.leaseExpiresAt, now),
			),
		);
}

/** Boot recovery (SQLite single-replica), mirroring recoverInterruptedSummaries. */
export async function recoverInterruptedAnalysisRuns(): Promise<number> {
	const dialect = (await import("../../../config.js")).config.dialect;
	if (dialect === "postgres") return 0;
	const now = toDbTimestamp(new Date());
	const rows = await getDb()
		.update(aiAnalysisRuns)
		.set({
			status: "failed",
			lastErrorCode: "interrupted",
			completedAt: now,
			updatedAt: now,
			leaseOwner: null,
			leaseExpiresAt: null,
		})
		.where(eq(aiAnalysisRuns.status, "running"))
		.returning({ id: aiAnalysisRuns.id });
	for (const row of rows) {
		console.warn("[analysis-runs] run interrupted by restart", { id: row.id });
	}
	return rows.length;
}

let workerRunning = false;
let workerTimer: ReturnType<typeof setInterval> | null = null;
/** Test-only: when false, kickAnalysisWorker never claims (deterministic processing via _runWorkerOnceForTest). */
let workerAutoStart = true;

export function _setAnalysisWorkerAutoStartForTest(enabled: boolean): void {
	workerAutoStart = enabled;
	if (!enabled && workerTimer) {
		clearInterval(workerTimer);
		workerTimer = null;
	}
}

/** Test-only: claims and processes at most one queued run, synchronously. */
export async function _runWorkerOnceForTest(): Promise<string | null> {
	await reclaimExpiredRuns();
	const run = await claimNextRun();
	if (!run) return null;
	await processRun(run);
	return run.id;
}

export function kickAnalysisWorker(): void {
	if (!workerAutoStart) return;
	if (workerRunning || isShuttingDown()) return;
	workerRunning = true;
	void (async () => {
		try {
			await reclaimExpiredRuns();
			for (;;) {
				if (isShuttingDown()) break;
				const run = await claimNextRun();
				if (!run) break;
				await processRun(run);
			}
		} catch (error) {
			console.error("[analysis-runs] worker loop error", error);
		} finally {
			workerRunning = false;
			ensureWorkerTimer();
		}
	})();
}

function ensureWorkerTimer(): void {
	if (workerTimer || isShuttingDown()) return;
	workerTimer = setInterval(() => {
		void getDb()
			.select({ id: aiAnalysisRuns.id })
			.from(aiAnalysisRuns)
			.where(inArray(aiAnalysisRuns.status, ["queued", "running"]))
			.limit(1)
			.then((rows) => {
				if (rows.length === 0) {
					if (workerTimer) clearInterval(workerTimer);
					workerTimer = null;
					return;
				}
				kickAnalysisWorker();
			})
			.catch(() => {});
	}, ANALYSIS_WORKER_INTERVAL_MS);
	if (typeof workerTimer.unref === "function") workerTimer.unref();
}

export async function stopAnalysisWorker(): Promise<void> {
	if (workerTimer) {
		clearInterval(workerTimer);
		workerTimer = null;
	}
	const deadline = Date.now() + 2000;
	while (workerRunning && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

// ── terminal writes ──────────────────────────────────────────────────────────

async function failRun(
	id: string,
	code: AnalysisErrorCode,
	settle: { reservation: SpendReservation | null; actualCents: number },
	extra: Partial<typeof aiAnalysisRuns.$inferInsert> = {},
): Promise<void> {
	const now = toDbTimestamp(new Date());
	if (settle.reservation) {
		const { reservation, actualCents } = settle;
		await withOneRetry("settlement", () =>
			settleReservedSpend(reservation, { sessionId: null, actualCents }),
		).catch(async (error) => {
			console.error("[analysis-runs] settlement failed; releasing", error);
			await withOneRetry("reservation release", () => releaseReservedSpend(reservation));
		});
	}
	await getDb()
		.update(aiAnalysisRuns)
		.set({
			status: "failed",
			lastErrorCode: code,
			completedAt: now,
			updatedAt: now,
			leaseOwner: null,
			leaseExpiresAt: null,
			...extra,
		})
		.where(eq(aiAnalysisRuns.id, id));
	console.warn("[analysis-runs] run failed", { id, code });
}

/** Lease-preserving requeue for transient conditions (busy scans, drain mid-run). */
async function requeueRun(id: string): Promise<void> {
	const now = toDbTimestamp(new Date());
	await getDb()
		.update(aiAnalysisRuns)
		.set({ status: "queued", leaseOwner: null, leaseExpiresAt: null, updatedAt: now })
		.where(eq(aiAnalysisRuns.id, id));
}

// ── execution ────────────────────────────────────────────────────────────────

interface SessionAssembly {
	scope: AnalysisSessionScope;
	index: number;
	included: boolean;
	exclusion: AnalysisSessionExclusion | null;
	eventsRead: number;
	eventsRepresented: number;
	droppedByBudget: number;
	firstEventAt: string | null;
	lastEventAt: string | null;
	ledger: Ledger | null;
	promptUrls: Set<string>;
}

function filterRowsByWindow(
	rows: EvidenceRow[],
	fromMs: number | null,
	toMs: number | null,
): EvidenceRow[] {
	if (fromMs === null && toMs === null) return rows;
	return rows.filter((row) => {
		const at = parseDbTimestamp(row.createdAt);
		if (at === null) return false;
		if (fromMs !== null && at < fromMs) return false;
		if (toMs !== null && at > toMs) return false;
		return true;
	});
}

async function assembleSession(
	scope: AnalysisSessionScope,
	index: number,
	fromMs: number | null,
	toMs: number | null,
): Promise<SessionAssembly> {
	const base: SessionAssembly = {
		scope,
		index,
		included: false,
		exclusion: null,
		eventsRead: 0,
		eventsRepresented: 0,
		droppedByBudget: 0,
		firstEventAt: null,
		lastEventAt: null,
		ledger: null,
		promptUrls: new Set(),
	};
	const bundle: EvidenceBundle | null = await loadEvidence(scope.sessionId).catch((error) => {
		if (error instanceof OwnTurnBusyError) throw error;
		console.error("[analysis-runs] evidence load failed", { sessionId: scope.sessionId, error });
		return null;
	});
	if (!bundle) return { ...base, exclusion: "no_events" };
	const rows = filterRowsByWindow(bundle.rows, fromMs, toMs);
	const firstPromptRows = filterRowsByWindow(bundle.firstPromptRows, fromMs, toMs);
	const capped =
		rows.length > ANALYSIS_SESSION_ROWS_CAP ? rows.slice(-ANALYSIS_SESSION_ROWS_CAP) : rows;
	if (capped.length === 0 && firstPromptRows.length === 0) {
		return { ...base, exclusion: "no_events" };
	}
	const scan: ScanSummary = {
		eventsTotal: bundle.scan.eventsTotal,
		eventsRead: capped.length,
		eligibleRead: capped.length,
		droppedByCap: bundle.scan.droppedByCap + (rows.length - capped.length),
		reachedFirstEvent: bundle.scan.reachedFirstEvent,
		oldestReadAt: capped[0]?.createdAt ?? bundle.scan.oldestReadAt,
	};
	const ledger = await buildLedgerAsync({
		rows: capped,
		firstPromptRows,
		scan,
		agentType: bundle.agentType ?? scope.agentType,
	});
	const times = [...capped, ...firstPromptRows]
		.map((r) => parseDbTimestamp(r.createdAt))
		.filter((t): t is number => t !== null);
	return {
		scope,
		index,
		included: true,
		exclusion: null,
		eventsRead: capped.length,
		eventsRepresented: ledger.entries.reduce((n, e) => n + e.eventCount, 0),
		droppedByBudget: ledger.coverage.droppedByBudget,
		firstEventAt: times.length > 0 ? new Date(Math.min(...times)).toISOString() : null,
		lastEventAt: times.length > 0 ? new Date(Math.max(...times)).toISOString() : null,
		ledger,
		promptUrls: collectUserPromptUrls(userPromptTexts({ rows: capped, firstPromptRows })),
	};
}

function verifyReport(
	draft: AnalysisReport,
	assemblies: SessionAssembly[],
): { report: AnalysisReport; suspectReasons: SummarySuspectReason[] } {
	const known = new Map<string, boolean>();
	const userPromptUrls = new Set<string>();
	const recordedPaths = new Set<string>();
	const recordedCommands = new Set<string>();
	for (const a of assemblies) {
		if (!a.ledger) continue;
		for (const [key, info] of a.ledger.ids) {
			known.set(`S${a.index}${key}`, info.observed);
		}
		for (const url of a.promptUrls) userPromptUrls.add(url);
		for (const path of a.ledger.recorded.paths) recordedPaths.add(path);
		for (const command of a.ledger.recorded.commands) recordedCommands.add(command);
	}
	const ctx: TripwireContext = {
		userPromptUrls,
		recordedPaths: [...recordedPaths],
		recordedCommands: [...recordedCommands],
	};
	const suspect = new Set<SummarySuspectReason>();
	const clean = (text: string): string => stripAndRedact(stripInvisibleKeepNewlines(text)).text;
	const keepIds = (ids: AnalysisEvidenceId[]): AnalysisEvidenceId[] =>
		ids.filter((id) => known.has(id));
	const observedEvidence = (ids: AnalysisEvidenceId[]): boolean =>
		ids.some((id) => known.get(id) === true);
	const item = (value: { summary: string; detail?: string; evidence: AnalysisEvidenceId[] }) => ({
		summary: clean(value.summary),
		...(value.detail ? { detail: clean(value.detail) } : {}),
		evidence: keepIds(value.evidence),
	});
	const report: AnalysisReport = {
		overview: clean(draft.overview),
		accomplishments: draft.accomplishments.map((a) => {
			const base = item(a);
			return {
				...base,
				verification:
					a.verification === "record_verified" && !observedEvidence(base.evidence)
						? "agent_claimed"
						: a.verification,
			};
		}),
		validations: draft.validations.map((v) => {
			const base = item(v);
			return {
				...base,
				outcome: v.outcome === "passed" && !observedEvidence(base.evidence) ? "unknown" : v.outcome,
			};
		}),
		unfinished: draft.unfinished.map((u) => item(u)),
		decisions: draft.decisions.map((d) => item(d)),
	};
	for (const text of [
		report.overview,
		...report.accomplishments.flatMap((a) => [a.summary, a.detail ?? ""]),
		...report.validations.flatMap((v) => [v.summary, v.detail ?? ""]),
		...report.unfinished.flatMap((u) => [u.summary, u.detail ?? ""]),
		...report.decisions.flatMap((d) => [d.summary, d.detail ?? ""]),
	]) {
		for (const reason of checkText(text, ctx)) suspect.add(reason);
	}
	return { report, suspectReasons: [...suspect] };
}

async function processRun(row: RunRow): Promise<void> {
	const runId = row.id;
	if (!(await isLabsFlagEnabled("analysisReports"))) {
		await failRun(runId, "analysis_disabled", { reservation: null, actualCents: 0 });
		return;
	}
	if (!isAiActive()) {
		await failRun(runId, "ai_inactive", { reservation: null, actualCents: 0 });
		return;
	}
	if (isShuttingDown()) {
		await requeueRun(runId);
		return;
	}

	const frozen = row.scopeSessions ?? [];
	const current = await readScopeRows(frozen.map((s) => s.sessionId));
	const currentById = new Map(current.map((r) => [r.sessionId, r]));
	const assemblies: SessionAssembly[] = [];
	const excludedAssembly = (
		scope: AnalysisSessionScope,
		exclusion: AnalysisSessionExclusion,
	): SessionAssembly => ({
		scope,
		index: 0,
		included: false,
		exclusion,
		eventsRead: 0,
		eventsRepresented: 0,
		droppedByBudget: 0,
		firstEventAt: null,
		lastEventAt: null,
		ledger: null,
		promptUrls: new Set(),
	});
	let index = 0;
	const { fromMs, toMs } = windowBounds(row.timeFrom, row.timeTo);
	for (const scope of frozen) {
		const state = currentById.get(scope.sessionId);
		if (!state) {
			assemblies.push(excludedAssembly(scope, "deleted"));
			continue;
		}
		if (state.analysisSelected !== true) {
			assemblies.push(excludedAssembly(scope, "not_selected"));
			continue;
		}
		index += 1;
		try {
			assemblies.push(await assembleSession(scope, index, fromMs, toMs));
		} catch (error) {
			if (error instanceof OwnTurnBusyError) {
				console.warn("[analysis-runs] scans busy; requeueing", { runId });
				await requeueRun(runId);
				return;
			}
			console.error("[analysis-runs] assembly error", { runId, error });
			await failRun(runId, "internal_error", { reservation: null, actualCents: 0 });
			return;
		}
	}
	const included = assemblies.filter((a) => a.included && a.ledger);
	if (included.length === 0) {
		await failRun(
			runId,
			"no_sessions",
			{ reservation: null, actualCents: 0 },
			{
				coverage: buildCoverage(row, assemblies),
				excludedSessionIds: assemblies.filter((a) => !a.included).map((a) => a.scope.sessionId),
			},
		);
		return;
	}

	const provider = await getDefaultProvider();
	if (!provider) {
		await failRun(runId, "no_provider", { reservation: null, actualCents: 0 });
		return;
	}
	const sections: AnalysisSessionSection[] = included.map((a) => ({
		scope: a.scope,
		index: a.index,
		ledgerText: a.ledger?.text ?? "",
		eventsRead: a.eventsRead,
		eventsRepresented: a.eventsRepresented,
		droppedByBudget: a.droppedByBudget,
		firstEventAt: a.firstEventAt,
		lastEventAt: a.lastEventAt,
	}));
	const built = buildAnalysisPrompt(sections, { from: row.timeFrom, to: row.timeTo });
	const request = {
		systemPrompt: built.systemPrompt,
		transcriptPrompt: built.transcriptPrompt,
		model: provider.model,
		...ANALYSIS_CALL_OPTIONS,
	};
	const sentText = request.systemPrompt + request.transcriptPrompt;
	const bytes = new TextEncoder().encode(sentText).length;
	const worstInputTokens = Math.max(estimateTokens(sentText), Math.ceil(bytes / 2));
	const maxCents = priceCompletion(provider.kind, provider.model, {
		inputTokens: worstInputTokens,
		outputTokens: ANALYSIS_MAX_OUTPUT_TOKENS,
		estimated: true,
	});
	const reservation = await reserveSpendCents(maxCents);
	if (!reservation) {
		await failRun(runId, "spend_cap_reached", { reservation: null, actualCents: 0 });
		return;
	}
	const apiKey = await getProviderApiKey(provider.id);
	if (apiKey === null) {
		await failRun(runId, "no_provider", { reservation, actualCents: 0 });
		return;
	}
	const adapter = getAdapter({
		kind: provider.kind,
		apiKey,
		baseUrl: provider.baseUrl ?? undefined,
	});

	let inputTokens = 0;
	let outputTokens = 0;
	let settledCents = 0;
	let calls = 0;
	const charge = (response: LlmResponse): void => {
		calls += 1;
		inputTokens += response.usage.inputTokens;
		outputTokens += response.usage.outputTokens;
		settledCents += priceCompletion(provider.kind, provider.model, response.usage);
	};
	const finishFailure = async (code: AnalysisErrorCode) => {
		await failRun(runId, code, { reservation, actualCents: settledCents });
	};

	try {
		let response = await adapter.complete(request);
		charge(response);
		for (;;) {
			const stop = classifyStopReason(response.stopReason);
			if (stop === "refusal") {
				await finishFailure("provider_refused");
				return;
			}
			const parsed = parseAnalysisAnswer(response.text, built.nonce);
			if (parsed.ok) {
				const { report, suspectReasons } = verifyReport(parsed.draft, included);
				const coverage = buildCoverage(row, assemblies);
				const provenance: AnalysisProvenance = {
					schemaVersion: ANALYSIS_SCHEMA_VERSION,
					promptVersion: ANALYSIS_PROMPT_VERSION,
					provider: { kind: provider.kind, model: provider.model },
					inputTokens,
					outputTokens,
					usageEstimated: true,
					costCents: settledCents,
					calls,
					redactionHits: built.redactionHits,
					suspectReasons,
					coverage: {
						sessions: frozen.length,
						includedSessions: included.length,
						excludedSessions: frozen.length - included.length,
					},
				};
				const now = toDbTimestamp(new Date());
				await withOneRetry("settlement", () =>
					settleReservedSpend(reservation, { sessionId: null, actualCents: settledCents }),
				);
				await getDb()
					.update(aiAnalysisRuns)
					.set({
						status: "succeeded",
						lastErrorCode: null,
						completedAt: now,
						updatedAt: now,
						leaseOwner: null,
						leaseExpiresAt: null,
						promptVersion: ANALYSIS_PROMPT_VERSION,
						providerKind: provider.kind,
						providerModel: provider.model,
						inputTokens,
						outputTokens,
						costCents: settledCents,
						excludedSessionIds: assemblies.filter((a) => !a.included).map((a) => a.scope.sessionId),
						coverage,
						report,
						provenance,
					})
					.where(eq(aiAnalysisRuns.id, runId));
				return;
			}
			if (calls >= 2) {
				await finishFailure(stop === "length" ? "output_truncated" : "parse_failed");
				return;
			}
			if (isShuttingDown() || !isAiActive() || !(await isLabsFlagEnabled("analysisReports"))) {
				await finishFailure("ai_inactive");
				return;
			}
			const repair: RepairKind =
				stop === "length" ? { kind: "truncated" } : { kind: "parse", path: parsed.path };
			const repairPrompt = `${request.transcriptPrompt}\n\n${repairTrailer(repair)}`;
			const repairBytes = new TextEncoder().encode(repairPrompt).length;
			const repairWorst = Math.max(estimateTokens(repairPrompt), Math.ceil(repairBytes / 2));
			const repairMax = priceCompletion(provider.kind, provider.model, {
				inputTokens: repairWorst,
				outputTokens: ANALYSIS_MAX_OUTPUT_TOKENS,
				estimated: true,
			});
			if (reservation.cents < settledCents + repairMax) {
				const topped = await topUpReservation(
					reservation,
					settledCents + repairMax - reservation.cents,
				);
				if (!topped) {
					await finishFailure("spend_cap_reached");
					return;
				}
			}
			response = await adapter.complete({ ...request, transcriptPrompt: repairPrompt });
			charge(response);
		}
	} catch (error) {
		if (error instanceof LlmError) {
			const chargeCents =
				error.subType === "permanent_auth" || error.subType === "transient_rate_limit"
					? settledCents
					: Math.max(settledCents, maxCents);
			const code: AnalysisErrorCode =
				error.subType === "permanent_auth"
					? "provider_auth"
					: error.subType === "transient_rate_limit"
						? "provider_rate_limit"
						: error.subType === "transient_timeout"
							? "provider_timeout"
							: "provider_error";
			await failRun(runId, code, { reservation, actualCents: chargeCents });
			return;
		}
		console.error("[analysis-runs] unexpected execution error", { runId, error });
		await failRun(runId, "internal_error", {
			reservation,
			actualCents: Math.max(settledCents, maxCents),
		});
	}
}

function buildCoverage(row: RunRow, assemblies: SessionAssembly[]): AnalysisRunCoverage {
	const sessionCoverage: AnalysisSessionCoverage[] = assemblies.map((a) => ({
		sessionId: a.scope.sessionId,
		label: a.scope.label,
		agentType: a.scope.agentType,
		host: a.scope.host,
		included: a.included,
		exclusion: a.exclusion,
		eventsRead: a.eventsRead,
		eventsRepresented: a.eventsRepresented,
		firstEventAt: a.firstEventAt,
		lastEventAt: a.lastEventAt,
	}));
	const hosts = new Map<string, { sessions: number; lastActivityAt: string | null }>();
	for (const s of sessionCoverage) {
		if (!s.included) continue;
		const key = s.host ?? "unknown";
		const entry = hosts.get(key) ?? { sessions: 0, lastActivityAt: null };
		entry.sessions += 1;
		if (s.lastEventAt && (!entry.lastActivityAt || s.lastEventAt > entry.lastActivityAt)) {
			entry.lastActivityAt = s.lastEventAt;
		}
		hosts.set(key, entry);
	}
	const times = sessionCoverage
		.filter((s) => s.included)
		.flatMap((s) => [s.firstEventAt, s.lastEventAt])
		.filter((t): t is string => t !== null)
		.sort();
	return {
		requestedFrom: row.timeFrom,
		requestedTo: row.timeTo,
		coveredFrom: times[0] ?? null,
		coveredTo: times[times.length - 1] ?? null,
		sessions: sessionCoverage,
		hosts: [...hosts.entries()].map(([host, h]) => ({ host, ...h })),
	};
}

export const ANALYSIS_LIMITS = {
	maxSessions: ANALYSIS_MAX_SESSIONS,
	maxAttempts: ANALYSIS_MAX_ATTEMPTS,
	leaseSeconds: ANALYSIS_LEASE_SECONDS,
	requestsPerMinute: ANALYSIS_REQUEST_LIMIT_PER_MINUTE,
} as const;
