import { expect, test } from "bun:test";
import { AbortAttempts } from "./abort-attempts.js";

test("claim release alone never lifts the fence while the request is in flight", () => {
	const attempts = new AbortAttempts();
	attempts.begin("ses", "a1", "c1");
	expect(attempts.frozen("ses")).toBe(true);
	attempts.claimEnded("ses", "c1"); // natural completion during a slow abort
	expect(attempts.frozen("ses")).toBe(true); // NOT released
	attempts.respond("ses", "a1");
	expect(attempts.frozen("ses")).toBe(false);
});

test("a response before the claim ends keeps the fence until the claim ends", () => {
	const attempts = new AbortAttempts();
	attempts.begin("ses", "a1", "c1");
	attempts.respond("ses", "a1");
	expect(attempts.frozen("ses")).toBe(true);
	attempts.claimEnded("ses", "c1");
	expect(attempts.frozen("ses")).toBe(false);
});

test("repeated aborts are independent attempts (no boolean masking)", () => {
	const attempts = new AbortAttempts();
	attempts.begin("ses", "a1", "c1");
	attempts.begin("ses", "a2", "c1");
	attempts.respond("ses", "a1");
	attempts.claimEnded("ses", "c1");
	// a2 is still in flight: the target stays frozen.
	expect(attempts.frozen("ses")).toBe(true);
	expect(attempts.pending("ses").map((a) => a.attemptId)).toEqual(["a2"]);
	attempts.respond("ses", "a2");
	expect(attempts.frozen("ses")).toBe(false);
});

test("attempts are per target", () => {
	const attempts = new AbortAttempts();
	attempts.begin("ses-a", "a1", "c1");
	expect(attempts.frozen("ses-b")).toBe(false);
});

test("an abandoned attempt (request never sent) never freezes the target", () => {
	const attempts = new AbortAttempts();
	attempts.begin("ses", "a1", "c1");
	attempts.abandon("ses", "a1");
	expect(attempts.frozen("ses")).toBe(false);
});

test("a standalone attempt is settled only by a VERIFIED observation after the response", () => {
	const attempts = new AbortAttempts();
	attempts.begin("ses", "a1", ""); // no claim to end
	expect(attempts.frozen("ses")).toBe(true);
	// Quiet observation BEFORE the response must not clear it.
	expect(attempts.settleResponded("ses")).toEqual([]);
	expect(attempts.frozen("ses")).toBe(true);
	expect(attempts.respond("ses", "a1")).toBe(false); // response alone is not proof
	expect(attempts.frozen("ses")).toBe(true);
	expect(attempts.settleResponded("ses").map((a) => a.attemptId)).toEqual(["a1"]);
	expect(attempts.frozen("ses")).toBe(false);
});

test("claimEnded returns exactly the attempts it settled (for file cleanup)", () => {
	const attempts = new AbortAttempts();
	attempts.begin("ses", "a1", "c1");
	attempts.begin("ses", "a2", "c1");
	attempts.respond("ses", "a1");
	const settled = attempts.claimEnded("ses", "c1");
	expect(settled.map((attempt) => attempt.attemptId)).toEqual(["a1"]);
	// a2 (responded=false) must still be tracked.
	expect(attempts.pending("ses").map((attempt) => attempt.attemptId)).toEqual(["a2"]);
});
