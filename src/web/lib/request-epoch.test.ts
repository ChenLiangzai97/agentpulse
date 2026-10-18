import { describe, expect, test } from "bun:test";
import { createRequestEpoch } from "./request-epoch.js";

describe("request epoch guard", () => {
	test("A→B: A's late SUCCESS and late FAILURE are both stale", () => {
		const guard = createRequestEpoch();
		const isCurrentA = guard.begin();
		const isCurrentB = guard.begin();
		expect(isCurrentA()).toBe(false); // A's success must not overwrite B
		expect(isCurrentB()).toBe(true);
	});

	test("A→B→A: only the newest request is current", () => {
		const guard = createRequestEpoch();
		const a1 = guard.begin();
		const b = guard.begin();
		const a2 = guard.begin();
		expect(a1()).toBe(false);
		expect(b()).toBe(false);
		expect(a2()).toBe(true);
	});

	test("a single in-flight request stays current until replaced", () => {
		const guard = createRequestEpoch();
		const only = guard.begin();
		expect(only()).toBe(true);
	});
});
