/**
 * Real-DB tests for the persistent stop store: restart survival, retry
 * re-issue, and transport-success ≠ termination (per review round 17).
 */
import "../../db/__test_db.js";
import { beforeEach, describe, expect, test } from "bun:test";
import { getDb, initializeDatabase } from "../../db/client.js";
import { settings } from "../../db/schema/index.js";
import { type PersistedStopOp, PersistentStopStore } from "./persistent-stop-store.js";

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

	// (The old beforeCas-based interleave used a hook that no longer exists;
	// the deterministic same-round race is now covered by the revision-CAS
	// concurrent-sendAbort test below plus the round-29 interleavings.)

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

describe("single authoritative row — transactional claim & guarded release (rounds 27+29)", () => {
	const okTransport = {
		abortNativeTurn: async () => {},
		isolateTarget: async () => ({ proof: "p" }),
	};

	test("concurrent begin(): one live round; the racer observes it whole (no half-installed claim)", async () => {
		const a = new PersistentStopStore(okTransport);
		const b = new PersistentStopStore(okTransport);
		const [ra, rb] = await Promise.all([a.begin("ar"), b.begin("ar")]);
		expect(ra.stopOpId).toBe(rb.stopOpId);
		expect(ra.status).toBe("abort_pending");
		expect((await a.snapshot("ar"))?.stopOpId).toBe(ra.stopOpId);
	});

	test("claim paused INSIDE the claim transaction: the racer sees either no row or the FULL row — never steals an in-flight claim", async () => {
		// 甲 opens the claim transaction and pauses after reading NO row.
		let release甲: () => void = () => {};
		const gate = new Promise<void>((r) => {
			release甲 = r;
		});
		let 甲Result: Promise<PersistedStopOp | undefined> | null = null;
		const 甲store = new PersistentStopStore(okTransport, 5_000, {
			insideClaimTx: async () => {
				if (甲Result) return; // only pause on the first claim
				await gate; // hold the transaction open with no row written yet
			},
		});
		甲Result = 甲store.begin("ar2");
		await Bun.sleep(30); // 甲 is inside the tx, paused before insert
		const 乙store = new PersistentStopStore(okTransport);
		const 乙 = await 乙store.begin("ar2"); // runs while 甲's tx is open
		release甲();
		const 甲 = await 甲Result;
		// Exactly one round exists; both observers see the SAME full round.
		const snap = await 乙store.snapshot("ar2");
		expect(snap).not.toBeNull();
		expect(snap?.status).toBe("abort_pending");
		const ids = new Set([乙.stopOpId, (甲 ?? 乙).stopOpId, snap ? snap.stopOpId : "missing"]);
		expect(ids.size).toBe(1);
	});

	test("old round's LATE termination cannot touch a NEW round: release matches (stopOpId, revision)", async () => {
		const store = new PersistentStopStore(okTransport);
		const r1 = await store.begin("ar3");
		await store.sendAbort("ar3");
		expect(await store.confirmTermination("ar3", r1.stopOpId)).toBe(true);
		// new round replaces the stopped one on the SAME row
		const r2 = await store.begin("ar3", "h2");
		expect(r2.stopOpId).not.toBe(r1.stopOpId);
		await store.sendAbort("ar3");
		// the OLD round's confirmation arrives late — it must NOT stop r2
		expect(await store.confirmTermination("ar3", r1.stopOpId)).toEqual({
			refused: "unknown_round",
		});
		expect((await store.snapshot("ar3"))?.status).toBe("abort_sent");
		expect((await store.snapshot("ar3"))?.stopOpId).toBe(r2.stopOpId);
		expect(await store.confirmTermination("ar3", r2.stopOpId)).toBe(true);
		expect((await store.snapshot("ar3"))?.status).toBe("stopped");
	});

	test("delayed release hook: even if an old confirmation is in flight, the conditional write only lands on its own round", async () => {
		let hook: () => Promise<void> = async () => {};
		const store = new PersistentStopStore(okTransport, 5_000, {
			beforeTerminationRelease: () => hook(),
		});
		const r1 = await store.begin("ar4");
		await store.sendAbort("ar4");
		let releaseConfirm: () => void = () => {};
		const confirmGate = new Promise<void>((r) => {
			releaseConfirm = r;
		});
		hook = () => confirmGate; // pause r1's termination write
		const confirm1 = store.confirmTermination("ar4", r1.stopOpId);
		await Bun.sleep(20); // paused after the read, before the write
		releaseConfirm();
		expect(await confirm1).toBe(true);
		const r2 = await store.begin("ar4", "h2");
		expect(r2.stopOpId).not.toBe(r1.stopOpId);
		// a stale replay of r1's confirmation still cannot flip r2
		expect(await store.confirmTermination("ar4", r1.stopOpId)).toEqual({
			refused: "unknown_round",
		});
	});

	test("per-attempt uncertainty, isolation and restart reconciliation still hold on the new row model", async () => {
		const gates = [deferred(), deferred()];
		let n = 0;
		const store = new PersistentStopStore(
			{
				abortNativeTurn: () => gates[n++ % 2].promise,
				isolateTarget: async () => {
					throw new Error("no");
				},
			},
			40,
		);
		const round = await store.begin("ar5");
		const a1 = await store.sendAbort("ar5");
		const a2 = await store.sendAbort("ar5");
		if (!("attemptId" in a1) || !("attemptId" in a2)) throw new Error("not registered");
		expect((await store.snapshot("ar5"))?.unsettled.length).toBe(2);
		gates[0].resolve();
		for (let i = 0; i < 40 && (await unsettledCount(store, "ar5")) !== 1; i++) await Bun.sleep(10);
		expect(await unsettledCount(store, "ar5")).toBe(1);
		// failed isolation keeps blocking; structured reconciliation (restart proof) clears
		expect((await store.isolate("ar5")).isolated).toBe(false);
		expect(
			await store.reconcileAfterRestart("ar5", round.stopOpId, {
				kind: "instance-terminated",
				instanceIdentity: "inst-A",
				detail: "uptime>attempt",
			}),
		).toBe(true);
		expect(await unsettledCount(store, "ar5")).toBe(0);
		expect(await store.confirmTermination("ar5", round.stopOpId)).toBe(true);
		expect(await store.canResume("ar5")).toBe(true);
		gates[1].resolve();
	});
});
