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
	const external = await text(`${S.url}/sessions/external-browser-fixture`);
	check(external.includes("当前仅观察，安全接续尚未完成。"), "external/unknown session shows the zh read-only warning");
	// English locale: switch via the language control if present, else verify the en source string mapping directly.
} finally {
	await browser.close();
	console.log(results.join("\n"));
}
