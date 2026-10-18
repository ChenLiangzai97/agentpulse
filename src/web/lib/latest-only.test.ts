import { describe, expect, test } from "bun:test";
import { createStaleLoadGuard } from "./latest-only.js";

function deferred<T>() {
	let resolve: (v: T) => void = () => {};
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

describe("stale load guard", () => {
	test("A→B switch where A resolves LAST: only B's value is applied", async () => {
		const applied: string[] = [];
		const guard = createStaleLoadGuard<string, string>((v) => applied.push(v));
		guard.setIdentity("A");
		const da = deferred<string>();
		const loadA = guard.load("A", () => da.promise);
		const db = deferred<string>();
		guard.setIdentity("B");
		const loadB = guard.load("B", () => db.promise);
		db.resolve("B");
		await loadB;
		da.resolve("A");
		await loadA;
		expect(applied).toEqual(["B"]);
	});

	test("completion race: action started on A finishes after switching to B — A's refresh never applies", async () => {
		const applied: string[] = [];
		const guard = createStaleLoadGuard<string, string>((v) => applied.push(v));
		guard.setIdentity("A");
		const lateA = deferred<string>();
		// user starts an action on A; before it finishes, the date changes:
		const inFlight = guard.load("A", () => lateA.promise);
		guard.setIdentity("B");
		const loadB = guard.load("B", async () => "B");
		await loadB;
		// ...and only THEN does the action's completion callback fire for A:
		lateA.resolve("A");
		await inFlight;
		expect(applied).toEqual(["B"]);
	});

	test("in-order resolutions with matching identity all apply", async () => {
		const applied: string[] = [];
		const guard = createStaleLoadGuard<string, string>((v) => applied.push(v));
		guard.setIdentity("A");
		await guard.load("A", async () => "1");
		await guard.load("A", async () => "2");
		expect(applied).toEqual(["1", "2"]);
	});

	test("a rejected stale load neither applies nor blocks the next", async () => {
		const applied: string[] = [];
		const guard = createStaleLoadGuard<string, string>((v) => applied.push(v));
		guard.setIdentity("A");
		await guard.load("A", async () => {
			throw new Error("boom");
		});
		await guard.load("A", async () => "next");
		expect(applied).toEqual(["next"]);
	});
});
