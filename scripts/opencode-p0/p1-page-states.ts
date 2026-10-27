/** Full-page: managed controllable vs REAL stopped; fail-closed assertions. */
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { chromium } from "playwright";

const S = JSON.parse(await Bun.file(process.argv[2] ?? "/tmp/opencode/fixture-state.json").text());
const OUT = "/home/ch/project/work_station/agentpulse/scripts/opencode-p0/worklog-ui-evidence";
const BID = String(S.managedUrlB).split("/").filter(Boolean).pop() as string;
const results: string[] = [];
const fail = (label: string) => {
	results.push(`FAIL: ${label}`);
	process.exitCode = 1;
};
const pass = (label: string, detail = "") => results.push(`PASS: ${label}${detail ? ` [${detail}]` : ""}`);
const check = (ok: boolean, label: string, detail = "") => (ok ? pass(label, detail) : fail(`${label}${detail ? ` [${detail}]` : ""}`));
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const ta = () => page.locator('textarea[aria-label="OpenCode 消息"]');
const mainText = () => page.locator("main").innerText();
const db = new Database(join(S.root as string, "agentpulse.db"), { readonly: true });
const evidence: Record<string, unknown> = {};
try {
	await page.goto(S.managedUrlB, { waitUntil: "networkidle" });
	// Missing composer is a FAILURE, not a skip.
	const composer = ta();
	await composer.waitFor({ timeout: 90_000 });
	await page.waitForTimeout(2000);
	const before = await mainText();
	check(before.includes("可对话"), "managed page: connection says 可对话");
	check(!(await composer.isDisabled()), "managed page: composer ENABLED (consistent with 可对话)");
	check(!before.includes("当前仅观察") && !before.includes("当前不可发送"), "managed page: no blocking notice");
	await page.screenshot({ path: `${OUT}/20-managed-controllable.png`, fullPage: true });

	const stop = page.getByRole("button", { name: "停止实例" });
	if ((await stop.count()) === 0) {
		fail("stopped page: the 停止实例 button is MISSING (cannot exercise stop)");
	} else {
		await stop.first().click();
		await page.waitForTimeout(4000);
		// The STOP must REALLY succeed: action row + protected binding.
		const action = db
			.query("SELECT id, status FROM control_actions WHERE session_id = $s AND action_type = 'stop' ORDER BY rowid DESC LIMIT 1")
			.get({ $s: BID }) as { id?: string; status?: string } | null;
		const binding = db
			.query("SELECT stop_state, stop_epoch FROM session_control_bindings WHERE session_id = $s")
			.get({ $s: BID }) as { stop_state?: string; stop_epoch?: number } | null;
		check(action?.status === "succeeded", "real STOP action succeeded", `id=${action?.id} status=${action?.status}`);
		check(binding?.stop_state === "stopped", "binding reached protected stopped", `state=${binding?.stop_state} epoch=${binding?.stop_epoch}`);
		evidence.stop = { action, binding };
		await page.reload({ waitUntil: "networkidle" });
		await page.waitForTimeout(2500);
		const after = await mainText();
		const composerCount = await ta().count();
		const composerDisabled = composerCount === 0 ? true : await ta().isDisabled();
		check(after.includes("当前不可发送"), "stopped page: connection shows 当前不可发送");
		check(composerDisabled, "stopped page: composer DISABLED or absent (no usable input)", `count=${composerCount}`);
		check(!after.includes("可对话"), "stopped page: no stale 可对话");
		evidence.after = { unavailable: after.includes("当前不可发送"), composerCount, composerDisabled };
		await page.screenshot({ path: `${OUT}/21-managed-stopped.png`, fullPage: true });
	}
	await Bun.write(`${OUT}/21-page-states.json`, JSON.stringify(evidence, null, 1));
} catch (error) {
	fail(`harness error: ${error instanceof Error ? error.message : String(error)}`);
} finally {
	db.close();
	await browser.close();
	console.log(results.join("\n"));
}
