/**
 * ai_analysis_runs table — dual-dialect (Decision 21 / Decision 22).
 *
 * One row per analysis-report run over a frozen selection of sessions
 * (AGEN-70). Deliberately NO foreign key to sessions: the frozen scope keeps
 * reporting history queryable after a session is deleted, exactly like the
 * doc requirement that historical reports stay traceable when participation
 * is withdrawn.
 *
 * Follows ai_watcher_runs' lease/attempt columns and ai_session_summaries'
 * result/provenance columns; the executor lives in
 * services/ai/analysis/runs-service.ts.
 */
import { sql } from "drizzle-orm";
import {
	index as pgIndex,
	integer as pgInteger,
	pgTable,
	text as pgText,
} from "drizzle-orm/pg-core";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type {
	AnalysisProvenance,
	AnalysisReport,
	AnalysisRunCoverage,
	AnalysisSessionScope,
} from "../../../../shared/analysis-report.js";
import { jsonColumn, tsColumn } from "../factory.js";

export const aiAnalysisRunsSqlite = sqliteTable(
	"ai_analysis_runs",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		status: text("status").notNull().default("queued"),
		requestedBy: text("requested_by").notNull(),
		timeFrom: text("time_from"),
		timeTo: text("time_to"),
		scopeSessions: text("scope_sessions", { mode: "json" })
			.$type<AnalysisSessionScope[]>()
			.notNull(),
		leaseOwner: text("lease_owner"),
		leaseExpiresAt: text("lease_expires_at"),
		attemptCount: integer("attempt_count").notNull().default(0),
		lastErrorCode: text("last_error_code"),
		startedAt: text("started_at"),
		completedAt: text("completed_at"),
		promptVersion: text("prompt_version"),
		providerKind: text("provider_kind"),
		providerModel: text("provider_model"),
		inputTokens: integer("input_tokens").notNull().default(0),
		outputTokens: integer("output_tokens").notNull().default(0),
		costCents: integer("cost_cents").notNull().default(0),
		excludedSessionIds: text("excluded_session_ids", { mode: "json" }).$type<string[]>(),
		coverage: text("coverage", { mode: "json" }).$type<AnalysisRunCoverage>(),
		report: text("report", { mode: "json" }).$type<AnalysisReport>(),
		provenance: text("provenance", { mode: "json" }).$type<AnalysisProvenance>(),
		createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
		updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
	},
	(t) => ({
		statusLease: index("idx_ai_analysis_runs_status_lease").on(t.status, t.leaseExpiresAt),
		created: index("idx_ai_analysis_runs_created").on(t.createdAt),
	}),
);

export const aiAnalysisRunsPg = pgTable(
	"ai_analysis_runs",
	{
		id: pgText("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		status: pgText("status").notNull().default("queued"),
		requestedBy: pgText("requested_by").notNull(),
		timeFrom: pgText("time_from"),
		timeTo: pgText("time_to"),
		scopeSessions: jsonColumn<AnalysisSessionScope[]>("postgres", "scope_sessions").notNull(),
		leaseOwner: pgText("lease_owner"),
		leaseExpiresAt: pgText("lease_expires_at"),
		attemptCount: pgInteger("attempt_count").notNull().default(0),
		lastErrorCode: pgText("last_error_code"),
		startedAt: pgText("started_at"),
		completedAt: pgText("completed_at"),
		promptVersion: pgText("prompt_version"),
		providerKind: pgText("provider_kind"),
		providerModel: pgText("provider_model"),
		inputTokens: pgInteger("input_tokens").notNull().default(0),
		outputTokens: pgInteger("output_tokens").notNull().default(0),
		costCents: pgInteger("cost_cents").notNull().default(0),
		excludedSessionIds: jsonColumn<string[]>("postgres", "excluded_session_ids"),
		coverage: jsonColumn<AnalysisRunCoverage>("postgres", "coverage"),
		report: jsonColumn<AnalysisReport>("postgres", "report"),
		provenance: jsonColumn<AnalysisProvenance>("postgres", "provenance"),
		createdAt: tsColumn("postgres", "created_at"),
		updatedAt: tsColumn("postgres", "updated_at"),
	},
	(t) => ({
		statusLease: pgIndex("idx_ai_analysis_runs_status_lease").on(t.status, t.leaseExpiresAt),
		created: pgIndex("idx_ai_analysis_runs_created").on(t.createdAt),
	}),
);
