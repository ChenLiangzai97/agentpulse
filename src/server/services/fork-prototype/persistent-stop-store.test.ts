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

describe("persistent stop operations — revision CAS & per-attempt uncertainty (round 19+21+22)", () => {
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
		// rev 1→2 registration, then the instantly-completing transport's
		// wired settlement bumps it again → 3.
		expect(snap?.revision).toBe(3);
		expect(snap?.attempts).toBe(1);
		expect(await restarted.confirmTermination("r1", round.stopOpId)).toBe(true);
		expect(await restarted.confirmTermination("r1", `stale-${round.stopOpId}`)).toEqual({
			refused: "unknown_round",
		});
	});

	let 甲: Promise<unknown> | null = null;
	let 甲Fired = false;
	test("deterministic same-round interleave: 甲 registers + hangs transport → 乙 writes with STALE state → 乙 FAILS, 甲 survives", async () => {
		let release甲: () => void = () => {};
		const transportCalls: string[] = [];
		const store = new PersistentStopStore(
			{
				abortNativeTurn: async () => {
					transportCalls.push("call");
					await new Promise<void>((resolve) => {
						release甲 = resolve;
					});
				},
				isolateTarget: async () => ({ proof: "p" }),
			},
			30_000,
			{
				// 乙's hook: after loading the round state (still revision 1,
				// attempts 0) but BEFORE its CAS, let 甲 register and fire the
				// hanging transport first. The fired-once guard keeps 甲's OWN
				// beforeCas from recursing.
				beforeCas: async () => {
					if (甲Fired) return;
					const snap = await store.snapshot("r2");
					if (snap && snap.attempts === 0) {
						甲Fired = true;
						甲 = store.sendAbort("r2");
						await Bun.sleep(30); // let 甲's CAS land (rev 1→2)
					}
				},
			},
		);
		await store.begin("r2");
		const 乙 = await store.sendAbort("r2"); // its beforeCas sent 甲 first
		expect(乙).toEqual({ rejected: "superseded" }); // stale writer lost
		const snap = await store.snapshot("r2");
		expect(snap?.revision).toBe(2); // 甲's write, not overwritten
		expect(snap?.attempts).toBe(1);
		expect(transportCalls.length).toBe(1); // only 甲's transport fired
		release甲();
		await 甲;
		for (let i = 0; i < 40 && (await unsettledCount(store, "r2")) !== 0; i++) await Bun.sleep(10);
		expect(await unsettledCount(store, "r2")).toBe(0); // 甲 settled via wired completion
	});

	test("per-attempt uncertainty: two timeouts need BOTH settlements; late completion is auto-wired", async () => {
		const gates = [deferred(), deferred()];
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
		expect(await unsettledCount(store, "r3")).toBe(2);
		gates[0].resolve();
		for (let i = 0; i < 40 && (await unsettledCount(store, "r3")) !== 1; i++) await Bun.sleep(10);
		expect(await unsettledCount(store, "r3")).toBe(1); // still uncertain
		expect(await store.confirmTermination("r3", round.stopOpId)).toEqual({ refused: "uncertain" });
		gates[1].resolve();
		for (let i = 0; i < 40 && (await unsettledCount(store, "r3")) !== 0; i++) await Bun.sleep(10);
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
		expect(await unsettledCount(store, "r4")).toBe(1);
		expect(await store.confirmTermination("r4", round.stopOpId)).toEqual({ refused: "uncertain" });
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

	test("concurrent sendAborts: exactly the registered writers, no phantom successes", async () => {
		const store = new PersistentStopStore(okTransport);
		await store.begin("r5");
		const results = await Promise.all([
			store.sendAbort("r5"),
			store.sendAbort("r5"),
			store.sendAbort("r5"),
		]);
		const ok = results.filter((r) => "attemptId" in r);
		const rejected = results.filter((r) => "rejected" in r);
		expect(ok.length).toBeGreaterThanOrEqual(1);
		for (const r of rejected) if ("rejected" in r) expect(r.rejected).toBe("superseded");
		const snap = await store.snapshot("r5");
		expect(snap?.attempts).toBe(ok.length);
		// every registration bumped the revision, and every instantly-settled
		// transport bumped it once more: 1 + 2 × registered
		expect(snap?.revision).toBe(1 + 2 * ok.length);
		expect(snap?.unsettled.length).toBe(0);
	});
});

describe("restart reconciliation (review round 24)", () => {
	test("unsettled attempts do NOT settle themselves across a restart; a proof token clears them", async () => {
		const gate = deferred();
		const boot = {
			abortNativeTurn: () => gate.promise,
			isolateTarget: async () => ({ proof: "p" }),
		};
		const before = new PersistentStopStore(boot, 40);
		const round = await before.begin("rr");
		await before.sendAbort("rr"); // times out → unsettled
		expect((await before.snapshot("rr"))?.unsettled.length).toBe(1);
		// "restart": a fresh store — the in-process promise is gone forever.
		const after = new PersistentStopStore(boot, 40);
		expect((await after.snapshot("rr"))?.unsettled.length).toBe(1); // still unsettled
		expect(await after.confirmTermination("rr", round.stopOpId)).toEqual({ refused: "uncertain" });
		// wrong round id refused; incomplete proofs refused (no string bypass)
		expect(
			await after.reconcileAfterRestart("rr", `stale-${round.stopOpId}`, {
				kind: "instance-terminated",
				instanceIdentity: "inst-1",
			}),
		).toEqual({ refused: "unknown_round" });
		expect(
			await after.reconcileAfterRestart("rr", round.stopOpId, {
				kind: "",
				instanceIdentity: "inst-1",
			} as never),
		).toEqual({ refused: "invalid_proof" });
		expect(
			await after.reconcileAfterRestart("rr", round.stopOpId, {
				kind: "instance-terminated",
				instanceIdentity: "",
			} as never),
		).toEqual({ refused: "invalid_proof" });
		// round-bound structured proof clears and records the token
		expect(
			await after.reconcileAfterRestart("rr", round.stopOpId, {
				kind: "instance-terminated",
				instanceIdentity: "inst-1",
				detail: "uptime=12s>attempt",
			}),
		).toBe(true);
		const snap = await after.snapshot("rr");
		expect(snap?.unsettled.length).toBe(0);
		expect(snap?.isolationProof).toContain("inst-1");
		expect(await after.confirmTermination("rr", round.stopOpId)).toBe(true);
		expect(await after.canResume("rr")).toBe(true);
		gate.resolve();
	});

	test("reconcile without unsettled attempts is a no-op (no fabricated certainty)", async () => {
		const boot = { abortNativeTurn: async () => {}, isolateTarget: async () => ({ proof: "p" }) };
		const store = new PersistentStopStore(boot);
		await store.begin("rr2");
		await store.sendAbort("rr2");
		const rr2 = await store.snapshot("rr2");
		if (!rr2) throw new Error("round missing");
		expect(
			await store.reconcileAfterRestart("rr2", rr2.stopOpId, {
				kind: "instance-terminated",
				instanceIdentity: "inst-2",
			}),
		).toBe(false);
	});
});
