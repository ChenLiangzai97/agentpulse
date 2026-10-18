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
		expect(await restarted.confirmTermination("child", round.stopOpId - 1)).toBe(false);
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
		expect(first.transportOk).toBe(false);
		const retry = await store.sendAbort("child");
		expect(retry.transportOk).toBe(false);
		expect(calls).toBe(2); // actually re-sent, not parked
		expect(retry.stopOpId).toBe(round.stopOpId); // SAME round
		gate.resolve();
		const third = await store.sendAbort("child");
		expect(third.transportOk).toBe(true);
		expect(calls).toBe(3);
		expect((await store.snapshot("child"))?.attempts).toBe(3);
	});

	test("transport success is NOT termination: only confirmTermination stops the round", async () => {
		const store = new PersistentStopStore({ abortNativeTurn: async () => {} });
		const round = await store.begin("child");
		const sent = await store.sendAbort("child");
		expect(sent.transportOk).toBe(true); // HTTP-200-shaped success
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
