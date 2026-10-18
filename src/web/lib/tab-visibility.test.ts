import { describe, expect, test } from "bun:test";
import { shouldCloseTabOnLoadFailure } from "./tab-visibility.js";

describe("tab visibility revalidation", () => {
	test("gone (404) and invisible (403) sessions close their tabs", () => {
		expect(shouldCloseTabOnLoadFailure(404)).toBe(true);
		expect(shouldCloseTabOnLoadFailure(403)).toBe(true);
	});
	test("transient failures keep the tab parked for retry", () => {
		for (const status of [500, 502, 503, 429, 0])
			expect(shouldCloseTabOnLoadFailure(status)).toBe(false);
	});
});
