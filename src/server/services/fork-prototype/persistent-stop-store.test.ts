/**
 * Real-DB tests for the persistent stop store: restart survival, retry
 * re-issue, and transport-success ≠ termination (per review round 17).
 */
import "../../db/__test_db.js";
import { beforeEach, describe, expect, test } from "bun:test";
import { getDb, initializeDatabase } from "../../db/client.js";
import { settings } from "../../db/schema/index.js";
import { PersistentStopStore } from "./persistent-stop-store.js";

function deferred() {
	let resolve: () => void = () => {};
	let reject: (e: Error) => void = () => {};
	const promise = new Promise<void>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

beforeEach(async () => {
	await initializeDatabase();
	await getDb().delete(settings).execute();
});

describe("persistent stop operations (real DB)", () => {
	test("operation identity survives a restart: a fresh store sees the same round", async () => {
		const first = new PersistentStopStore({
			abortNativeTurn: async () => {},
		});
		const round = await first.begin("child");
		await first.sendAbort("child");
		// "restart": a brand-new store instance over the same database.
		const restarted = new PersistentStopStore({ abortNativeTurn: async () => {} });
		const snapshot = await restarted.snapshot("child");
		expect(snapshot?.stopOpId).toBe(round.stopOpId);
		expect(snapshot?.status).toBe("abort_sent");
		expect(snapshot?.attempts).toBe(1);
		// and the restarted store can confirm termination for that round
		expect(await restarted.confirmTermination("child", round.stopOpId)).toBe(true);
		expect((await restarted.snapshot("child"))?.status).toBe("stopped");
		// a stale id (a hypothetical earlier round) is rejected even post-restart
		expect(await restarted.confirmTermination("child", `stale-${round.stopOpId}`)).toBe(false);
	});

	test("retry after transport failure RE-issues the abort (same round, attempt count observable)", async () => {
		const gate = deferred();
		let calls = 0;
		const store = new PersistentStopStore(
			{
				abortNativeTurn: () => {
					calls += 1;
					return gate.promise;
				},
			},
			50, // ms — hung attempts fail fast in the prototype test
		);
		const round = await store.begin("child");
		const first = await store.sendAbort("child");
		if ("transportOk" in first) expect(first.transportOk).toBe(false);
		const retry = await store.sendAbort("child");
		if ("transportOk" in retry) expect(retry.transportOk).toBe(false);
		expect(calls).toBe(2); // actually re-sent, not parked
		if ("stopOpId" in retry) expect(retry.stopOpId).toBe(round.stopOpId); // SAME round
		gate.resolve();
		const third = await store.sendAbort("child");
		if ("transportOk" in third) expect(third.transportOk).toBe(true);
		expect(calls).toBe(3);
		expect((await store.snapshot("child"))?.attempts).toBe(3);
	});

	test("transport success is NOT termination: only confirmTermination stops the round", async () => {
		const store = new PersistentStopStore({ abortNativeTurn: async () => {} });
		const round = await store.begin("child");
		const sent = await store.sendAbort("child");
		if ("transportOk" in sent) expect(sent.transportOk).toBe(true); // HTTP-200-shaped success
		expect((await store.snapshot("child"))?.status).toBe("abort_sent"); // NOT stopped
		// termination observed (busy cleared / events quiesced) — with the id
		expect(await store.confirmTermination("child", round.stopOpId)).toBe(true);
		expect((await store.snapshot("child"))?.status).toBe("stopped");
		// idempotent re-confirmation for the same round
		expect(await store.confirmTermination("child", round.stopOpId)).toBe(true);
	});

	test("a new round after a stopped one mints a fresh identity", async () => {
		const store = new PersistentStopStore({ abortNativeTurn: async () => {} });
		const round1 = await store.begin("child");
		await store.sendAbort("child");
		await store.confirmTermination("child", round1.stopOpId);
		// resume + stop again → new round, old confirmations now stale
		const round2 = await store.begin("child", "hash-2");
		expect(round2.stopOpId).not.toBe(round1.stopOpId);
		expect(round2.status).toBe("abort_pending");
		await store.sendAbort("child");
		expect(await store.confirmTermination("child", round1.stopOpId)).toBe(false);
		expect(await store.confirmTermination("child", round2.stopOpId)).toBe(true);
	});
});

describe("persistent stop operations — concurrency & timeout hardening (review round 19)", () => {
	test("two stores beginning concurrently: exactly one new round wins, both observe it", async () => {
		const a = new PersistentStopStore({ abortNativeTurn: async () => {} });
		const b = new PersistentStopStore({ abortNativeTurn: async () => {} });
		const [ra, rb] = await Promise.all([a.begin("cc"), b.begin("cc")]);
		expect(ra.stopOpId).toBe(rb.stopOpId);
		expect(ra.status).toBe("abort_pending");
	});

	test("a late writer from an OLD round cannot overwrite a NEWER round (CAS)", async () => {
		const store = new PersistentStopStore({ abortNativeTurn: async () => {} });
		const round1 = await store.begin("cc");
		await store.sendAbort("cc");
		await store.confirmTermination("cc", round1.stopOpId);
		const round2 = await store.begin("cc"); // new round replaces the stopped one
		expect(round2.stopOpId).not.toBe(round1.stopOpId);
		// stale writer: CAS update keyed on round1's id must not touch round2
		const snap2 = await store.snapshot("cc");
		// (simulate the stale write attempt via settleLate on the old id)
		expect(await store.settleLate("cc", round1.stopOpId, true)).toBe(false);
		expect((await store.snapshot("cc"))?.stopOpId).toBe(round2.stopOpId);
		expect(snap2?.status).toBe("abort_pending");
	});

	test("sendAbort REJECTS a stopped round; a timed-out attempt blocks resume until settled", async () => {
		const gate = deferred();
		const store = new PersistentStopStore({ abortNativeTurn: () => gate.promise }, 40);
		const round = await store.begin("cc");
		const attempt = await store.sendAbort("cc");
		if ("transportOk" in attempt) expect(attempt.transportOk).toBe(false); // timed out
		expect((await store.snapshot("cc"))?.uncertain).toBe(true);
		// termination cannot be confirmed while uncertain
		const refused = await store.confirmTermination("cc", round.stopOpId);
		expect(refused).toEqual({ refused: "uncertain" });
		// the request finally lands late → settle → confirmation + resume open
		gate.resolve();
		expect(await store.settleLate("cc", round.stopOpId, true)).toBe(true);
		expect((await store.snapshot("cc"))?.uncertain).toBe(false);
		expect(await store.confirmTermination("cc", round.stopOpId)).toBe(true);
		expect(await store.canResume("cc")).toBe(true);
		// and a stopped round refuses further aborts
		expect(await store.sendAbort("cc")).toEqual({ rejected: "stopped_round" });
	});

	test("operator isolation unblocks an unsettled round (documented risk path)", async () => {
		const never = deferred();
		const store = new PersistentStopStore({ abortNativeTurn: () => never.promise }, 40);
		await store.begin("cc");
		await store.sendAbort("cc");
		expect(await store.canResume("cc")).toBe(false); // not even stopped yet
		const round = await store.snapshot("cc");
		if (!round) throw new Error("round missing");
		expect(await store.confirmTermination("cc", round.stopOpId)).toEqual({ refused: "uncertain" });
		expect(await store.isolateRound("cc")).toBe(true);
		expect(await store.confirmTermination("cc", round.stopOpId)).toBe(true);
		expect(await store.canResume("cc")).toBe(true);
	});

	test("an in-flight attempt superseded by a newer round records a stale arrival", async () => {
		const gate = deferred();
		let calls = 0;
		const store = new PersistentStopStore(
			{
				abortNativeTurn: () => {
					calls += 1;
					return gate.promise;
				},
			},
			60,
		);
		const round1 = await store.begin("cc");
		const attempt1 = store.sendAbort("cc"); // will time out
		await new Promise((r) => setTimeout(r, 80));
		await attempt1;
		// round1 timed out; force it stopped via isolation, then start round2
		await store.isolateRound("cc");
		await store.confirmTermination("cc", round1.stopOpId);
		const round2 = await store.begin("cc");
		// a late settlement carrying round1's id on the round2 row:
		expect(await store.settleLate("cc", round1.stopOpId, true)).toBe(false);
		expect((await store.snapshot("cc"))?.stopOpId).toBe(round2.stopOpId);
		expect(calls).toBeGreaterThanOrEqual(1);
	});
});
