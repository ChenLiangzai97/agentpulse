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
		const guard = createStaleLoadGuard<string>((v) => applied.push(v));
		const a = deferred<string>();
		const b = deferred<string>();
		const loadA = guard.load(() => a.promise);
		const loadB = guard.load(() => b.promise);
		b.resolve("B");
		await loadB;
		a.resolve("A");
		await loadA;
		expect(applied).toEqual(["B"]);
	});

	test("in-order resolutions all apply", async () => {
		const applied: string[] = [];
		const guard = createStaleLoadGuard<string>((v) => applied.push(v));
		await guard.load(async () => "1");
		await guard.load(async () => "2");
		expect(applied).toEqual(["1", "2"]);
	});

	test("a rejected stale load neither applies nor blocks the next", async () => {
		const applied: string[] = [];
		const guard = createStaleLoadGuard<string>((v) => applied.push(v));
		const failing = guard.load(async () => {
			throw new Error("boom");
		});
		await failing;
		await guard.load(async () => "next");
		expect(applied).toEqual(["next"]);
	});
});
