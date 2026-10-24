/**
 * P3 read-only discovery / migration preflight.
 *
 * PROVES NOTHING ABOUT CONTROL: it only inventories BotMux sessions, the daemon
 * and local compatibility facts. It never opens a writable binding, never
 * weakens an existing guard, never stops a source and never copies secrets.
 * Unknown facts stay explicitly unknown.
 */
export interface PreflightSource {
	source: "botmux";
	sessionId: string;
	bot: string;
	agent: "opencode" | "codex" | "unknown";
	cwd: string | null;
	pid: number | null;
	uptime: string;
	driverState: string;
	target: string;
	/** Preflight never grants handoff: the source must be released first. */
	handoffAllowed: false;
	compatibility: {
		/** null = not provable from this read-only view (e.g. truncated list). */
		cwdExists: boolean | null;
		cwdIsDirectory: boolean | null;
		host: string;
		botmuxVersion: string | null;
		/** Plugin compatibility is NOT proven by the CLI status output. */
		pluginCompatibility: "unknown";
		/** Facts this read-only view cannot prove. */
		unknown: string[];
	};
}

export interface PreflightReport {
	mode: "read_only";
	generatedAt: string;
	host: string;
	daemon: {
		line: string | null;
		/** Processes the CLI reports (bots/daemon). NOT proof of plugin health. */
		services: { name: string; status: string }[];
	};
	sources: PreflightSource[];
	unknown: string[];
}

const clean = (value: string) => value.replace(/\s+/g, " ").trim();

/** Parse `botmux list --plain` (ASCII table). Tolerant, column-based. */
export function parseBotmuxListPlain(text: string): {
	sessionId: string;
	bot: string;
	title: string;
	cwd: string;
	pid: number | null;
	uptime: string;
	status: string;
	target: string;
}[] {
	const rows: ReturnType<typeof parseBotmuxListPlain> = [];
	for (const line of text.split("\n")) {
		if (!line.includes("│")) continue;
		const cells = line.split("│").map(clean);
		if (cells.length < 8) continue;
		const [sessionId, bot, title, cwd, pid, uptime, status, target] = cells;
		if (!sessionId || sessionId === "id" || /^[─-]+$/.test(sessionId)) continue;
		if (!/^[0-9a-f]{6,}$/i.test(sessionId)) continue;
		rows.push({
			sessionId,
			bot,
			title,
			cwd,
			pid: pid && pid !== "-" ? Number(pid) || null : null,
			uptime,
			status,
			target,
		});
	}
	return rows;
}

const agentOf = (bot: string): "opencode" | "codex" | "unknown" => {
	if (/opencode/i.test(bot)) return "opencode";
	if (/codex/i.test(bot)) return "codex";
	return "unknown";
};

const expandHome = (cwd: string) =>
	cwd.startsWith("~") ? cwd.replace(/^~/, process.env.HOME ?? "~") : cwd;

/** `botmux status`: the supervisor line plus the bot/daemon rows it lists. */
export function parseBotmuxStatus(text: string): {
	line: string | null;
	services: { name: string; status: string }[];
} {
	const services: { name: string; status: string }[] = [];
	let line: string | null = null;
	for (const raw of text.split("\n")) {
		const value = clean(raw);
		if (/^supervisor/.test(value)) line = value;
		const match = value.match(/^(botmux-[\w-]+)\s+(\d+)\s+(\w+)/);
		if (match?.[1] && match[3]) services.push({ name: match[1], status: match[3] });
	}
	const unique = [...new Map(services.map((s) => [s.name, s])).values()];
	return { line, services: unique };
}

/** Strip anything that looks like a credential before it can reach a report. */
export function redactSecrets(value: string): string {
	return value
		.replace(/\b(api[_-]?key|token|secret|password)\b\s*[:=]\s*\S+/gi, "$1=[redacted]")
		.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/=._-]{8,}/g, "$1 [redacted]");
}

export function buildPreflightReport(input: {
	host: string;
	now: string;
	listText: string;
	statusText: string;
	statCwd: (cwd: string) => { exists: boolean | null; isDirectory: boolean | null };
}): PreflightReport {
	const status = parseBotmuxStatus(input.statusText);
	const botmuxVersion = input.statusText.match(/botmux\s+v?(\d+\.\d+\.\d+)/)?.[1] ?? null;
	const sources: PreflightSource[] = parseBotmuxListPlain(input.listText).map((row) => {
		const cwd = row.cwd ? expandHome(row.cwd) : null;
		const truncated = Boolean(cwd && (cwd.includes("…") || cwd.includes("...")));
		const stat = cwd && !truncated ? input.statCwd(cwd) : { exists: null, isDirectory: null };
		const unknown = [
			"native_identity_not_exposed_by_list",
			"trusted_identity_requires_observe_json",
		];
		if (truncated) unknown.push("cwd_truncated_by_list");
		if (row.status !== "stopped") unknown.push("driver_idle_state_not_proven");
		if (!botmuxVersion) unknown.push("botmux_version_unknown");
		return {
			source: "botmux",
			sessionId: row.sessionId,
			bot: redactSecrets(row.bot),
			agent: agentOf(row.bot),
			cwd,
			pid: row.pid,
			uptime: row.uptime,
			driverState: row.status,
			target: redactSecrets(row.target),
			handoffAllowed: false,
			compatibility: {
				cwdExists: stat.exists,
				cwdIsDirectory: stat.isDirectory,
				host: input.host,
				botmuxVersion,
				pluginCompatibility: "unknown" as const,
				unknown,
			},
		};
	});
	return {
		mode: "read_only",
		generatedAt: input.now,
		host: input.host,
		daemon: status,
		sources,
		unknown: [
			"source_release_not_verified",
			"native_export_import_not_tested",
			"plugin_service_health_not_proven",
			"plugin_runtime_compatibility_not_tested",
			"terminal_sources_not_discovered",
		],
	};
}
