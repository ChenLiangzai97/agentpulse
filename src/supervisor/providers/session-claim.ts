/**
 * Per-session execution claim state machine (A6). Pure: the runtime feeds it
 * observations and it says whether the claim may be released.
 *
 * Ordering is part of the contract: a snapshot carries the sequence number it
 * was STARTED with, and a snapshot older than the last applied one is ignored
 * wholesale — a late idle response must not be mistaken for a later
 * observation, and "consecutive non-busy" means strictly increasing sequence.
 */
export type ClaimKind = "prompt" | "command";

export interface ClaimState {
	kind: ClaimKind;
	/** Generation the claim was created in; older observations are powerless. */
	createdSeq: number;
	/** Highest observation generation applied so far (rejects out-of-order). */
	lastAppliedSeq: number;
	abortRequested: boolean;
	/** Generation of the abort; only observations started after it may count. */
	abortSeq?: number;
	seenBusy: boolean;
	/** Consecutive non-busy observations, reset on busy and on abort. */
	idleObservations: number;
}

export interface ClaimObservation {
	seq: number;
	/** "missing" = OpenCode reported no status (not proof of idleness). */
	status: "missing" | "busy" | "idle";
	/** No pending permission/question for the target. */
	quiet: boolean;
	/** The request's LAST assistant step is completed with finish "stop". */
	turnTerminal: boolean;
	/** The request's last step completed OR was cancelled/errored. */
	abortTerminal: boolean;
	runningTools: boolean;
}

export function newClaimState(kind: ClaimKind, createdSeq: number): ClaimState {
	return {
		kind,
		createdSeq,
		lastAppliedSeq: createdSeq - 1,
		abortRequested: false,
		seenBusy: false,
		idleObservations: 0,
	};
}

/** Marks an accepted abort; the idle count starts over AFTER the abort. */
export function markAbort(state: ClaimState, abortSeq: number): ClaimState {
	return { ...state, abortRequested: true, abortSeq, idleObservations: 0 };
}

export function observeClaim(
	state: ClaimState,
	observation: ClaimObservation,
): { state: ClaimState; release: boolean } {
	const { seq } = observation;
	// Reject out-of-order and pre-claim observations outright.
	if (seq <= state.lastAppliedSeq || seq < state.createdSeq) return { state, release: false };
	const next: ClaimState = { ...state, lastAppliedSeq: seq };
	// Once an abort is requested, no observation STARTED BEFORE it may settle
	// the claim — for prompts and commands alike. It only advances the applied
	// sequence; counters are left untouched.
	if (state.abortRequested && state.abortSeq !== undefined && seq < state.abortSeq) {
		return { state: { ...state, lastAppliedSeq: seq }, release: false };
	}
	if (observation.status === "busy") {
		next.seenBusy = true;
		next.idleObservations = 0;
		return { state: next, release: false };
	}
	// A missing status proves nothing about idleness and is not counted. It is
	// NOT a release signal for commands or aborts. For a plain prompt it does
	// not matter: the turn's own last step (completed, finish "stop") is
	// positive message-level evidence that does not depend on status at all.
	if (observation.status === "missing") {
		const byTurn =
			state.kind === "prompt" &&
			!state.abortRequested &&
			observation.quiet &&
			observation.turnTerminal;
		return { state: next, release: byTurn };
	}
	if (observation.runningTools) {
		next.idleObservations = 0;
		return { state: next, release: false };
	}
	next.idleObservations += 1;

	if (state.kind === "command") {
		if (state.abortRequested) {
			// Commands carry no request correlation: after an abort only repeated
			// post-abort quiet observations can settle them.
			const release =
				state.abortSeq !== undefined &&
				seq >= state.abortSeq &&
				next.idleObservations >= 2 &&
				observation.quiet &&
				!observation.runningTools;
			return { state: next, release };
		}
		const release =
			next.seenBusy && next.idleObservations >= 2 && observation.quiet && !observation.runningTools;
		return { state: next, release };
	}

	const afterAbort =
		state.abortRequested && state.abortSeq !== undefined && seq >= state.abortSeq;
	if (afterAbort) {
		// An accepted abort is NOT termination. Only a finished/cancelled last
		// step proves the turn ended; "user message exists but no reply yet"
		// stays UNKNOWN (late delivery window) and remains held for reconciliation.
		return { state: next, release: observation.quiet && observation.abortTerminal };
	}
	// Positive completion evidence needs no idle counting: the turn's own last
	// step says it finished. An intermediate step never satisfies this.
	return { state: next, release: observation.quiet && observation.turnTerminal };
}
