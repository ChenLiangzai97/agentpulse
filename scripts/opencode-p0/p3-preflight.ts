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
	// `botmux list --plain` TRUNCATES the cwd column (…): such a path is not a
	// fact and must stay unknown, never "missing".
	if (source.cwd.includes("…") || source.cwd.includes("...")) {
		source.compatibility.unknown.push("cwd_truncated_by_list");
		continue;
	}
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
			cwdMissing: report.sources.filter((s) => !s.compatibility.cwdExists).length,
			daemon: report.daemon.line,
			pluginServices: report.daemon.pluginServices,
			unknown: report.unknown,
		},
		null,
		1,
	),
);
