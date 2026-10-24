/** Real-component draft isolation evidence: A/B switch, reload, send-clear. */
import { chromium } from "playwright";

const statePath = process.argv[2] ?? "/tmp/opencode/fixture-state.json";
const STATE = JSON.parse(await Bun.file(statePath).text());
const OUT = "/home/ch/project/work_station/agentpulse/scripts/opencode-p0/worklog-ui-evidence";
const results: string[] = [];
const check = (ok: boolean, label: string) => {
	results.push(`${ok ? "PASS" : "FAIL"}: ${label}`);
	if (!ok) process.exitCode = 1;
};

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const textarea = () => page.locator('textarea[aria-label="OpenCode 消息"]');
try {
	// A: type a draft, do NOT send.
	await page.goto(STATE.managedUrl, { waitUntil: "networkidle" });
	await textarea().waitFor({ timeout: 30_000 });
	await textarea().fill("A 会话的未发送草稿 ABC-123");
	await page.waitForTimeout(400);
	// B (direct URL, second fixture-managed session): must start EMPTY.
	await page.goto(STATE.managedUrlB, { waitUntil: "networkidle" });
	await textarea().waitFor({ timeout: 30_000 });
	check((await textarea().inputValue()) === "", "B shows an EMPTY draft (no leak from A)");
	await page.screenshot({ path: `${OUT}/6-draft-b-empty.png`, fullPage: true });
	// Back to A via the tab bar (component reuse without a key).
	await page.getByRole("tab", { name: /OpenCode managed acceptance/i }).click();
	const sessionAId = STATE.managedUrl.split("/").pop() ?? "";
	await page.waitForURL(new RegExp(sessionAId), { timeout: 15_000 });
	await page.waitForTimeout(800);
	check(
		(await textarea().inputValue()) === "A 会话的未发送草稿 ABC-123",
		"switching back to A restores its draft",
	);
	// Reload: draft survives (persisted per viewer).
	await page.reload({ waitUntil: "networkidle" });
	await textarea().waitFor({ timeout: 30_000 });
	check(
		(await textarea().inputValue()) === "A 会话的未发送草稿 ABC-123",
		"draft survives a page reload",
	);
	await page.screenshot({ path: `${OUT}/7-draft-a-restored.png`, fullPage: true });
	// Send: input and stored draft clear after delivery.
	await textarea().fill("发送后应清空");
	await textarea().press("Enter");
	for (let i = 0; i < 100; i++) {
		if ((await textarea().inputValue()) === "") break;
		await page.waitForTimeout(300);
	}
	check((await textarea().inputValue()) === "", "sending clears the input");
	await page.reload({ waitUntil: "networkidle" });
	await textarea().waitFor({ timeout: 30_000 });
	check((await textarea().inputValue()) === "", "cleared draft stays cleared after reload");
	await page.screenshot({ path: `${OUT}/8-draft-cleared-after-send.png`, fullPage: true });
} finally {
	await browser.close();
	console.log(results.join("\n"));
}
