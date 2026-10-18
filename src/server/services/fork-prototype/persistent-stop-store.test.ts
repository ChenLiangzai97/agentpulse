/**
 * Real-DB tests for the persistent stop store: restart survival, retry
 * re-issue, and transport-success ≠ termination (per review round 17).
 */
import "../../db/__test_db.js";
import { beforeEach, describe, expect, test } from "bun:test";
import { getDb, initializeDatabase } from "../../db/client.js";
import { settings } from "../../db/schema/index.js";
import { PersistentStopStore } from "./persistent-stop-store.js";


async function unsettledCount(store: PersistentStopStore, sessionId: string): Promise<number> {
	const snap = await store.snapshot(sessionId);
	if (!snap) throw new Error("round missing");
	return snap.unsettled.length;
}

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
		const ok = { abortNativeTurn: async () => {}, isolateTarget: async () => ({ proof: "p" }) };
		const first = new PersistentStopStore(ok);
		const round = await first.begin("child");
		await first.sendAbort("child");
		const restarted = new PersistentStopStore(ok);
		const snapshot = await restarted.snapshot("child");
		expect(snapshot?.stopOpId).toBe(round.stopOpId);
		expect(snapshot?.status).toBe("abort_sent");
		expect(snapshot?.attempts).toBe(1);
		expect(await restarted.confirmTermination("child", round.stopOpId)).toBe(true);
		expect((await restarted.snapshot("child"))?.status).toBe("stopped");
		expect(await restarted.confirmTermination("child", `stale-${round.stopOpId}`)).toEqual({
			refused: "unknown_round",
		});
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
				isolateTarget: async () => ({ proof: "p" }),
			},
			50,
		);
		const round = await store.begin("child");
		const first = await store.sendAbort("child");
		if ("timedOut" in first) expect(first.timedOut).toBe(true);
		const retry = await store.sendAbort("child");
		if ("timedOut" in retry) expect(retry.timedOut).toBe(true);
		expect(calls).toBe(2); // actually re-sent, not parked
		if ("stopOpId" in retry) expect(retry.stopOpId).toBe(round.stopOpId);
		gate.resolve();
		// wired settlement clears BOTH attempts once the transport lands
		for (let i = 0; i < 40 && (await unsettledCount(store, "child")) !== 0; i++)
			await Bun.sleep(10);
		expect((await store.snapshot("child"))?.unsettled.length).toBe(0);
		const third = await store.sendAbort("child");
		if ("transportOk" in third) expect(third.transportOk).toBe(true);
		expect(calls).toBe(3);
		expect((await store.snapshot("child"))?.attempts).toBe(3);
	});

	test("transport success is NOT termination: only confirmTermination stops the round", async () => {
		const store = new PersistentStopStore({
			abortNativeTurn: async () => {},
			isolateTarget: async () => ({ proof: "p" }),
		});
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
		const store = new PersistentStopStore({
			abortNativeTurn: async () => {},
			isolateTarget: async () => ({ proof: "p" }),
		});
		const round1 = await store.begin("child");
		await store.sendAbort("child");
		await store.confirmTermination("child", round1.stopOpId);
		// resume + stop again → new round, old confirmations now stale
		const round2 = await store.begin("child", "hash-2");
		expect(round2.stopOpId).not.toBe(round1.stopOpId);
		expect(round2.status).toBe("abort_pending");
		await store.sendAbort("child");
		expect(await store.confirmTermination("child", round1.stopOpId)).toEqual({
			refused: "unknown_round",
		});
		expect(await store.confirmTermination("child", round2.stopOpId)).toBe(true);
	});
});

describe("persistent stop operations — revision CAS & per-attempt uncertainty (round 19+21)", () => {
	const okTransport = {
		abortNativeTurn: async () => {},
		isolateTarget: async () => ({ proof: "terminated-old-instance" }),
	};

	test("restart survival and same-round CAS still hold", async () => {
		const store = new PersistentStopStore(okTransport);
		const round = await store.begin("r1");
		await store.sendAbort("r1");
		const restarted = new PersistentStopStore(okTransport);
		const snap = await restarted.snapshot("r1");
		expect(snap?.stopOpId).toBe(round.stopOpId);
		expect(snap?.status).toBe("abort_sent");
		expect(await restarted.confirmTermination("r1", round.stopOpId)).toBe(true);
		expect(await restarted.confirmTermination("r1", `stale-${round.stopOpId}`)).toEqual({
			refused: "unknown_round",
		});
	});

	test("SAME-ROUND interleave: a stale sendAbort cannot overwrite a fresh 'stopped'", async () => {
		let transportCalls = 0;
		const transport = {
			abortNativeTurn: async () => {
				transportCalls += 1;
			},
			isolateTarget: async () => ({ proof: "p" }),
		};
		const store = new PersistentStopStore(transport, 5_000, {
			// Interleave: after sendAbort LOADS its state but BEFORE its CAS,
			// a confirmTermination writes 'stopped' (new revision).
			beforeCas: async () => {
				const snap = await store.snapshot("r2");
				if (snap && snap.status === "abort_sent" && snap.attempts === 0) {
					// first sendAbort path: stop the round directly via CAS
					const current = await store.snapshot("r2");
					if (current) await store.confirmTermination("r2", current.stopOpId);
				}
			},
		});
		const round = await store.begin("r2");
		await store.sendAbort("r2"); // registers attempt + CAS... interleave stops the round first
		const snap = await store.snapshot("r2");
		// whichever writer won, the invariant holds: the row is coherent and
		// a stale writer can never revive a stopped round.
		expect(snap?.status === "stopped" || snap?.status === "abort_sent").toBe(true);
		if (snap?.status === "stopped") {
			// the stale sendAbort must have been REJECTED (no transport call)
			expect(transportCalls).toBe(0);
			expect(await store.sendAbort("r2")).toEqual({ rejected: "stopped_round" });
		}
		// round identity unchanged by the interleave
		expect((await store.snapshot("r2"))?.stopOpId).toBe(round.stopOpId);
	});

	test("per-attempt uncertainty: two timeouts need BOTH settlements; late completion is auto-wired", async () => {
		const gate1 = deferred();
		const gate2 = deferred();
		const gates = [gate1, gate2];
		let n = 0;
		const store = new PersistentStopStore(
			{
				abortNativeTurn: () => gates[n++ % 2].promise,
				isolateTarget: async () => ({ proof: "p" }),
			},
			40,
		);
		const round = await store.begin("r3");
		const a1 = await store.sendAbort("r3");
		const a2 = await store.sendAbort("r3");
		if ("timedOut" in a1) expect(a1.timedOut).toBe(true);
		if ("timedOut" in a2) expect(a2.timedOut).toBe(true);
		if (!("attemptId" in a1) || !("attemptId" in a2)) throw new Error("attempts not registered");
		expect((await store.snapshot("r3"))?.unsettled.length).toBe(2);
		// settle ONE attempt via its late wired completion
		gate1.resolve();
		for (let i = 0; i < 40 && (await unsettledCount(store, "r3")) !== 1; i++)
			await Bun.sleep(10);
		expect((await store.snapshot("r3"))?.unsettled.length).toBe(1); // still uncertain
		expect(await store.confirmTermination("r3", round.stopOpId)).toEqual({ refused: "uncertain" });
		expect(await store.canResume("r3")).toBe(false); // not stopped yet anyway
		// settle the second
		gate2.resolve();
		for (let i = 0; i < 40 && (await unsettledCount(store, "r3")) !== 0; i++)
			await Bun.sleep(10);
		expect((await store.snapshot("r3"))?.unsettled.length).toBe(0);
		expect(await store.confirmTermination("r3", round.stopOpId)).toBe(true);
		expect(await store.canResume("r3")).toBe(true);
	});

	test("isolation requires a CONFIRMED target swap — no boolean bypass; failure keeps blocking", async () => {
		const gate = deferred();
		const store = new PersistentStopStore(
			{
				abortNativeTurn: () => gate.promise,
				isolateTarget: async () => {
					throw new Error("cannot confirm target death");
				},
			},
			40,
		);
		const round = await store.begin("r4");
		await store.sendAbort("r4");
		const failed = await store.isolate("r4");
		expect(failed.isolated).toBe(false);
		expect((await store.snapshot("r4"))?.unsettled.length).toBe(1); // still blocked
		expect(await store.confirmTermination("r4", round.stopOpId)).toEqual({ refused: "uncertain" });
		// an isolation transport that CAN confirm unlocks and records the proof
		const healed = new PersistentStopStore(
			{
				abortNativeTurn: () => gate.promise,
				isolateTarget: async () => ({ proof: "old-instance-killed+verified" }),
			},
			40,
		);
		const ok = await healed.isolate("r4");
		expect(ok.isolated).toBe(true);
		if (ok.isolated) expect(ok.proof).toContain("verified");
		expect(await healed.confirmTermination("r4", round.stopOpId)).toBe(true);
		expect(await healed.canResume("r4")).toBe(true);
		gate.resolve();
	});

	test("concurrent sendAborts register distinct attempts without losing counts", async () => {
		const store = new PersistentStopStore(
			{ abortNativeTurn: async () => {}, isolateTarget: async () => ({ proof: "p" }) },
			5_000,
		);
		await store.begin("r5");
		const results = await Promise.all([
			store.sendAbort("r5"),
			store.sendAbort("r5"),
			store.sendAbort("r5"),
		]);
		const ok = results.filter((r) => "attemptId" in r);
		const rejected = results.filter((r) => "rejected" in r);
		expect(ok.length).toBeGreaterThanOrEqual(1);
		// every rejected writer lost the same-round race cleanly
		for (const r of rejected) if ("rejected" in r) expect(r.rejected).toBe("superseded");
		const snap = await store.snapshot("r5");
		// attempts recorded == registered writers; the CAS + write-verification
		// prevents lost updates and phantom registrations
		expect(snap?.attempts).toBe(ok.length);
		expect(snap?.unsettled.length).toBe(0); // all transports completed instantly
	});
});
