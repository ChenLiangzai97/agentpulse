import { chromium } from "playwright";
const S = JSON.parse(await Bun.file(process.argv[2] ?? "/tmp/opencode/fixture-state.json").text());
const results: string[] = [];
const check = (ok: boolean, label: string, detail = "") => results.push(`${ok ? "PASS" : "FAIL"}: ${label}${detail ? ` [${detail}]` : ""}`);
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
try {
	const text = async (url: string) => {
		await page.goto(url, { waitUntil: "networkidle" });
		await page.locator("main").waitFor({ timeout: 90_000 });
		return page.locator("main").innerText();
	};
	const managed = await text(S.managedUrl);
	check(!managed.includes("当前仅观察") && !managed.includes("Observed only for now"), "trusted controllable session shows NO observe-only warning");
	check(managed.includes("可对话") && managed.includes("执行器 OpenCode"), "managed page: one connection block says 执行器 OpenCode · 可对话");
	check(!managed.includes("该 Agent 暂时仅支持观察"), "managed page: no legacy 'Agent 暂时仅支持观察' text");
	const external = await text(`${S.url}/sessions/external-browser-fixture`);
	const occurrences = external.split("当前仅观察，安全接续尚未完成。").length - 1;
	check(occurrences === 1, "external page: the read-only copy appears EXACTLY ONCE (no duplicate hint)", `count=${occurrences}`);
	check(external.includes("执行器 OpenCode"), "external page: connection block names the real executor");
	check(!external.includes("该 Agent 暂时仅支持观察"), "external page: no legacy generic observation text");
	await page.goto(`${S.url}/sessions/external-browser-fixture`, { waitUntil: "networkidle" });
	await page.screenshot({ path: "/home/ch/project/work_station/agentpulse/scripts/opencode-p0/worklog-ui-evidence/18-external-connection.png", fullPage: true });
	await page.goto(S.managedUrl, { waitUntil: "networkidle" });
	await page.screenshot({ path: "/home/ch/project/work_station/agentpulse/scripts/opencode-p0/worklog-ui-evidence/19-managed-connection.png", fullPage: true });
	// English locale: switch via the language control if present, else verify the en source string mapping directly.
} finally {
	await browser.close();
	console.log(results.join("\n"));
}
