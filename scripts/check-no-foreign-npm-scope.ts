#!/usr/bin/env bun
/**
 * Architecture guard: nothing tracked refers to the `@agentpulse` npm scope.
 *
 * That scope belongs to an unrelated project. The MCP server package is
 * published as the unscoped `agentpulse-mcp`; a doc, an install command or a
 * config emitter that names the scoped form tells users to run code another
 * party controls. The only place the scoped name may still appear is the
 * history in CHANGELOG.md (every section after `[Unreleased]`), which records
 * what earlier notes said.
 *
 * The literal is assembled in code so this file does not trip its own scan.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
export const FOREIGN_SCOPE = `${"@"}agentpulse/`;
const MCP_PACKAGE_JSON = "packages/agentpulse-mcp/package.json";
const EXPECTED_PACKAGE_NAME = "agentpulse-mcp";

export interface ScannedFile {
	path: string;
	text: string;
}

/** CHANGELOG history (every released section) is exempt; its `[Unreleased]` section is not. */
export function scannableText(path: string, text: string): string {
	if (path !== "CHANGELOG.md") return text;
	return text.split(/^## \[(?!Unreleased\])/m)[0] ?? "";
}

/** `path:line` for each line that names the scope. */
export function findScopeViolations(files: ScannedFile[]): string[] {
	const out: string[] = [];
	for (const { path, text } of files) {
		scannableText(path, text)
			.split("\n")
			.forEach((line, i) => {
				if (line.includes(FOREIGN_SCOPE))
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
			`FAIL: the ${FOREIGN_SCOPE} npm scope is not ours; the MCP package is "${EXPECTED_PACKAGE_NAME}":`,
		);
		for (const v of violations) console.error(`  ${v}`);
		process.exit(1);
	}
	console.log(`OK: no tracked file names the foreign npm scope (${files.length} files scanned)`);
}

if (import.meta.main) main();
