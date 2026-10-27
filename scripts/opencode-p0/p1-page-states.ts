/** Full-page states: managed-controllable input consistency + STOPPED/offline page. */
import { chromium } from "playwright";

const S = JSON.parse(await Bun.file(process.argv[2] ?? "/tmp/opencode/fixture-state.json").text());
const OUT = "/home/ch/project/work_station/agentpulse/scripts/opencode-p0/worklog-ui-evidence";
const results: string[] = [];
const check = (ok: boolean, label: string, detail = "") => results.push(`${ok ? "PASS" : "FAIL"}: ${label}${detail ? ` [${detail}]` : ""}`);
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const ta = () => page.locator('textarea[aria-label="OpenCode 消息"]');
const mainText = () => page.locator("main").innerText();
const evidence: Record<string, unknown> = {};
try {
	// 1) Managed, controllable: connection says 可对话 and the input is enabled.
	await page.goto(S.managedUrlB, { waitUntil: "networkidle" });
	await ta().waitFor({ timeout: 90_000 });
	await page.waitForTimeout(1500);
	const before = await mainText();
	check(before.includes("可对话"), "managed page: connection says 可对话");
	check(!(await ta().isDisabled()), "managed page: composer ENABLED (consistent with 可对话)");
	check(!before.includes("当前仅观察") && !before.includes("当前不可发送"), "managed page: no blocking notice");
	evidence.before = { controllable: before.includes("可对话"), composerDisabled: await ta().isDisabled() };
	await page.screenshot({ path: `${OUT}/20-managed-controllable.png`, fullPage: true });

	// 2) STOP the managed instance (real STOP action), reload: guard + composer must agree.
	const stop = page.getByRole("button", { name: "停止实例" });
	if (await stop.count()) {
		await stop.first().click();
		await page.waitForTimeout(4000);
	}
	await page.reload({ waitUntil: "networkidle" });
	await page.waitForTimeout(2500);
	const after = await mainText();
	const composerDisabled = await ta().isDisabled().catch(() => true);
	check(after.includes("当前不可发送"), "stopped page: connection shows 当前不可发送 (unavailable)");
	check(composerDisabled, "stopped page: composer DISABLED (same state as the block)");
	check(!after.includes("可对话"), "stopped page: no stale 可对话");
	evidence.after = { unavailable: after.includes("当前不可发送"), composerDisabled };
	await page.screenshot({ path: `${OUT}/21-managed-stopped.png`, fullPage: true });
	await Bun.write(`${OUT}/21-page-states.json`, JSON.stringify(evidence, null, 1));
} finally {
	await browser.close();
	console.log(results.join("\n"));
}
