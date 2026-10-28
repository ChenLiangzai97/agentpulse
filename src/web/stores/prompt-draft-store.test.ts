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

	test("send guard: rewrite during send blocks the clear; matching capture clears", () => {
		reloadAs("A");
		usePromptDraftStore.getState().setDraft("s1", "v1 content");
		const versionAtSend = usePromptDraftStore.getState().currentVersion("s1");
		const generationAtSend = usePromptDraftStore.getState().currentGeneration();
		// user rewrites the draft while the send is running
		usePromptDraftStore.getState().setDraft("s1", "rewritten during send");
		expect(usePromptDraftStore.getState().canClearSent("s1", versionAtSend, generationAtSend)).toBe(
			false,
		);
		expect(usePromptDraftStore.getState().getDraft("s1")).toBe("rewritten during send");
		// clearing with the CURRENT capture succeeds
		const nowVersion = usePromptDraftStore.getState().currentVersion("s1");
		expect(usePromptDraftStore.getState().canClearSent("s1", nowVersion, generationAtSend)).toBe(
			true,
		);
		usePromptDraftStore.getState().clearDraft("s1");
		expect(usePromptDraftStore.getState().getDraft("s1")).toBe("");
		// A's clear never touches B
		usePromptDraftStore.getState().setDraft("sB", "B stays");
		usePromptDraftStore.getState().clearDraft("s1");
		expect(usePromptDraftStore.getState().getDraft("sB")).toBe("B stays");
	});

	test("viewer generation: a stale callback from a previous epoch is rejected", () => {
		reloadAs("A");
		usePromptDraftStore.getState().setDraft("s1", "A drafts");
		const staleVersion = usePromptDraftStore.getState().currentVersion("s1");
		const staleGeneration = usePromptDraftStore.getState().currentGeneration();
		// the viewer switches (or signs out) while A's send is in flight
		useUserStore.setState({ userId: "B", loaded: true } as never);
		// B builds the SAME (session, version) pair — the epoch must still reject it
		usePromptDraftStore.getState().setDraft("s1", "B drafts");
		const bVersion = usePromptDraftStore.getState().currentVersion("s1");
		expect(bVersion).toBe(staleVersion + 1);
		expect(usePromptDraftStore.getState().canClearSent("s1", staleVersion, staleGeneration)).toBe(
			false,
		);
		// even a matching version under the stale generation is rejected
		expect(usePromptDraftStore.getState().canClearSent("s1", bVersion, staleGeneration)).toBe(
			false,
		);
		// the CURRENT generation with the current capture clears
		expect(
			usePromptDraftStore
				.getState()
				.canClearSent("s1", bVersion, usePromptDraftStore.getState().currentGeneration()),
		).toBe(true);
	});

	test("unknown viewer: writes are disabled and nothing leaks to a previous key", () => {
		reloadAs("A");
		usePromptDraftStore.getState().setDraft("s1", "A's last draft");
		useUserStore.setState({ userId: null, loaded: false } as never);
		// typing while nobody is known is a no-op (no memory, no disk write)
		usePromptDraftStore.getState().setDraft("s1", "should vanish");
		expect(usePromptDraftStore.getState().getDraft("s1")).toBe("");
		expect((files.get("agentpulse.promptDrafts.A") ?? "").includes("should vanish")).toBe(false);
		// A's saved draft is intact for their next visit
		reloadAs("A");
		expect(usePromptDraftStore.getState().getDraft("s1")).toBe("A's last draft");
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
