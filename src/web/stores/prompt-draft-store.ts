import { create } from "zustand";
import { useUserStore } from "./user-store.js";

/**
 * Per-session prompt drafts (taskbook P1). Drafts are isolated by sessionId,
 * PERSISTED per viewer (same isolation rules as tabs-store: nothing is read
 * or written before the viewer is known; switching identity loads the new
 * viewer's drafts and drops the previous person's from memory), bounded to
 * the most recent MAX_DRAFTS sessions at MAX_DRAFT_LENGTH chars (the input's
 * own maxLength — so nothing is ever silently truncated below what the user
 * could type), and versioned per session so an in-flight send can only clear
 * a draft it actually sent (a callback for session A must not clear B, nor a
 * draft the user rewrote while the send was running).
 */
interface PromptDraftState {
	drafts: Record<string, string>;
	order: string[];
	/**
	 * Monotonic per-session edit counter — runtime only, never persisted, and
	 * NEVER reset across viewer switches, so a stale callback's (session,
	 * version) pair can never collide with a different viewer's counters.
	 */
	versions: Record<string, number>;
	/** Viewer epoch: bumped whenever the viewer is adopted or forgotten. */
	generation: number;
	setDraft: (sessionId: string, text: string) => void;
	getDraft: (sessionId: string) => string;
	currentVersion: (sessionId: string) => number;
	currentGeneration: () => number;
	clearDraft: (sessionId: string) => void;
	/**
	 * Full send-completion guard: the input/draft may be cleared only when
	 * the viewer epoch, the session identity AND the draft version all still
	 * match what was captured when the send started.
	 */
	canClearSent: (sessionId: string, version: number, generation: number) => boolean;
}

const STORAGE_BASE = "agentpulse.promptDrafts";
const MAX_DRAFTS = 50;
const MAX_DRAFT_LENGTH = 12_000; // matches the textarea's maxLength

function keyFor(userId: string | null): string {
	return userId === null ? STORAGE_BASE : `${STORAGE_BASE}.${userId}`;
}

let storageKey: string | null = null;

function read(key: string): { drafts: Record<string, string>; order: string[] } {
	if (typeof localStorage === "undefined") return { drafts: {}, order: [] };
	try {
		const raw = localStorage.getItem(key);
		if (!raw) return { drafts: {}, order: [] };
		const parsed = JSON.parse(raw) as { drafts?: Record<string, string>; order?: string[] };
		if (!parsed || typeof parsed !== "object" || !parsed.drafts) return { drafts: {}, order: [] };
		const order = Array.isArray(parsed.order)
			? parsed.order.filter((id) => typeof id === "string" && id in parsed.drafts!)
			: [];
		return { drafts: parsed.drafts, order };
	} catch {
		return { drafts: {}, order: [] };
	}
}

function save(drafts: Record<string, string>, order: string[]) {
	if (storageKey === null || typeof localStorage === "undefined") return;
	try {
		localStorage.setItem(storageKey, JSON.stringify({ drafts, order }));
	} catch {
		// quota or privacy mode — keep drafts in memory only
	}
}

export const usePromptDraftStore = create<PromptDraftState>((set, get) => ({
	drafts: {},
	order: [],
	versions: {},
	generation: 0,
	setDraft: (sessionId, text) => {
		if (!sessionId) return;
		// Unknown viewer: writes are disabled entirely — nothing may leak
		// into (or read from) the previous person's storage key.
		if (storageKey === null) return;
		const clipped = text.length > MAX_DRAFT_LENGTH ? text.slice(0, MAX_DRAFT_LENGTH) : text;
		set((state) => {
			const drafts = { ...state.drafts, [sessionId]: clipped };
			const order = [sessionId, ...state.order.filter((id) => id !== sessionId)].slice(
				0,
				MAX_DRAFTS,
			);
			for (const evicted of state.order.filter((id) => !order.includes(id))) delete drafts[evicted];
			const versions = { ...state.versions, [sessionId]: (state.versions[sessionId] ?? 0) + 1 };
			save(drafts, order);
			return { drafts, order, versions };
		});
	},
	getDraft: (sessionId) => get().drafts[sessionId] ?? "",
	currentVersion: (sessionId) => get().versions[sessionId] ?? 0,
	currentGeneration: () => get().generation,
	clearDraft: (sessionId) =>
		set((state) => {
			if (!(sessionId in state.drafts)) return state;
			const drafts = { ...state.drafts };
			delete drafts[sessionId];
			const order = state.order.filter((id) => id !== sessionId);
			save(drafts, order);
			return { drafts, order };
		}),
	canClearSent: (sessionId, version, generation) => {
		if (get().generation !== generation) return false;
		if (get().versions[sessionId] !== version) return false;
		return true;
	},
}));

// ── viewer isolation (mirrors tabs-store): drafts follow the signed-in person.
let adoptedFor: { userId: string | null } | null = null;
function adoptViewer() {
	const { loaded, userId } = useUserStore.getState();
	if (!loaded) {
		adoptedFor = null;
		// Nobody is known: stop writing (storageKey=null disables setDraft),
		// drop the previous person's drafts from memory (their saved drafts
		// stay in storage for their next visit), and start a new viewer epoch
		// so in-flight callbacks from the previous epoch are all invalidated.
		storageKey = null;
		if (
			Object.keys(usePromptDraftStore.getState().drafts).length > 0 ||
			usePromptDraftStore.getState().generation === 0
		)
			usePromptDraftStore.setState((state) => ({
				drafts: {},
				order: [],
				generation: state.generation + 1,
			}));
		else usePromptDraftStore.setState((state) => ({ generation: state.generation + 1 }));
		return;
	}
	if (adoptedFor && adoptedFor.userId === userId) return;
	adoptedFor = { userId };
	storageKey = keyFor(userId);
	const { drafts, order } = read(storageKey);
	// Versions intentionally carry over (never reset): a stale callback must
	// fail on the generation check alone, not on a recycled version counter.
	usePromptDraftStore.setState((state) => ({ drafts, order, generation: state.generation + 1 }));
}
useUserStore.subscribe(adoptViewer);
adoptViewer();
