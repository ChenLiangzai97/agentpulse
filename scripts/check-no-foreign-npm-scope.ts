#!/usr/bin/env bun
/**
 * Architecture guard: nothing tracked tells anyone to install the MCP package
 * under a name we don't own.
 *
 * The `@agentpulse` npm scope belongs to an unrelated project, and the
 * unscoped `agentpulse-mcp` is refused by npm as too similar to the existing
 * `agent-pulse-mcp`, so whoever is allowed to publish it later isn't us. The
 * package is published as `@craze0/agentpulse-mcp`. A doc, an install command
 * or a config emitter that names the scope, or runs the unscoped name as a
 * package (`npx agentpulse-mcp`, `agentpulse-mcp@<version>`), tells users to run
 * code another party controls. The installed command is still `agentpulse-mcp`;
 * only package specs are checked. The one exemption is the history in
 * CHANGELOG.md (every section after `[Unreleased]`), which records what earlier
 * notes said.
 *
 * This file and its test are not scanned: they spell out the names they look for.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
export const FOREIGN_SCOPE = `${"@"}agentpulse/`;
const MCP_PACKAGE_JSON = "packages/agentpulse-mcp/package.json";
export const EXPECTED_PACKAGE_NAME = "@craze0/agentpulse-mcp";
/** The unscoped name used as a package spec: run by npx/bunx, or pinned to a version. */
export const UNSCOPED_PACKAGE_SPEC =
	/(?:\b(?:npx|bunx)(?:\s+-y)?\s+agentpulse-mcp\b)|(?:(?<![\w@/.-])agentpulse-mcp@)/;

export interface ScannedFile {
	path: string;
	text: string;
}

/** CHANGELOG history (every released section) is exempt; its `[Unreleased]` section is not. */
export function scannableText(path: string, text: string): string {
	if (path !== "CHANGELOG.md") return text;
	return text.split(/^## \[(?!Unreleased\])/m)[0] ?? "";
}

/** This guard's own files spell out what they look for. */
const SELF = new Set([
	"scripts/check-no-foreign-npm-scope.ts",
	"scripts/check-no-foreign-npm-scope.test.ts",
]);

/** `path:line` for each line that names the scope or runs the unscoped name as a package. */
export function findScopeViolations(files: ScannedFile[]): string[] {
	const out: string[] = [];
	for (const { path, text } of files) {
		if (SELF.has(path)) continue;
		scannableText(path, text)
			.split("\n")
			.forEach((line, i) => {
				if (line.includes(FOREIGN_SCOPE) || UNSCOPED_PACKAGE_SPEC.test(line))
					out.push(`${path}:${i + 1}: ${line.trim().slice(0, 140)}`);
			});
	}
	return out;
}

function trackedTextFiles(): ScannedFile[] {
	const listed = spawnSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" });
	if (listed.status !== 0) throw new Error(`git ls-files failed: ${listed.stderr}`);
	const files: ScannedFile[] = [];
	for (const path of listed.stdout.split("\0").filter(Boolean)) {
		let text: string;
		try {
			text = readFileSync(join(ROOT, path), "utf8");
		} catch {
			continue;
		}
		if (!text.includes("\0")) files.push({ path, text });
	}
	return files;
}

function main(): void {
	const files = trackedTextFiles();
	// Population floor: an empty or truncated listing must not read as a clean tree.
	const pkg = files.find((f) => f.path === MCP_PACKAGE_JSON);
	if (files.length < 100 || !pkg) {
		console.error(
			`FAIL: scanned ${files.length} tracked files and ${pkg ? "found" : "did not find"} ${MCP_PACKAGE_JSON}; the file listing is not trustworthy.`,
		);
		process.exit(1);
	}
	const name = (JSON.parse(pkg.text) as { name?: string }).name;
	const violations = findScopeViolations(files);
	if (name !== EXPECTED_PACKAGE_NAME) {
		violations.push(`${MCP_PACKAGE_JSON}: name is "${name}", expected "${EXPECTED_PACKAGE_NAME}"`);
	}
	if (violations.length > 0) {
		console.error(
			`FAIL: neither the ${FOREIGN_SCOPE} scope nor the unscoped name is ours; the MCP package is "${EXPECTED_PACKAGE_NAME}":`,
		);
		for (const v of violations) console.error(`  ${v}`);
		process.exit(1);
	}
	console.log(`OK: no tracked file names a package we don't own (${files.length} files scanned)`);
}

if (import.meta.main) main();
