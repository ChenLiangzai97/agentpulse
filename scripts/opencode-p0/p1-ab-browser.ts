/** P1 4+6 browser: A/B late response isolation + closed-tab background execution. */
import { chromium } from "playwright";

const STATE = JSON.parse(await Bun.file(process.argv[2] ?? "/tmp/opencode/fixture-state.json").text());
const OUT = "/home/ch/project/work_station/agentpulse/scripts/opencode-p0/worklog-ui-evidence";
const results: string[] = [];
const check = (ok: boolean, label: string) => {
	results.push(`${ok ? "PASS" : "FAIL"}: ${label}`);
	if (!ok) process.exitCode = 1;
};
const A = STATE.managedUrl as string;
const B = STATE.managedUrlB as string;
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const textarea = () => page.locator('textarea[aria-label="OpenCode 消息"]');
const body = () => page.locator("body");
try {
	// ── Scenario 1: A's response arrives LATE while B is open.
	await page.goto(A, { waitUntil: "networkidle" });
	await textarea().waitFor({ timeout: 60_000 });
	let release: (() => void) | null = null;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	await page.route(`**/sessions/${A.split("/").pop()}/opencode/actions`, async (route) => {
		await gate;
		await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
	});
	await textarea().fill("A 的迟到响应 LATE-A");
	await textarea().press("Enter");
	await page.goto(B, { waitUntil: "networkidle" });
	await textarea().waitFor({ timeout: 60_000 });
	release?.();
	await page.waitForTimeout(2500);
	check(!(await body().innerText()).includes("LATE-A"), "B does NOT receive A's late response");
	check((await textarea().inputValue()) === "", "B input is unaffected by A's late send");
	await page.screenshot({ path: `${OUT}/11-ab-late-response-isolated.png`, fullPage: true });
	await page.unroute(`**/sessions/${A.split("/").pop()}/opencode/actions`);
	await page.goto(A, { waitUntil: "networkidle" });
	await textarea().waitFor({ timeout: 60_000 });
	check((await textarea().inputValue()) === "", "A's own input cleared after its (late) delivery");

	// ── Scenario 2: closing the tab must not stop the turn.
	await textarea().fill("P0_HELLO");
	await textarea().press("Enter");
	await page.close();
	const reopened = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
	await reopened.goto(A, { waitUntil: "networkidle" });
	await reopened.locator('textarea[aria-label="OpenCode 消息"]').waitFor({ timeout: 60_000 });
	let done = false;
	for (let i = 0; i < 60 && !done; i++) {
		const text = await reopened.locator("body").innerText();
		done = text.includes("P0_DONE");
		if (!done) await reopened.waitForTimeout(500);
	}
	check(done, "closing the tab keeps the turn running server-side (P0_DONE appears on reopen)");
	await reopened.screenshot({ path: `${OUT}/12-closed-tab-background-done.png`, fullPage: true });
} finally {
	await browser.close();
	console.log(results.join("\n"));
}
