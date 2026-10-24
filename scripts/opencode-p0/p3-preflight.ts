/**
 * P3 read-only preflight over the REAL BotMux daemon (no writes, no source
 * stop, no binding). Evidence: p3-preflight-evidence.json (sanitized).
 */
import { readdir, stat } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { buildPreflightReport } from "../../src/server/services/p3-preflight.js";

const run = async (args: string[]) => {
	const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
	const [out, err] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	await child.exited;
	return { out, err };
};
const list = await run(["botmux", "list", "--plain"]);
const status = await run(["botmux", "status"]);
const version = await run(["botmux", "--version"]).catch(() => ({ out: "", err: "" }));
// A failed probe must NOT look like "no sessions": report it and exit non-zero.
const probeErrors: string[] = [];
if (list.err.trim() || !list.out.trim()) probeErrors.push(`list_failed:${list.err.trim()}`);
if (status.err.trim() || !status.out.trim()) probeErrors.push(`status_failed:${status.err.trim()}`);
if (probeErrors.length > 0) {
	const failedPath = join(import.meta.dir, "p3-preflight-evidence.json");
	await Bun.write(failedPath, `${JSON.stringify({ mode: "read_only", ok: false, probeErrors }, null, 1)}\n`);
	console.error(JSON.stringify({ ok: false, probeErrors }, null, 1));
	process.exit(2);
}
const report = buildPreflightReport({
	host: hostname(),
	now: new Date().toISOString(),
	listText: list.out,
	statusText: `${status.out}\n${status.err}\n${version.out}`,
	statCwd: () => ({ exists: false, isDirectory: false }), // replaced below
});
// Real cwd facts (read-only) per source.
for (const source of report.sources) {
	if (!source.cwd) continue;
	// Unknown (truncated) stays unknown: do not stat a non-fact.
	if (source.compatibility.cwdExists === null) continue;
	try {
		const info = await stat(source.cwd);
		source.compatibility.cwdExists = true;
		source.compatibility.cwdIsDirectory = info.isDirectory();
	} catch {
		source.compatibility.cwdExists = false;
	}
}
// Read-only plugin/config inventory for this host (names only, no secrets).
const configDir = join(process.env.HOME ?? "", ".config", "opencode");
try {
	const entries = await readdir(configDir);
	report.unknown.push(
		`opencode_config_files=${entries.filter((e) => e.endsWith(".json") || e.endsWith(".jsonc")).join(",")}`,
	);
} catch {
	report.unknown.push("opencode_config_unreadable");
}
const evidencePath = join(import.meta.dir, "p3-preflight-evidence.json");
await Bun.write(evidencePath, `${JSON.stringify(report, null, 1)}\n`);
console.log(
	JSON.stringify(
		{
			sources: report.sources.length,
			byAgent: report.sources.reduce<Record<string, number>>((acc, s) => {
				acc[s.agent] = (acc[s.agent] ?? 0) + 1;
				return acc;
			}, {}),
			cwdMissing: report.sources.filter((s) => s.compatibility.cwdExists === false).length,
			cwdUnknown: report.sources.filter((s) => s.compatibility.cwdExists === null).length,
			daemon: report.daemon.line,
			services: report.daemon.services,
			unknown: report.unknown,
		},
		null,
		1,
	),
);
