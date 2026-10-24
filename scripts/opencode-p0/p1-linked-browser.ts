/** P1 linked evidence: real-accepted late response across in-app tabs + closed-tab turn. */
import { chromium } from "playwright";

const STATE = JSON.parse(await Bun.file(process.argv[2] ?? "/tmp/opencode/fixture-state.json").text());
const OUT = "/home/ch/project/work_station/agentpulse/scripts/opencode-p0/worklog-ui-evidence";
const results: string[] = [];
const check = (ok: boolean, label: string, detail = "") => {
	results.push(`${ok ? "PASS" : "FAIL"}: ${label}${detail ? ` [${detail}]` : ""}`);
	if (!ok) process.exitCode = 1;
};
const A = STATE.managedUrl as string;
const AID = A.split("/").pop() as string;
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const textarea = () => page.locator('textarea[aria-label="OpenCode 消息"]');
const bodyText = () => page.locator("body").innerText();
const tag = crypto.randomUUID().slice(0, 8);
try {
	// BUILD PROVENANCE: the fixture serves dist/web; refuse to trust evidence if
	// the bundle was not built from the CURRENT commit.
	const head = (await Bun.$`git -C /home/ch/project/work_station/agentpulse rev-parse HEAD`.text()).trim();
	const info = STATE.buildInfo as { commit?: string; builtAt?: string } | null;
	const fresh = Boolean(info && info.commit === head && STATE.buildStale === false);
	check(fresh, "fixture serves a build of the CURRENT source", `build=${info?.commit ?? "none"} head=${head}`);
	if (!fresh) throw new Error("stale_build");
	await page.goto(A, { waitUntil: "networkidle" });
	await textarea().waitFor({ timeout: 90_000 });
	// Open B once so BOTH tabs exist in the workbench, then return to A via tab.
	await page.goto(STATE.managedUrlB, { waitUntil: "networkidle" });
	await page.waitForTimeout(500);
	await page.getByRole("tab", { name: /OpenCode managed acceptance/i }).click();
	await page.waitForTimeout(500);

	// ── Scenario 1: REAL acceptance, response delayed across an in-app tab switch.
	let release: (() => void) | null = null;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let captured = false;
	let acceptedActionId: string | null = null;
	let acceptedStatus = 0;
	await page.route(`**/sessions/${AID}/opencode/actions`, async (route) => {
		const response = await route.fetch(); // REAL request/response
		captured = true;
		acceptedStatus = response.status();
		if (response.ok()) {
			const body = (await response.json().catch(() => null)) as { action?: { id?: string } } | null;
			acceptedActionId = body?.action?.id ?? null;
		}
		await gate; // only the RESPONSE is delayed
		await route.fulfill({ response });
	});
	const lateMarker = `P1LATE-${tag}`;
	await textarea().fill(lateMarker);
	await textarea().press("Enter");
	for (let i = 0; i < 50 && !captured; i++) await page.waitForTimeout(100);
	check(
		captured && acceptedStatus >= 200 && acceptedStatus < 300,
		"the late send was ACCEPTED by the real server",
		`status=${acceptedStatus} action=${acceptedActionId ?? "unknown"}`,
	);
	// Switch to B INSIDE the app (tab bar), keeping A mounted in the workbench.
	await page.getByRole("tab", { name: /OpenCode managed B/i }).click();
	await page.waitForTimeout(1200);
	const bUrl = page.url();
	check(bUrl.endsWith(STATE.managedUrlB.split("/").pop() as string), "the URL is B's session", bUrl);
	console.log("AFTER-B-TAB-URL:", bUrl);
	const bBefore = await textarea().inputValue();
	release?.();
	await page.waitForTimeout(2500);
	check(bBefore === "", "B input was empty before A's late response");
	const bText = await bodyText();
	if (bText.includes(lateMarker)) {
		const at = bText.indexOf(lateMarker);
		console.log("B-CONTEXT:", JSON.stringify(bText.slice(Math.max(0, at - 160), at + 160)));
		await page.screenshot({ path: `${OUT}/debug-b-late.png`, fullPage: true });
	}
	const visibleB = await page.locator("main").innerText();
	const bEvents = (await page.evaluate(async (id) => {
		const res = await fetch(`/app-api/v1/sessions/${id}`);
		if (!res.ok) return [];
		const data = (await res.json()) as { events?: { content?: string }[] };
		return data.events ?? [];
	}, STATE.managedUrlB.split("/").pop() as string)) as { content?: string }[];
	if (visibleB.includes(lateMarker)) {
		const at = visibleB.indexOf(lateMarker);
		console.log("VISIBLE-B-CONTEXT:", JSON.stringify(visibleB.slice(Math.max(0, at - 200), at + 200)));
		console.log("VISIBLE-B-LEN:", visibleB.length, "HAS-P0_HELLO:", /P0_HELLO/.test(visibleB));
	}
	check(
		!visibleB.includes(lateMarker) && !bEvents.some((event) => String(event.content ?? "").includes(lateMarker)),
		"B's visible timeline AND B's events API do NOT contain A's late turn",
		`visible=${visibleB.includes(lateMarker)} api=${bEvents.some((e) => String(e.content ?? "").includes(lateMarker))}`,
	);
	// Back to A: the REAL accepted turn must be in A's transcript.
	await page.getByRole("tab", { name: /OpenCode managed acceptance/i }).click();
	await page.waitForTimeout(1500);
	const aText = await bodyText();
	check(aText.includes(lateMarker), "A's accepted turn is in A's transcript");
	const aInput = await textarea().inputValue();
	check(aInput === "", "A's persisted draft cleared after REAL acceptance (late, unmounted)", `input=${JSON.stringify(aInput)}`);

	// ── Scenario 1b: rewrite during the delayed response must survive.
	await page.unroute(`**/sessions/${AID}/opencode/actions`);
	let release2: (() => void) | null = null;
	const gate2 = new Promise<void>((resolve) => {
		release2 = resolve;
	});
	await page.route(`**/sessions/${AID}/opencode/actions`, async (route) => {
		const response = await route.fetch();
		await gate2;
		await route.fulfill({ response });
	});
	const rewriteMarker = `P1REWRITE-${tag}`;
	await textarea().fill(`P1SENT-${tag}`);
	await textarea().press("Enter");
	await page.waitForTimeout(600); // request accepted; response still delayed
	await textarea().fill(rewriteMarker);
	release2?.();
	await page.waitForTimeout(2000);
	check((await textarea().inputValue()) === rewriteMarker, "a draft rewritten during the send survives");
	await page.unroute(`**/sessions/${AID}/opencode/actions`);

	// ── Scenario 1c: a REAL aborted request keeps the draft.
	await page.route(`**/sessions/${AID}/opencode/actions`, (route) => route.abort("failed"));
	const failMarker = `P1FAIL-${tag}`;
	await textarea().fill(failMarker);
	await textarea().press("Enter");
	await page.waitForTimeout(1500);
	check((await textarea().inputValue()) === failMarker, "a failed request keeps the draft");
	await page.unroute(`**/sessions/${AID}/opencode/actions`);
	await page.reload({ waitUntil: "networkidle" });
	await textarea().waitFor({ timeout: 60_000 });
	check((await textarea().inputValue()) === failMarker, "the failed draft persists after reload");

	// ── Scenario 2: closing the BROWSER tab mid-turn (unique marker + new terminal).
	const beforeDone = ((await bodyText()).match(/P0_DONE/g) ?? []).length;
	const tabMarker = `P1TAB-${tag}`;
	await textarea().fill(`P0_ABORT ${tabMarker}`);
	await textarea().press("Enter");
	let accepted = false;
	for (let i = 0; i < 60 && !accepted; i++) {
		accepted = (await bodyText()).includes(tabMarker);
		if (!accepted) await page.waitForTimeout(250);
	}
	check(accepted, "the closed-tab turn was accepted before closing");
	await page.close();
	await new Promise((r) => setTimeout(r, 6000));
	const reopened = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
	await reopened.goto(A, { waitUntil: "networkidle" });
	await reopened.locator('textarea[aria-label="OpenCode 消息"]').waitFor({ timeout: 60_000 });
	let afterDone = 0;
	for (let i = 0; i < 120; i++) {
		const text = await reopened.locator("body").innerText();
		afterDone = (text.match(/P0_DONE/g) ?? []).length;
		if (afterDone > beforeDone && text.includes(tabMarker)) break;
		await reopened.waitForTimeout(500);
	}
	check(
		afterDone > beforeDone,
		"a NEW terminal appeared after reopening (uncorrelated to messageID; kept OPEN)",
		`${beforeDone}->${afterDone}`,
	);
	await reopened.screenshot({ path: `${OUT}/13-linked-closed-browser-tab.png`, fullPage: true });
} finally {
	await browser.close();
	console.log(results.join("\n"));
}
