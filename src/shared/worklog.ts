export interface WorklogConfig {
	enabled: boolean;
	timezone: string;
	/** Run after midnight for the previous complete calendar day. */
	time: string;
	providerId: string;
	model: string;
	documentUrl: string;
	documentId: string;
}

/** Fact categories — agent claims stay visibly separate from verified results. */
export const FACT_CATEGORIES = [
	"user_goal",
	"agent_claim",
	"tool_action",
	"verified_result",
	"open_item",
] as const;

export type FactCategory = (typeof FACT_CATEGORIES)[number];

export const FACT_CATEGORY_LABELS_ZH: Record<FactCategory, string> = {
	user_goal: "目标与指令",
	agent_claim: "助手自述（未经独立核实）",
	tool_action: "实际执行",
	verified_result: "已验证结果",
	open_item: "未完成 / 待办",
};

/**
 * One durable, redacted, evidence-linked work fact. Extracted once per day
 * from the same events the work log always read; both the personal review
 * and the team daily draft render from this shared record.
 */
export interface WorklogFact {
	/** Stable identity: derived from session + evidence + content. */
	id: string;
	sessionId: string;
	host: string | null;
	/** ISO timestamp of the SOURCE event (occurrence time, not ingestion). */
	occurredAt: string;
	category: FactCategory;
	/** Redacted, bounded prose. Never trusted as instructions. */
	text: string;
	/** Deep-linkable evidence: the events.id the fact was extracted from. */
	evidenceEventId: number;
	projectHint: string | null;
	confidence: "stated" | "verified" | "inferred";
	/** Normalized content hash of (final category, text). */
	contentKey: string;
	/** Root session of the lineage (`:opencode-child:` segments stripped). */
	lineageRoot: string;
	/**
	 * Trusted copy reference (e.g. `sessionId:eventId` of the original event
	 * this one was copied from), set only by ingestion paths that PROVE the
	 * copy. Null when no copy mapping exists — such facts are always kept.
	 */
	copyOf: string | null;
}

/** Versioned output storage: regeneration appends, never overwrites. */
export interface WorklogVersion {
	versionId: string;
	kind: "personal" | "team";
	markdown: string;
	createdAt: string;
	generator: { model: string | null; source: "facts" | "manual" };
}

export interface WorklogRun {
	date: string;
	timezone: string;
	status: "generating" | "ready" | "delivered" | "failed";
	markdown: string;
	sessionIds: string[];
	error: string | null;
	updatedAt: string;
	documentUrl?: string;
	/** Unified fact record (P4); absent on runs produced before the upgrade. */
	facts?: WorklogFact[];
	factMeta?: {
		model: string;
		extractedAt: string;
		rejected: number;
		deduped: number;
		downgraded: number;
	} | null;
	/** Append-only view versions: personal review + team drafts (+ manual edits). */
	versions?: WorklogVersion[];
	/** Which version delivery/export uses; defaults to the latest team version. */
	adoptedVersionId?: string | null;
}

export const DEFAULT_WORKLOG_CONFIG: WorklogConfig = {
	enabled: false,
	timezone: "Asia/Shanghai",
	time: "00:05",
	providerId: "",
	model: "",
	documentUrl: "",
	documentId: "",
};
