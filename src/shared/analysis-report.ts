/**
 * Analysis-report shared contract (AGEN-70): cross-session, cross-machine work
 * reports over analysis-selected sessions.
 *
 * Zod-free by the shared-layer rule: the only runtime schema lives in the
 * server's output parser (services/ai/analysis/output-schema.ts). Every
 * timestamp on the wire is an ISO-8601 Z instant; costs are whole cents.
 */
import type { ProviderKind } from "./types.js";

export const ANALYSIS_SCHEMA_VERSION = 1;
export const ANALYSIS_PROMPT_VERSION = "1";

/** Hard caps a run accepts; more sessions is a request-body refusal, not a silent drop. */
export const ANALYSIS_MAX_SESSIONS = 8;

/**
 * The three-way completion discipline the report must keep separate
 * (acceptance criterion): what an agent merely claimed, what the recorded
 * evidence itself shows passed, and what is still waiting on a human.
 */
export const ANALYSIS_VERIFICATION_STATUSES = [
	"agent_claimed",
	"record_verified",
	"awaiting_acceptance",
] as const;
export type AnalysisVerification = (typeof ANALYSIS_VERIFICATION_STATUSES)[number];

export const ANALYSIS_VALIDATION_OUTCOMES = ["passed", "failed", "unknown"] as const;
export type AnalysisValidationOutcome = (typeof ANALYSIS_VALIDATION_OUTCOMES)[number];

/**
 * A model citation. Composite id: `S<sessionIndex>E<eventRowId>` — the session
 * index refers to the run's frozen `scope` order, the event id to the events
 * row the ledger line came from. Ids the run never offered are dropped before
 * the report is stored, so a stored id always resolves to evidence.
 */
export type AnalysisEvidenceId = string;

export interface AnalysisItem {
	summary: string;
	detail?: string;
	evidence: AnalysisEvidenceId[];
}

export interface AnalysisAccomplishment extends AnalysisItem {
	verification: AnalysisVerification;
}

export interface AnalysisValidation extends AnalysisItem {
	outcome: AnalysisValidationOutcome;
}

export interface AnalysisReport {
	overview: string;
	accomplishments: AnalysisAccomplishment[];
	validations: AnalysisValidation[];
	unfinished: AnalysisItem[];
	decisions: AnalysisItem[];
}

/**
 * The parsed model output before verification. Same shape as the stored
 * report: the difference is discipline, not structure — verification drops
 * unknown evidence ids and downgrades claims the records do not back.
 */
export type AnalysisDraft = AnalysisReport;

/** Frozen at task creation: the selection scope a run may read, never widened later. */
export interface AnalysisSessionScope {
	sessionId: string;
	label: string;
	agentType: string;
	host: string | null;
	projectId: string | null;
}

/** Why a frozen session produced no evidence at execution time. */
export const ANALYSIS_SESSION_EXCLUSIONS = ["not_selected", "deleted", "no_events"] as const;
export type AnalysisSessionExclusion = (typeof ANALYSIS_SESSION_EXCLUSIONS)[number];

export interface AnalysisSessionCoverage {
	sessionId: string;
	label: string;
	agentType: string;
	host: string | null;
	included: boolean;
	exclusion: AnalysisSessionExclusion | null;
	/** Events inside the requested window that the scan actually read. */
	eventsRead: number;
	/** Eligible rows the ledger represents (post collapse), for honesty about compression. */
	eventsRepresented: number;
	firstEventAt: string | null;
	lastEventAt: string | null;
}

export interface AnalysisHostCoverage {
	host: string;
	sessions: number;
	lastActivityAt: string | null;
}

/** What the run actually covered versus what was asked — shown with every report. */
export interface AnalysisRunCoverage {
	requestedFrom: string | null;
	requestedTo: string | null;
	coveredFrom: string | null;
	coveredTo: string | null;
	sessions: AnalysisSessionCoverage[];
	hosts: AnalysisHostCoverage[];
}

export interface AnalysisProvenance {
	schemaVersion: number;
	promptVersion: string;
	provider: { kind: ProviderKind | string; model: string };
	inputTokens: number;
	outputTokens: number;
	usageEstimated: boolean;
	costCents: number;
	calls: number;
	redactionHits: number;
	/** Tripwire reason codes found in the stored report text, de-duplicated. */
	suspectReasons: string[];
	/** Coverage fields duplicated from the columns for a self-contained provenance block. */
	coverage: { sessions: number; includedSessions: number; excludedSessions: number };
}

export const ANALYSIS_RUN_STATUSES = [
	"queued",
	"running",
	"succeeded",
	"failed",
	"cancelled",
] as const;
export type AnalysisRunStatus = (typeof ANALYSIS_RUN_STATUSES)[number];

export const ANALYSIS_ERROR_CODES = [
	"ai_inactive",
	"analysis_disabled",
	"no_provider",
	"no_sessions",
	"spend_cap_reached",
	"provider_auth",
	"provider_rate_limit",
	"provider_timeout",
	"provider_refused",
	"provider_error",
	"output_truncated",
	"parse_failed",
	"interrupted",
	"internal_error",
] as const;
export type AnalysisErrorCode = (typeof ANALYSIS_ERROR_CODES)[number];

/** The wire shape of one run. The list projection omits `report` and the provenance body. */
export interface AnalysisRunView {
	id: string;
	status: AnalysisRunStatus;
	createdAt: string;
	startedAt: string | null;
	completedAt: string | null;
	requestedBy: string;
	timeFrom: string | null;
	timeTo: string | null;
	attemptCount: number;
	errorCode: AnalysisErrorCode | string | null;
	scope: AnalysisSessionScope[];
	excludedSessionIds: string[];
	coverage: AnalysisRunCoverage | null;
	report: AnalysisReport | null;
	/** True on list responses: the report body was left out; fetch the run for it. */
	reportOmitted?: boolean;
	provenance: AnalysisProvenance | null;
	/** True on list responses: the provenance body was left out. */
	provenanceOmitted?: boolean;
}

export interface AnalysisRunListView {
	runs: Array<
		Omit<AnalysisRunView, "report" | "provenance"> & {
			reportOmitted: true;
			provenanceOmitted: true;
		}
	>;
}

/** Refusal codes of POST /ai/analysis/runs and POST /ai/analysis/preview. */
export const ANALYSIS_REFUSAL_CODES = [
	"ai_disabled",
	"ai_paused",
	"analysis_disabled",
	"invalid_body",
	"too_many_sessions",
	"session_not_found",
	"not_selected",
	"no_sessions",
	"rate_limited",
	"shutting_down",
	"spend_cap_reached",
	"busy",
] as const;
export type AnalysisRefusalCode = (typeof ANALYSIS_REFUSAL_CODES)[number];

export interface AnalysisRefusalBody {
	error: AnalysisRefusalCode;
	sessionIds?: string[];
	retryAfterSeconds?: number;
}

/** What POST /ai/analysis/preview answers: coverage facts before any model call. */
export interface AnalysisPreviewSession {
	sessionId: string;
	label: string;
	agentType: string;
	host: string | null;
	projectId: string | null;
	selected: boolean;
	eventsInRange: number;
	firstEventAt: string | null;
	lastEventAt: string | null;
	lastActivityAt: string | null;
}

export interface AnalysisPreviewHost {
	host: string;
	sessions: number;
	lastActivityAt: string | null;
}

export interface AnalysisPreview {
	sessions: AnalysisPreviewSession[];
	hosts: AnalysisPreviewHost[];
	coveredFrom: string | null;
	coveredTo: string | null;
	unselectedSessionIds: string[];
}
