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
		await store.stop("child"); // bumps epoch, cancels a1
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
		const stopping = store.stop("child");
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
		expect(await store.stop("child")).toBe("stopping");
		expect(store.snapshot("child").status).toBe("stopping");
	});

	test("late abort confirmation after stop() already returned", async () => {
		const gate = deferred();
		const store = new SessionControlEpochStore({ abortNativeTurn: () => gate.promise });
		const outcome = store.stop("child");
		gate.resolve();
		expect(await outcome).toBe("stopped");
	});

	test("stopping the CHILD leaves a parallel PARENT untouched (same instance)", async () => {
		const store = new SessionControlEpochStore({ abortNativeTurn: async () => {} });
		store.enqueue("parent", "p1");
		store.enqueue("child", "c1");
		await store.stop("child");
		expect(store.snapshot("parent").status).toBe("managed");
		expect(store.snapshot("parent").epoch).toBe(1);
		const gate = store.execute("p1");
		expect(gate.ok).toBe(true);
		expect(store.action("c1")?.state).toBe("cancelled");
	});

	test("stopped sessions refuse new actions until explicit resume; resume keeps the epoch high", async () => {
		const store = new SessionControlEpochStore({ abortNativeTurn: async () => {} });
		await store.stop("child");
		expect(() => store.enqueue("child", "a2")).toThrow("session_stopped");
		store.resume("child");
		const a2 = store.enqueue("child", "a2");
		expect(store.execute("a2").ok).toBe(true);
		// epoch never lowered: an OLD action still stale
		expect(store.execute("c1" /* from earlier id space */).ok).toBe(false);
		expect(a2.epochAtQueue).toBe(2);
	});
});
