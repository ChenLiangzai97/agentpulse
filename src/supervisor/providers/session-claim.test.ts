import { expect, test } from "bun:test";
import { type ClaimObservation, markAbort, newClaimState, observeClaim } from "./session-claim.js";

const idle = (seq: number, over: Partial<ClaimObservation> = {}): ClaimObservation => ({
	seq,
	status: "idle",
	quiet: true,
	turnTerminal: true,
	abortTerminal: true,
	runningTools: false,
	...over,
});

test("prompt releases on its own turn terminality, not on a completed intermediate step", () => {
	let state = newClaimState("prompt", 1);
	let out = observeClaim(state, idle(2, { turnTerminal: false }));
	state = out.state;
	expect(out.release).toBe(false); // intermediate step completed, turn continues
	out = observeClaim(state, idle(3));
	expect(out.release).toBe(true);
});

test("out-of-order snapshots cannot accumulate idle counts", () => {
	let state = newClaimState("prompt", 1);
	state = observeClaim(state, idle(5, { status: "busy" })).state;
	// Newer idle observation applied first...
	state = observeClaim(state, { ...idle(7), turnTerminal: false }).state;
	expect(state.idleObservations).toBe(1);
	// ...then a snapshot STARTED EARLIER returns late: it must be ignored.
	const late = observeClaim(state, { ...idle(6), turnTerminal: false });
	expect(late.state.idleObservations).toBe(1);
	expect(late.state.lastAppliedSeq).toBe(7);
});

test("abort resets the idle count and needs a post-abort finished step", () => {
	let state = newClaimState("prompt", 1);
	state = observeClaim(state, idle(2, { turnTerminal: false })).state;
	state = markAbort(state, 3);
	expect(state.idleObservations).toBe(0);
	// A user message with no assistant step is NOT termination (late delivery).
	let out = observeClaim(state, {
		...idle(4),
		abortTerminal: false,
		turnTerminal: false,
	});
	expect(out.release).toBe(false);
	state = out.state;
	out = observeClaim(state, idle(5, { abortTerminal: false, turnTerminal: false }));
	expect(out.release).toBe(false);
	out = observeClaim(out.state, idle(6));
	expect(out.release).toBe(true);
});

test("missing status is never counted as idle", () => {
	let state = newClaimState("command", 1);
	state = observeClaim(state, idle(2, { status: "busy" })).state;
	const out = observeClaim(state, idle(3, { status: "missing" }));
	expect(out.state.idleObservations).toBe(0);
	expect(out.release).toBe(false);
});

test("commands need an observed busy turn and two later quiet idle observations", () => {
	let state = newClaimState("command", 1);
	let out = observeClaim(state, idle(2));
	expect(out.release).toBe(false); // never observed busy
	state = observeClaim(out.state, idle(3, { status: "busy" })).state;
	out = observeClaim(state, idle(4, { runningTools: true }));
	expect(out.release).toBe(false);
	out = observeClaim(out.state, idle(5));
	expect(out.release).toBe(false); // only one quiet idle after busy
	out = observeClaim(out.state, idle(6));
	expect(out.release).toBe(true);
});

test("pre-claim observations can never settle a claim", () => {
	const state = newClaimState("prompt", 4);
	const out = observeClaim(state, idle(3));
	expect(out.release).toBe(false);
	expect(out.state).toBe(state);
});
