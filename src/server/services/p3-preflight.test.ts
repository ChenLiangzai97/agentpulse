import { describe, expect, test } from "bun:test";
import {
	buildPreflightReport,
	parseBotmuxListPlain,
	parseBotmuxStatus,
	redactSecrets,
} from "./p3-preflight.js";

const LIST = `─────────────────────────────────────────────────────────────
id         │ bot              │ title          │ working dir   │ pid    │ uptime │ status  │ target
─────────────────────────────────────────────────────────────
99dad266   │ bot1 (opencode)  │ [headless] x   │ /tmp/a        │ -      │ 12h    │ dormant │ headless
99852db7   │ bot2 (codex)     │ [定时] 提醒    │ /tmp/b        │ 1234   │ 6d     │ online  │ tmux: bmx-99852db7
─────────────────────────────────────────────────────────────`;

const STATUS = `supervisor 在线 (pid 1314)
  NAME                              PID  STATUS   VERSION
  botmux-dashboard                 1473  online   -
  botmux-StationAgent-opencode     1471  online   3.34.0`;

describe("read-only preflight", () => {
	test("parses the plain list and status without titles or secrets in the report", () => {
		const rows = parseBotmuxListPlain(LIST);
		expect(rows).toHaveLength(2);
		expect(rows[0]).toMatchObject({ sessionId: "99dad266", cwd: "/tmp/a", status: "dormant" });
		const status = parseBotmuxStatus(STATUS);
		expect(status.pluginServices).toContain("botmux-StationAgent-opencode (online)");
		const report = buildPreflightReport({
			host: "host-1",
			now: "2026-10-24T00:00:00.000Z",
			listText: LIST,
			statusText: STATUS,
			statCwd: () => ({ exists: true, isDirectory: true }),
		});
		expect(report.mode).toBe("read_only");
		expect(JSON.stringify(report)).not.toContain("提醒");
		expect(report.sources.every((s) => s.handoffAllowed === false)).toBe(true);
		expect(report.sources[0]?.compatibility.unknown).toContain(
			"native_identity_not_exposed_by_list",
		);
		expect(report.sources[0]?.compatibility.cwdExists).toBe(true);
	});

	test("missing cwd and unknown versions stay explicit", () => {
		const report = buildPreflightReport({
			host: "h",
			now: "t",
			listText: LIST,
			statusText: "supervisor 在线",
			statCwd: () => ({ exists: false, isDirectory: false }),
		});
		expect(report.sources[0]?.compatibility.cwdExists).toBe(false);
		expect(report.sources[0]?.compatibility.botmuxVersion).toBeNull();
		expect(report.sources[0]?.compatibility.unknown).toContain("botmux_version_unknown");
	});

	test("redacts credential-looking strings", () => {
		expect(redactSecrets("api_key=abc123 token: xyz")).toBe("api_key=[redacted] token=[redacted]");
		expect(redactSecrets("Authorization: Bearer abcdefghijkl")).toContain("[redacted]");
	});
});
