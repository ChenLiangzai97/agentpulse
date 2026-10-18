import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { usePromptDraftStore } from "./prompt-draft-store.js";
import { useUserStore } from "./user-store.js";

const files = new Map<string, string>();
const realStorage = (globalThis as unknown as { localStorage?: unknown }).localStorage;

beforeEach(() => {
	files.clear();
	(globalThis as unknown as { localStorage: unknown }).localStorage = {
		getItem: (key: string) => files.get(key) ?? null,
		setItem: (key: string, value: string) => void files.set(key, value),
		removeItem: (key: string) => void files.delete(key),
	};
	useUserStore.setState({ userId: null, mode: "team", loaded: false } as never);
	usePromptDraftStore.setState({ drafts: {}, order: [], versions: {} });
});

afterEach(() => {
	(globalThis as unknown as { localStorage?: unknown }).localStorage = realStorage;
});

/** Re-adopting a viewer re-reads storage — equivalent to a page reload. */
function reloadAs(userId: string | null) {
	useUserStore.setState({ userId, loaded: true } as never);
}

describe("prompt draft store", () => {
	test("drafts are isolated per session and survive a simulated reload", () => {
		reloadAs("A");
		usePromptDraftStore.getState().setDraft("s1", "first draft");
		usePromptDraftStore.getState().setDraft("s2", "second draft");
		// "reload": viewer re-adoption re-reads persisted state.
		reloadAs("A");
		expect(usePromptDraftStore.getState().getDraft("s1")).toBe("first draft");
		expect(usePromptDraftStore.getState().getDraft("s2")).toBe("second draft");
		expect(files.has("agentpulse.promptDrafts.A")).toBe(true);
	});

	test("viewer isolation: switching identity drops memory, keeps storage per person", () => {
		reloadAs("A");
		usePromptDraftStore.getState().setDraft("s1", "A's draft");
		useUserStore.setState({ userId: "B", loaded: true } as never);
		expect(usePromptDraftStore.getState().getDraft("s1")).toBe("");
		usePromptDraftStore.getState().setDraft("s2", "B's draft");
		reloadAs("A");
		expect(usePromptDraftStore.getState().getDraft("s1")).toBe("A's draft");
		expect(usePromptDraftStore.getState().getDraft("s2")).toBe("");
		// nobody known: memory cleared, storage preserved
		useUserStore.setState({ userId: null, loaded: false } as never);
		expect(usePromptDraftStore.getState().getDraft("s1")).toBe("");
		expect(files.get("agentpulse.promptDrafts.A")).toBeTruthy();
	});

	test("version guard: an in-flight send clears only the draft it sent", () => {
		reloadAs("A");
		usePromptDraftStore.getState().setDraft("s1", "v1 content");
		const versionAtSend = usePromptDraftStore.getState().currentVersion("s1");
		// user rewrites the draft while the send is running
		usePromptDraftStore.getState().setDraft("s1", "rewritten during send");
		expect(usePromptDraftStore.getState().clearDraftIfUntouched("s1", versionAtSend)).toBe(false);
		expect(usePromptDraftStore.getState().getDraft("s1")).toBe("rewritten during send");
		// clearing with the CURRENT version succeeds
		const now = usePromptDraftStore.getState().currentVersion("s1");
		expect(usePromptDraftStore.getState().clearDraftIfUntouched("s1", now)).toBe(true);
		expect(usePromptDraftStore.getState().getDraft("s1")).toBe("");
		// A's clear never touches B
		usePromptDraftStore.getState().setDraft("sB", "B stays");
		usePromptDraftStore.getState().clearDraft("s1");
		expect(usePromptDraftStore.getState().getDraft("sB")).toBe("B stays");
	});

	test("drafts are capped in length and count; cap equals the input's maxLength", () => {
		reloadAs("A");
		usePromptDraftStore.getState().setDraft("long", "x".repeat(20_000));
		expect(usePromptDraftStore.getState().getDraft("long").length).toBe(12_000);
		for (let i = 0; i < 60; i++) usePromptDraftStore.getState().setDraft(`evict-${i}`, `v${i}`);
		const state = usePromptDraftStore.getState();
		expect(Object.keys(state.drafts).length).toBeLessThanOrEqual(50);
		expect(state.getDraft("evict-59")).toBe("v59");
	});
});
