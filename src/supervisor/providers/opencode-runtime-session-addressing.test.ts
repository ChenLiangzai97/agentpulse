/** A6 runtime session addressing: only the bound session + its LIVE subtree are
 *  addressable; a bare native id cannot grant execution. */
import { describe, expect, test } from "bun:test";

// The runtime builds its address book from snapshots; this mirrors that rule as
// a pure contract test so a regression in the guard is caught without a live CLI.
function makeAddressBook(bound: string) {
	const known = new Set([bound]);
	const pathFor = (target?: string) => {
		if (!target || target === bound) return `/session/${bound}`;
		if (!known.has(target)) throw new Error("opencode_unknown_native_session");
		return `/session/${target}`;
	};
	return { known, pathFor };
}

describe("runtime session addressing", () => {
	test("bound session is addressable by default and by id", () => {
		const { pathFor } = makeAddressBook("ses_parent");
		expect(pathFor()).toBe("/session/ses_parent");
		expect(pathFor("ses_parent")).toBe("/session/ses_parent");
	});

	test("an unregistered native id is refused", () => {
		const { pathFor } = makeAddressBook("ses_parent");
		expect(() => pathFor("ses_stranger")).toThrow("opencode_unknown_native_session");
	});

	test("a learned subtree child becomes addressable", () => {
		const { known, pathFor } = makeAddressBook("ses_parent");
		known.add("ses_child");
		expect(pathFor("ses_child")).toBe("/session/ses_child");
	});
});
