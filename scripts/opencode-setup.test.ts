import "../src/server/db/__test_db.js";
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setup } from "../src/server/routes/setup.js";

const notice = readFileSync(new URL("./opencode-notice.sh", import.meta.url), "utf8");
const block = (s: string) =>
	s.slice(
		s.indexOf("# >>> agentpulse-opencode-notice"),
		s.indexOf("# <<< agentpulse-opencode-notice") + "# <<< agentpulse-opencode-notice".length,
	);

test("served and standalone installers include the same OpenCode notice before configuration", async () => {
	const scripts = ["setup-hooks.sh", "setup-relay.sh", "install-local.sh"].map((file) =>
		readFileSync(new URL(file, import.meta.url), "utf8"),
	);
	scripts.push(await (await setup.request("http://localhost/setup.sh")).text());
	for (const script of scripts) {
		expect(block(script)).toBe(notice.trim());
		expect(Bun.spawnSync(["bash", "-n"], { stdin: Buffer.from(script) }).exitCode).toBe(0);
	}
});

test("detection respects XDG/custom paths, prints shell characters literally and never runs OpenCode", () => {
	const home = mkdtempSync(join(tmpdir(), "opencode-setup-"));
	try {
		const bin = join(home, "bin");
		mkdirSync(bin);
		const marker = join(home, "executed");
		writeFileSync(join(bin, "opencode"), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
		const run = (db: string, path: string) =>
			Bun.spawnSync(["/bin/bash", "-euc", notice], {
				env: {
					HOME: home,
					PATH: path,
					XDG_DATA_HOME: join(home, "data"),
					AGENTPULSE_OPENCODE_DB: db,
				},
			});
		const custom = join(home, "db $(touch executed).db");
		writeFileSync(custom, "untouched");
		const found = run(custom, bin);
		expect(found.exitCode).toBe(0);
		expect(found.stdout.toString()).toContain(custom);
		expect(found.stdout.toString()).toContain("AGENTPULSE_OPENCODE_ENABLED=true");
		expect(found.stdout.toString()).toContain("remote relay/supervisor");
		expect(readFileSync(custom, "utf8")).toBe("untouched");
		expect(existsSync(marker)).toBe(false);
		const absent = run("", join(home, "empty-bin"));
		expect(absent.exitCode).toBe(0);
		expect(absent.stdout.toString()).toBe("");
		mkdirSync(join(home, "data", "opencode"), { recursive: true });
		writeFileSync(join(home, "data", "opencode", "opencode.db"), "untouched");
		expect(run("", join(home, "empty-bin")).stdout.toString()).toContain(
			join(home, "data", "opencode", "opencode.db"),
		);
		expect(existsSync(join(home, ".env.local"))).toBe(false);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("upgrades preserve explicit single-line OpenCode dotenv settings without executing them", () => {
	const script = readFileSync(new URL("./install-local.sh", import.meta.url), "utf8");
	const start = script.indexOf("# Retain explicit OpenCode opt-in");
	const end = script.indexOf('ap_write_private_no_follow "${ENV_FILE}"', start);
	const home = mkdtempSync(join(tmpdir(), "opencode-env-"));
	try {
		const env = join(home, "env");
		writeFileSync(
			env,
			'UNRELATED=secret\nAGENTPULSE_OPENCODE_ENABLED=true\nAGENTPULSE_OPENCODE_DB="/tmp/example db"\nAGENTPULSE_OPENCODE_INSTANCE_ID=$(touch executed)',
		);
		const result = Bun.spawnSync(
			[
				"bash",
				"-euc",
				`ENV_CONTENT="base"$'\\n'\n${script.slice(start, end)}\nprintf "%s" "$ENV_CONTENT"`,
			],
			{ cwd: home, env: { ...process.env, ENV_FILE: env } },
		);
		expect(result.exitCode).toBe(0);
		expect(result.stdout.toString()).toBe(
			'base\nAGENTPULSE_OPENCODE_ENABLED=true\nAGENTPULSE_OPENCODE_DB="/tmp/example db"\nAGENTPULSE_OPENCODE_INSTANCE_ID=$(touch executed)\n',
		);
		expect(existsSync(join(home, "executed"))).toBe(false);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
