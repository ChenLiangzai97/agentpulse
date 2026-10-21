import { expect, test } from "bun:test";
import { abortTerminal, turnTerminal } from "./claim-evidence.js";

const step = (info: Record<string, unknown>, parts: unknown[] = []) => ({ info, parts });
const tool = (status: string) => ({ type: "tool", state: { status } });

test("an intermediate completed tool-calls step is NOT terminal", () => {
	const list = [
		step(
			{ role: "assistant", parentID: "m", time: { completed: 1 }, finish: "tool-calls" },
			[{ type: "text" }],
		),
	];
	expect(turnTerminal(list, "m")).toBe(false);
	expect(abortTerminal(list, "m")).toBe(false);
});

test("a completed final step with a running tool is NOT terminal", () => {
	const list = [step({ role: "assistant", parentID: "m", time: { completed: 1 }, finish: "stop" }, [tool("running")])];
	expect(turnTerminal(list, "m")).toBe(false);
	expect(abortTerminal(list, "m")).toBe(false);
});

test("a cancelled step (error) IS reliable abort evidence", () => {
	const list = [step({ role: "assistant", parentID: "m", error: { name: "MessageAbortedError" } })];
	expect(abortTerminal(list, "m")).toBe(true);
	expect(turnTerminal(list, "m")).toBe(false); // normal completion is stricter
});

test("only the LAST step decides; an earlier completed step does not end the turn", () => {
	const list = [
		step({ role: "assistant", parentID: "m", time: { completed: 1 }, finish: "stop" }),
		step({ role: "assistant", parentID: "m", time: { created: 2 } }), // still streaming
	];
	expect(turnTerminal(list, "m")).toBe(false);
	expect(abortTerminal(list, "m")).toBe(false);
});

test("a cancel marker with a still-running tool is NOT terminal (side effects unknown)", () => {
	const list = [
		step({ role: "assistant", parentID: "m", error: { name: "MessageAbortedError" } }, [tool("running")]),
	];
	expect(abortTerminal(list, "m")).toBe(false);
});
