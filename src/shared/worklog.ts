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
export interface WorklogRun {
	date: string;
	timezone: string;
	status: "generating" | "ready" | "delivered" | "failed";
	markdown: string;
	sessionIds: string[];
	error: string | null;
	updatedAt: string;
	documentUrl?: string;
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
