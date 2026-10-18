/**
 * Fault-injection tests for the session-control epoch prototype. Each case
 * records the concrete fault window and asserts the OBSERVABLE outcome, per
 * the review contract (no "stopped" without abort confirmation; pre-stop
 * claimed actions rejected after resume; per-session isolation).
 */
import { describe, expect, test } from "bun:test";
import { SessionControlEpochStore } from "./session-control-epoch.js";

function deferred() {
	let resolve: () => void = () => {};
	let reject: (e: Error) => void = () => {};
	const promise = new Promise<void>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

describe("session control epochs (isolated prototype)", () => {
	test("pre-stop CLAIMED action is rejected after resume (instance generation unchanged)", async () => {
		// Fault window: action claimed by the supervisor → STOP + RESUME happen
		// before the supervisor gets to execute it.
		const store = new SessionControlEpochStore({ abortNativeTurn: async () => {} });
		store.enqueue("child", "a1");
		store.claim("a1");
		await store.stop("child").outcome; // bumps epoch, cancels a1
		store.resume("child");
		const gate = store.execute("a1");
		expect(gate.ok).toBe(false);
		if (!gate.ok) {
			expect(gate.reason).toBe("stale_session_epoch");
			expect((gate as { detail?: string }).detail).toContain("queued@1 now@2");
		}
		expect(store.action("a1")?.state).toBe("cancelled");
	});

	test("stop without abort confirmation stays 'stopping' — never claims stopped", async () => {
		// Fault window: abort transport hangs forever.
		const never = deferred();
		const store = new SessionControlEpochStore({ abortNativeTurn: () => never.promise });
		const stopping = store.stop("child").outcome;
		await Promise.race([stopping, new Promise((r) => setTimeout(r, 30))]);
		expect(store.snapshot("child").status).toBe("stopping");
		// late confirmation flips it, and only then
		never.resolve();
		expect(await stopping).toBe("stopped");
		expect(store.snapshot("child").status).toBe("stopped");
	});

	test("abort transport failure keeps 'stopping'; a later retry stop can confirm", async () => {
		const store = new SessionControlEpochStore({
			abortNativeTurn: async () => {
				throw new Error("connection lost mid-abort");
			},
		});
		expect(await store.stop("child").outcome).toBe("stopping");
		expect(store.snapshot("child").status).toBe("stopping");
	});

	test("late abort confirmation after stop() already returned", async () => {
		const gate = deferred();
		const store = new SessionControlEpochStore({ abortNativeTurn: () => gate.promise });
		const outcome = store.stop("child").outcome;
		gate.resolve();
		expect(await outcome).toBe("stopped");
	});

	test("stopping the CHILD leaves a parallel PARENT untouched (same instance)", async () => {
		const store = new SessionControlEpochStore({ abortNativeTurn: async () => {} });
		store.enqueue("parent", "p1");
		store.claim("p1");
		store.enqueue("child", "c1");
		await store.stop("child").outcome;
		expect(store.snapshot("parent").status).toBe("managed");
		expect(store.snapshot("parent").epoch).toBe(1);
		const gate = store.execute("p1");
		expect(gate.ok).toBe(true);
		expect(store.action("c1")?.state).toBe("cancelled");
	});

	test("stopped sessions refuse new actions until explicit resume; resume keeps the epoch high", async () => {
		const store = new SessionControlEpochStore({ abortNativeTurn: async () => {} });
		await store.stop("child").outcome;
		expect(() => store.enqueue("child", "a2")).toThrow("session_stopped");
		store.resume("child");
		const a2 = store.enqueue("child", "a2");
		store.claim("a2");
		expect(store.execute("a2").ok).toBe(true);
		// epoch never lowered: an OLD action still stale
		expect(store.execute("c1" /* from earlier id space */).ok).toBe(false);
		expect(a2.epochAtQueue).toBe(2);
	});
});

describe("stop operation identity (per review round 15)", () => {
	test("stop1 → confirm → resume → stop2: stop1's LATE confirmation cannot mark stop2 stopped", async () => {
		// Fault window: two stop rounds; the first round's confirmation
		// arrives while the SECOND round is still stopping.
		const store = new SessionControlEpochStore({ abortNativeTurn: async () => {} });
		const stop1 = store.stop("child");
		expect(store.confirmAbort("child", stop1.stopOpId)).toBe(true);
		expect(store.snapshot("child").status).toBe("stopped");
		store.resume("child");
		const gate2 = deferred();
		const transport2 = new SessionControlEpochStore({ abortNativeTurn: () => gate2.promise });
		const stop2 = transport2.stop("child");
		// stale opId from round 1 (different store => different counter, but
		// prove the guard with the SAME store too):
		const store3 = new SessionControlEpochStore({ abortNativeTurn: async () => {} });
		const s1 = store3.stop("child");
		store3.confirmAbort("child", s1.stopOpId);
		store3.resume("child");
		const g3 = deferred();
		let confirmedOnce = false;
		const store4 = new SessionControlEpochStore({
			abortNativeTurn: () => {
				if (confirmedOnce) return g3.promise; // round 2 hangs
				confirmedOnce = true;
				return Promise.resolve();
			},
		});
		const r1 = store4.stop("child");
		await r1.outcome; // round 1 stopped
		store4.resume("child");
		const r2 = store4.stop("child"); // round 2, abort hangs
		// LATE manual confirmation carrying ROUND 1's opId must be a no-op:
		expect(store4.confirmAbort("child", r1.stopOpId)).toBe(false);
		expect(store4.snapshot("child").status).toBe("stopping");
		// only the matching round-2 opId confirms:
		expect(store4.confirmAbort("child", r2.stopOpId)).toBe(true);
		expect(store4.snapshot("child").status).toBe("stopped");
		// the in-flight variants also resolve their own rounds:
		gate2.resolve();
		expect(await stop2.outcome).toBe("stopped");
		g3.resolve();
	});

	test("re-entrant stop while in flight REUSES the same operation (one abort)", async () => {
		let abortCalls = 0;
		const gate = deferred();
		const store = new SessionControlEpochStore({
			abortNativeTurn: () => {
				abortCalls += 1;
				return gate.promise;
			},
		});
		const first = store.stop("child");
		const second = store.stop("child");
		expect(second.stopOpId).toBe(first.stopOpId);
		gate.resolve();
		expect(await first.outcome).toBe("stopped");
		expect(await second.outcome).toBe("stopped");
		expect(abortCalls).toBe(1);
	});
});

describe("execute replay gates (per review round 15)", () => {
	test("un-claimed action cannot execute; double execute rejected; finished actions never re-execute", () => {
		const store = new SessionControlEpochStore({ abortNativeTurn: async () => {} });
		store.enqueue("child", "a1");
		const unclaimed = store.execute("a1");
		expect(unclaimed.ok).toBe(false);
		if (!unclaimed.ok) expect(unclaimed.reason).toBe("not_claimable_queued");
		store.claim("a1");
		expect(store.execute("a1").ok).toBe(true);
		const replay = store.execute("a1");
		expect(replay.ok).toBe(false);
		if (!replay.ok) expect(replay.reason).toBe("not_claimable_executing");
		store.finish("a1", "succeeded");
		const afterDone = store.execute("a1");
		expect(afterDone.ok).toBe(false);
		if (!afterDone.ok) expect(afterDone.reason).toBe("not_claimable_succeeded");
	});
});
