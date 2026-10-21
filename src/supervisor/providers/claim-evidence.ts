/**
 * Message-level evidence for a claimed request (no status dependency):
 * the runtime decides whether THIS request's turn has reliably ended.
 */
export const turnAssistants = (list: unknown[], messageID: string) =>
	list.filter((item) => {
		const info = (item as { info?: Record<string, unknown> })?.info;
		return info?.role === "assistant" && info?.parentID === messageID;
	}) as { info: Record<string, unknown> }[];

export const runningTools = (list: unknown[]) =>
	list.some(
		(value) =>
			Array.isArray((value as { parts?: unknown[] }).parts) &&
			(value as { parts: unknown[] }).parts.some((part) => {
				const p = part as { type?: string; state?: { status?: string } };
				return p.type === "tool" && ["running", "pending"].includes(p.state?.status ?? "");
			}),
	);

/** A completed turn: the LAST step finished with "stop" and no tool runs. */
export const turnTerminal = (list: unknown[], messageID: string) => {
	const last = turnAssistants(list, messageID).at(-1);
	if (!last) return false;
	const time = last.info.time as { completed?: unknown } | undefined;
	if (!time?.completed || last.info.error) return false;
	if (last.info.finish === "tool-calls") return false;
	return !runningTools([last]);
};

/**
 * RELIABLE end-of-turn evidence after an abort: an error/cancel marker, or a
 * completed final step (finish "stop" / no finish) with no running tool. An
 * intermediate completed "tool-calls" step and a still-running tool are NOT
 * completion.
 */
export const abortTerminal = (list: unknown[], messageID: string) => {
	const last = turnAssistants(list, messageID).at(-1);
	if (!last) return false;
	if (last.info.error) return true;
	const time = last.info.time as { completed?: unknown } | undefined;
	if (!time?.completed) return false;
	if (last.info.finish === "tool-calls") return false;
	return !runningTools([last]);
};
