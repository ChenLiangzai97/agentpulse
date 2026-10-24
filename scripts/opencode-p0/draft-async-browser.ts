/** Async draft behaviors via route interception: rewrite-during-send, failed send. */
import { chromium } from "playwright";

const statePath = process.argv[2] ?? "/tmp/opencode/fixture-state.json";
const STATE = JSON.parse((await Bun.file(statePath).text()));
const OUT = "/home/ch/project/work_station/agentpulse/scripts/opencode-p0/worklog-ui-evidence";
const results: string[] = [];
const check = (ok: boolean, label: string) => {
	results.push(`${ok ? "PASS" : "FAIL"}: ${label}`);
	if (!ok) process.exitCode = 1;
};

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const textarea = () => page.locator('textarea[aria-label="OpenCode 消息"]');
const actionsGlob = "**/sessions/*/opencode/actions";
try {
	await page.goto(STATE.managedUrl, { waitUntil: "networkidle" });
	await textarea().waitFor({ timeout: 90_000 });

	// ── Scenario 1: rewrite during a SLOW send — the new text must survive.
	let release: (() => void) | null = null;
	await page.route(actionsGlob, async (route) => {
		if (release === null) return route.fallback();
		await new Promise<void>((resolve) => {
			release = resolve;
		});
		await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
	});
	release = () => {};
	await textarea().fill("发送期间改写前的文本");
	await textarea().press("Enter");
	await textarea().fill("发送期间改写后的文本"); // rewrite while the send is pending
	await page.waitForTimeout(200);
	(release as unknown as () => void)(); // release the delayed 200
	await page.waitForTimeout(1200);
	check(
		(await textarea().inputValue()) === "发送期间改写后的文本",
		"rewrite during a slow send keeps the NEW text (input not cleared)",
	);
	await page.reload({ waitUntil: "networkidle" });
	await textarea().waitFor({ timeout: 30_000 });
	check(
		(await textarea().inputValue()) === "发送期间改写后的文本",
		"the rewritten draft is what persists",
	);
	await page.screenshot({ path: `${OUT}/9-draft-rewrite-during-send.png`, fullPage: true });

	// ── Scenario 2: a FAILED send keeps the draft for retry.
	await page.unroute(actionsGlob);
	await page.route(actionsGlob, (route) =>
		route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"injected_failure"}' }),
	);
	await textarea().fill("失败应保留的文本");
	await textarea().press("Enter");
	await page.waitForTimeout(1200);
	check((await textarea().inputValue()) === "失败应保留的文本", "a failed send keeps the draft in the input");
	await page.unroute(actionsGlob);
	await page.reload({ waitUntil: "networkidle" });
	await textarea().waitFor({ timeout: 30_000 });
	check((await textarea().inputValue()) === "失败应保留的文本", "the failed-send draft persists after reload");
	await page.screenshot({ path: `${OUT}/10-draft-failed-send-kept.png`, fullPage: true });
} finally {
	await browser.close();
	console.log(results.join("\n"));
}
