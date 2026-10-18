import { describe, expect, test } from "bun:test";
import { usePromptDraftStore } from "./prompt-draft-store.js";

describe("prompt draft store", () => {
	test("drafts are isolated per session and survive store access patterns", () => {
		const store = usePromptDraftStore.getState();
		store.setDraft("s1", "first draft");
		store.setDraft("s2", "second draft");
		expect(usePromptDraftStore.getState().getDraft("s1")).toBe("first draft");
		expect(usePromptDraftStore.getState().getDraft("s2")).toBe("second draft");
		usePromptDraftStore.getState().setDraft("s1", "updated");
		expect(usePromptDraftStore.getState().getDraft("s1")).toBe("updated");
		expect(usePromptDraftStore.getState().getDraft("s2")).toBe("second draft");
	});

	test("clearing one session leaves others; unknown ids are no-ops", () => {
		usePromptDraftStore.getState().setDraft("a", "A");
		usePromptDraftStore.getState().setDraft("b", "B");
		usePromptDraftStore.getState().clearDraft("a");
		expect(usePromptDraftStore.getState().getDraft("a")).toBe("");
		expect(usePromptDraftStore.getState().getDraft("b")).toBe("B");
		usePromptDraftStore.getState().clearDraft("never-existed");
		expect(usePromptDraftStore.getState().getDraft("b")).toBe("B");
	});

	test("drafts are capped in length and count", () => {
		usePromptDraftStore.getState().setDraft("long", "x".repeat(20_000));
		expect(usePromptDraftStore.getState().getDraft("long").length).toBe(10_000);
		for (let i = 0; i < 60; i++) usePromptDraftStore.getState().setDraft(`evict-${i}`, `v${i}`);
		const state = usePromptDraftStore.getState();
		expect(Object.keys(state.drafts).length).toBeLessThanOrEqual(50);
		expect(state.drafts["long"]).toBeUndefined(); // oldest evicted
		expect(state.getDraft("evict-59")).toBe("v59");
	});
});
