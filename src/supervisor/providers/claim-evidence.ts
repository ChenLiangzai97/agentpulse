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

/** finish whitelist: "stop" or no marker; anything else is not terminal. */
const finishIsTerminal = (finish: unknown) => finish === "stop" || finish === undefined || finish === null;

/** Running tools ANYWHERE in this turn's steps (not just the last one). */
const turnHasRunningTools = (list: unknown[], messageID: string) =>
	runningTools(turnAssistants(list, messageID));

/** A completed turn: the LAST step ended with a terminal finish and no tool runs. */
export const turnTerminal = (list: unknown[], messageID: string) => {
	const last = turnAssistants(list, messageID).at(-1);
	if (!last) return false;
	const time = last.info.time as { completed?: unknown } | undefined;
	if (!time?.completed || last.info.error) return false;
	if (!finishIsTerminal(last.info.finish)) return false;
	return !turnHasRunningTools(list, messageID);
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
	// An error/cancel marker proves the NATIVE turn is over; tool side effects
	// may still be running, and an EARLIER step's tool counts too.
	if (last.info.error) return !turnHasRunningTools(list, messageID);
	const time = last.info.time as { completed?: unknown } | undefined;
	if (!time?.completed) return false;
	if (!finishIsTerminal(last.info.finish)) return false;
	return !turnHasRunningTools(list, messageID);
};
