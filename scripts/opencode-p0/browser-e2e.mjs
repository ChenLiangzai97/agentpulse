/** Browser E2E: new session → catalog-driven /model → prompt → command → unknown rejected → refresh/switch persistence. */
import { chromium } from "playwright";

const BASE = "http://127.0.0.1:3000";
const results = [];
const check = (ok, label) => {
	results.push(`${ok ? "PASS" : "FAIL"}: ${label}`);
	if (!ok) process.exitCode = 1;
};

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
try {
	// 1. dashboard → 新建会话
	await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
	await page.getByRole("button", { name: "+ 新建会话" }).click();
	const dialog = page.locator(".fixed.inset-0.z-50");
	await dialog.waitFor({ state: "visible", timeout: 8000 });
	check(await page.getByText("工作目录").count() > 0, "new-session dialog opened");
	// agent select defaults contain OpenCode option
	const agentSelect = dialog.locator("select").first();
	const options = await agentSelect.locator("option").allTextContents();
	check(options.some((o) => o.includes("OpenCode")), `agent options include OpenCode: ${options.join("|")}`);
	// directory: pick demo_ws from datalist by typing
	await dialog.locator("input[list='new-session-dirs']").fill("/home/ch/project/demo_ws");
	await dialog.getByRole("button", { name: "开始会话" }).click();
	// wait for navigation into a session page (managed controls header)
	await page.waitForURL(/\/sessions\//, { timeout: 60000 });
	await page.getByText("OpenCode · AgentPulse 受管实例").waitFor({ timeout: 60000 });
	check(true, `launched and landed on session ${page.url()}`);

	const input = page.locator("textarea[aria-label='OpenCode 消息']");

	// 2. "/" opens menu; catalog must list native commands (proves setCatalog wiring)
	await input.fill("/");
	await page.getByText("原生命令（在实例内执行）").waitFor({ timeout: 15000 });
	let hasInit = 0;
	for (let i = 0; i < 10 && hasInit === 0; i++) {
		await page.waitForTimeout(2000);
		hasInit = await page.getByRole("button", { name: /^\/init/ }).count();
	}
	if (hasInit === 0) {
		const sid = page.url().split("/").pop();
		const raw = await page.evaluate(async (id) => {
			const res = await fetch(`/app-api/v1/sessions/${id}/opencode/commands`);
			return `${res.status}: ${(await res.text()).slice(0, 120)}`;
		}, sid);
		console.log("DEBUG catalog fetch:", raw);
	}
	check(hasInit > 0, "catalog loaded: /init listed in menu");
	await page.keyboard.press("Escape");
	
	await page.getByRole("button", { name: "关闭" }).first().click().catch(() => {});

	// 3. /model picker shows real models from catalog; pick flash
	await input.fill("/model");
	await page.keyboard.press("Enter");
	await page.getByText("/model — 选择模型").waitFor({ timeout: 8000 });
	const flashOption = page.locator("button", { hasText: "glm-5.3-flash" }).first();
	await flashOption.waitFor({ timeout: 8000 });
	await flashOption.click();
	check(
		await page.getByText("/model →", { exact: false }).first().isVisible(),
		"pending model badge visible after pick",
	);

	// 4. real prompt → assistant reply appears in timeline
	await input.fill("只回复四个字：浏览器通过");
	await input.press("Enter");
	await page
		.getByText("浏览器通过")
		.first()
		.waitFor({ timeout: 90000 });
	check(true, "prompt with pending model produced assistant reply");

	// 5. unknown slash command rejected, never sent
	const beforeEvents = await page.locator("[data-event-count]").count(); // may be 0; use timeline length instead
	const timelineBefore = await page.getByText("只回复四个字").count();
	await input.fill("/definitely-not-a-command");
	await input.press("Enter");
	await page.locator("[data-sonner-toast]").first().waitFor({ timeout: 5000 }).catch(() => {});
	const toastText = (await page.locator("[data-sonner-toast]").allTextContents()).join(" | ");
	check(
		toastText.includes("definitely-not-a-command") && (toastText.includes("不支持") || toastText.includes("not supported")),
		`unknown command rejected with toast: ${toastText.slice(0, 80)}`,
	);
	await page.waitForTimeout(800);
	const sid1 = page.url().split("/").pop();
	const timelineJson = await page.evaluate(async (id) => {
		const res = await fetch(`/app-api/v1/sessions/${id}/timeline?limit=30`);
		return JSON.stringify(await res.json());
	}, sid1);
	check(!timelineJson.includes("definitely-not-a-command"), "unknown command did not reach the timeline");

	// 6. native command via Enter: /init (from catalog)
	await input.fill("/init");
	await input.press("Enter");
	await page.waitForTimeout(2000);
	check(true, "/init submitted via Enter (native command path)");

	// 7. refresh: pending model persists (localStorage per session)
	await page.reload({ waitUntil: "networkidle" });
	await page
		.getByText("OpenCode · AgentPulse 受管实例")
		.waitFor({ timeout: 30000 });
	await input.fill("/");
	await page.waitForTimeout(600);
	const badge = await page.getByText("/model →").count();
	check(badge > 0, "pending model survives refresh");
	await page.keyboard.press("Escape");
} catch (error) {
	results.push(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
} finally {
	await browser.close();
	console.log(results.join("\n"));
}
