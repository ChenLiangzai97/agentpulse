/**
 * CAUSAL turn correlation for the closed-tab evidence. The assistant message has
 * its own id; the ONLY sound link to the user turn is the native parentID, which
 * normalizeOpenCodePart now preserves as raw_payload.parent_id. The first
 * step-finish after a user event is NOT accepted: a late step-finish from an
 * OLD turn can land after it.
 */
export interface CorrelatedEvent {
	id: number;
	event_type?: string;
	content?: string;
	raw_payload?: string;
}

export interface TurnTerminal {
	userMessageId: string;
	assistantMessageId: string;
	terminalEventId: number;
}

const payload = (row: CorrelatedEvent) => {
	try {
		return JSON.parse(row.raw_payload ?? "{}") as {
			message_id?: string;
			parent_id?: string;
			source_data?: { type?: string; reason?: string };
		};
	} catch {
		return {};
	}
};

export function findUserEvent(rows: CorrelatedEvent[], marker: string): CorrelatedEvent | null {
	for (const row of rows) {
		if (String(row.content ?? "").includes(marker)) return row;
	}
	return null;
}

/** The user message id of the marker event. */
export function userMessageId(rows: CorrelatedEvent[], marker: string): string | null {
	const user = findUserEvent(rows, marker);
	return user ? (payload(user).message_id ?? null) : null;
}

/**
 * Terminal for the CAUSAL turn: an assistant message whose parent_id is the
 * user message id, then a step-finish with reason "stop" carrying THAT assistant
 * id. An old turn's late step-finish (different parent/assistant) is ignored.
 */
export function turnTerminal(rows: CorrelatedEvent[], marker: string): TurnTerminal | null {
	const user = findUserEvent(rows, marker);
	const userId = user ? (payload(user).message_id ?? null) : null;
	if (!user || !userId) return null;
	const assistants = new Set(
		rows
			.filter((row) => {
				const p = payload(row);
				return p.parent_id === userId && typeof p.message_id === "string";
			})
			.map((row) => payload(row).message_id as string),
	);
	if (assistants.size === 0) return null;
	const terminal = rows
		.filter((row) => row.id > user.id)
		.find((row) => {
			const p = payload(row);
			return (
				p.source_data?.type === "step-finish" &&
				p.source_data.reason === "stop" &&
				typeof p.message_id === "string" &&
				assistants.has(p.message_id)
			);
		});
	if (!terminal) return null;
	const assistantMessageId = payload(terminal).message_id as string;
	return { userMessageId: userId, assistantMessageId, terminalEventId: terminal.id };
}
