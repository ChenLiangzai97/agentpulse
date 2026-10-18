import { create } from "zustand";

/**
 * Per-session prompt drafts (taskbook P1: drafts are isolated by sessionId,
 * surviving tab switches and reloads until sent or cleared). Bounded: the
 * most recent MAX_DRAFTS sessions, each capped at MAX_DRAFT_LENGTH chars.
 */
interface PromptDraftState {
	drafts: Record<string, string>;
	order: string[];
	setDraft: (sessionId: string, text: string) => void;
	getDraft: (sessionId: string) => string;
	clearDraft: (sessionId: string) => void;
}

const MAX_DRAFTS = 50;
const MAX_DRAFT_LENGTH = 10_000;

export const usePromptDraftStore = create<PromptDraftState>((set, get) => ({
	drafts: {},
	order: [],
	setDraft: (sessionId, text) => {
		if (!sessionId) return;
		const clipped = text.length > MAX_DRAFT_LENGTH ? text.slice(0, MAX_DRAFT_LENGTH) : text;
		set((state) => {
			const drafts = { ...state.drafts, [sessionId]: clipped };
			const order = [sessionId, ...state.order.filter((id) => id !== sessionId)].slice(
				0,
				MAX_DRAFTS,
			);
			for (const evicted of state.order.filter((id) => !order.includes(id))) delete drafts[evicted];
			return { drafts, order };
		});
	},
	getDraft: (sessionId) => get().drafts[sessionId] ?? "",
	clearDraft: (sessionId) =>
		set((state) => {
			if (!(sessionId in state.drafts)) return state;
			const drafts = { ...state.drafts };
			delete drafts[sessionId];
			return { drafts, order: state.order.filter((id) => id !== sessionId) };
		}),
}));
