import { mkdirSync } from "node:fs";
/** Worklog dual-view browser evidence (real chrome via playwright). */
import { chromium } from "playwright";

const BASE = "http://127.0.0.1:3100";
const OUT = "/home/ch/project/work_station/agentpulse/scripts/opencode-p0/worklog-ui-evidence";
mkdirSync(OUT, { recursive: true });
const results = [];
const check = (ok, label) => {
	results.push(`${ok ? "PASS" : "FAIL"}: ${label}`);
	if (!ok) process.exitCode = 1;
};

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
try {
	await page.goto(`${BASE}/worklog`, { waitUntil: "networkidle" });
	await page.getByRole("heading", { name: "每日工作日志" }).waitFor({ timeout: 10_000 });
	// 1. scope preview for the seeded date
	await page.locator('input[aria-label="日志日期"]').fill("2026-10-16");
	await page.getByRole("heading", { name: /范围预览/ }).waitFor({ timeout: 10_000 });
	const previewText = await page.locator("[aria-label='范围预览']").innerText();
	check(previewText.includes("会话工作台开发"), "scope preview lists seeded session A");
	check(previewText.includes("日志双视图开发"), "scope preview lists seeded session B");
	check(/\b1\b.*\b1\b.*\b1\b/.test(previewText), "scope preview shows event counts");
	// Isolation: ONLY the two seeded sessions; no real hostnames may appear.
	const previewRows = await page.locator("[aria-label='范围预览'] tbody tr").count();
	check(previewRows === 2, `preview contains exactly the 2 seeded sessions (got ${previewRows})`);
	check(!/ch-[A-Z0-9-]+/.test(previewText), "no real hostname in preview");
	await page.screenshot({ path: `${OUT}/1-scope-preview.png`, fullPage: true });
	// 2. open the generated run and inspect dual views
	await page
		.getByRole("button", { name: /2026-10-16/ })
		.first()
		.click();
	await page.getByRole("tab", { name: /团队日报/ }).waitFor({ timeout: 10_000 });
	const teamText = await page.locator("article").innerText();
	for (const section of ["成果", "进行中", "阻塞", "下一步"]) {
		check(teamText.includes(section), `team draft has section ${section}`);
	}
	await page.screenshot({ path: `${OUT}/2-team-view.png`, fullPage: true });
	// 3. personal view with evidence back-references
	await page.getByRole("tab", { name: /个人回顾/ }).click();
	const personalText = await page.locator("article").innerText();
	// Evidence back-link must be a real, clickable deep link to the event.
	const evidenceLink = page.locator("article a", { hasText: /^事件 #/ }).first();
	check((await evidenceLink.count()) > 0, "personal view renders evidence links");
	const [popup] = await Promise.all([
		page.context().waitForEvent("page", { timeout: 10_000 }),
		evidenceLink.click(),
	]);
	await popup.waitForURL(/\/sessions\/e2e-main\?tab=activity#event-\d+/, { timeout: 10_000 });
	// The link must not just change the URL: the TARGET EVENT has to load and
	// be located in the activity timeline (element id = URL hash).
	const hash = popup.url().split("#")[1] ?? "";
	await popup.locator(`#${hash}`).waitFor({ state: "visible", timeout: 20_000 });
	check(true, `evidence link loaded and located event element #${hash}`);
	await popup.close();
	check(personalText.includes("目标与指令"), "personal view labels fact categories");
	check(personalText.includes("助手自述"), "claims stay separated from results");
	await page.screenshot({ path: `${OUT}/3-personal-view.png`, fullPage: true });
	// 4. version diff against the adopted version
	await page.getByRole("heading", { name: /与当前采用版本的差异/ }).waitFor({ timeout: 10_000 });
	check(true, "diff panel shown for non-adopted version");
	await page.screenshot({ path: `${OUT}/4-version-diff.png`, fullPage: true });
	// 5. manual edit flow
	await page.getByRole("button", { name: /编辑此版本/ }).click();
	const textarea = page.locator('textarea[aria-label="编辑版本内容"]');
	await textarea.waitFor({ timeout: 5000 });
	await textarea.fill(`${await textarea.inputValue()}\n## 人工补充\n- 浏览器验收补充说明`);
	await page.getByRole("button", { name: /保存为人工版本并采用/ }).click();
	await page.getByRole("tab", { name: /人工编辑/ }).waitFor({ timeout: 10_000 });
	check(
		(await page.locator("article").innerText()).includes("人工补充"),
		"manual edit saved and rendered",
	);
	check(
		(await page.getByRole("tab", { name: /已采用/ }).count()) > 0,
		"manual version marked adopted",
	);
	// Persistence: reload the page — the manual version survives server-side.
	await page.reload({ waitUntil: "networkidle" });
	await page
		.getByRole("button", { name: /2026-10-16/ })
		.first()
		.click();
	await page.getByRole("tab", { name: /人工编辑/ }).waitFor({ timeout: 10_000 });
	check(
		(await page.locator("article").innerText()).includes("人工补充"),
		"manual edit persists after reload",
	);
	await page.screenshot({ path: `${OUT}/5-manual-edit.png`, fullPage: true });
} finally {
	await browser.close();
	console.log(results.join("\n"));
}
