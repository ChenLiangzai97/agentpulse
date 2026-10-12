import { describe, expect, test } from "bun:test";
import { FOREIGN_SCOPE, findScopeViolations, scannableText } from "./check-no-foreign-npm-scope.ts";

const OLD_NAME = `${FOREIGN_SCOPE}mcp`;

describe("check-no-foreign-npm-scope", () => {
	test("a plain file naming the scoped package is reported with its line", () => {
		const hits = findScopeViolations([
			{ path: "README.md", text: `intro\nnpx ${OLD_NAME} serve\n` },
			{ path: "docs/clean.md", text: "npx agentpulse-mcp serve\n" },
		]);
		expect(hits).toHaveLength(1);
		expect(hits[0]).toStartWith("README.md:2:");
	});

	test("any package under the scope is reported, not only the MCP one", () => {
		expect(
			findScopeViolations([{ path: "a.ts", text: `import x from "${FOREIGN_SCOPE}types"` }]),
		).toHaveLength(1);
	});

	test("CHANGELOG history is exempt but its Unreleased section is not", () => {
		const changelog = [
			"# Changelog",
			"## [Unreleased]",
			`- now ${OLD_NAME}`,
			"## [0.8.0] — 2026-10-05",
			`- earlier note about ${OLD_NAME}`,
		].join("\n");
		const hits = findScopeViolations([{ path: "CHANGELOG.md", text: changelog }]);
		expect(hits).toHaveLength(1);
		expect(hits[0]).toStartWith("CHANGELOG.md:3:");
		expect(scannableText("CHANGELOG.md", changelog)).not.toContain("earlier note");
	});

	test("the exemption is for CHANGELOG.md only", () => {
		const text = `## [0.8.0]\n${OLD_NAME}\n`;
		expect(findScopeViolations([{ path: "docs/CHANGELOG.md", text }])).toHaveLength(1);
	});
});
