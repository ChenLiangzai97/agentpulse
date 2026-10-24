import { expect, test } from "bun:test";
import { turnTerminal, userMessageId } from "./p1-turn-correlation.js";

const row = (id: number, raw: Record<string, unknown>, content = "") => ({
	id,
	content,
	raw_payload: JSON.stringify(raw),
});
const stop = (message_id: string) => ({ message_id, source_data: { type: "step-finish", reason: "stop" } });

test("correlates the assistant by parent_id, not by 'first step-finish after'", () => {
	const rows = [
		row(1, { message_id: "msg_user", parent_id: null }, "MARK"),
		// A LATE step-finish from an OLD turn landing after this user event.
		row(2, stop("msg_old_assistant")),
		row(3, { message_id: "msg_this_assistant", parent_id: "msg_user" }),
		row(4, stop("msg_this_assistant")),
	];
	expect(userMessageId(rows, "MARK")).toBe("msg_user");
	expect(turnTerminal(rows, "MARK")).toEqual({
		userMessageId: "msg_user",
		assistantMessageId: "msg_this_assistant",
		terminalEventId: 4,
	});
});

test("a turn with only an OLD late step-finish is NOT terminal", () => {
	const rows = [
		row(1, { message_id: "msg_user", parent_id: null }, "MARK2"),
		row(2, stop("msg_old_assistant")),
	];
	expect(turnTerminal(rows, "MARK2")).toBeNull();
});

test("an assistant without parent_id is never attributed to the turn", () => {
	const rows = [
		row(1, { message_id: "msg_user", parent_id: null }, "MARK3"),
		row(2, { message_id: "msg_unrelated" }),
		row(3, stop("msg_unrelated")),
	];
	expect(turnTerminal(rows, "MARK3")).toBeNull();
});
