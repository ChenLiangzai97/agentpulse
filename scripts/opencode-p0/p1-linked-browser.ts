/** P1 linked evidence: real-accepted late response across in-app tabs + closed-tab turn. */
import { chromium } from "playwright";
import { Database } from "bun:sqlite";
import { join } from "node:path";

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
	// Native messageID correlation via the fixture DB (read-only).
	const db = new Database(join(STATE.root as string, "agentpulse.db"), { readonly: true });
	const events = db.query("SELECT content, raw_payload FROM events WHERE session_id = ? ORDER BY id").all as never;
	const rows = () => db.query("SELECT content, raw_payload FROM events WHERE session_id = $sid ORDER BY id").all({ $sid: STATE.sessionId }) as { content?: string; raw_payload?: string }[];
	const payload = (row: { raw_payload?: string }) => {
		try { return JSON.parse(row.raw_payload ?? "{}") as { message_id?: string; source_data?: { finish?: string } }; } catch { return {}; }
	};
	const userMessageId = (marker: string) => {
		for (const row of rows()) {
			const p = payload(row);
			if (String(row.content ?? "").includes(marker) && p.message_id) return p.message_id;
		}
		return null;
	};
	const hasTerminal = (messageId: string) =>
		rows().some((row) => {
			const p = payload(row);
			return p.message_id === messageId && p.source_data?.finish === "stop";
		});
	void events;
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

	// ── Scenario 2: closing the BROWSER tab mid-turn, correlated by native messageID.
	const tabMarker = `P1TAB-${tag}`;
	await textarea().fill(`P0_ABORT ${tabMarker}`);
	await textarea().press("Enter");
	let tabMessageId: string | null = null;
	for (let i = 0; i < 120 && !tabMessageId; i++) {
		tabMessageId = userMessageId(tabMarker);
		if (!tabMessageId) await page.waitForTimeout(250);
	}
	check(Boolean(tabMessageId), "the closed-tab turn has a native messageID", tabMessageId ?? "none");
	check(Boolean(tabMessageId) && !hasTerminal(tabMessageId as string), "the turn is STILL IN FLIGHT at close (no terminal for that messageID)");
	await page.close();
	await new Promise((r) => setTimeout(r, 6000));
	const reopened = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
	await reopened.goto(A, { waitUntil: "networkidle" });
	await reopened.locator('textarea[aria-label="OpenCode 消息"]').waitFor({ timeout: 60_000 });
	let terminal = false;
	for (let i = 0; i < 120 && !terminal; i++) {
		terminal = Boolean(tabMessageId) && hasTerminal(tabMessageId as string);
		if (!terminal) await reopened.waitForTimeout(500);
	}
	check(terminal, "the SAME native messageID reached its terminal after reopening", tabMessageId ?? "none");
	await reopened.screenshot({ path: `${OUT}/13-linked-closed-browser-tab.png`, fullPage: true });

	// ── Scenario 3: closing the APP session tab mid-turn (same messageID link).
	const appMarker = `P1APPTAB-${tag}`;
	await reopened.locator('textarea[aria-label="OpenCode 消息"]').fill(`P0_ABORT ${appMarker}`);
	await reopened.locator('textarea[aria-label="OpenCode 消息"]').press("Enter");
	let appMessageId: string | null = null;
	for (let i = 0; i < 120 && !appMessageId; i++) {
		appMessageId = userMessageId(appMarker);
		if (!appMessageId) await reopened.waitForTimeout(250);
	}
	check(Boolean(appMessageId), "the app-tab-close turn has a native messageID", appMessageId ?? "none");
	check(Boolean(appMessageId) && !hasTerminal(appMessageId as string), "the app-tab turn is IN FLIGHT at close");
	await reopened.getByRole("button", { name: /Close OpenCode managed acceptance/i }).click();
	await reopened.waitForTimeout(1500);
	await reopened.goto(A, { waitUntil: "networkidle" });
	await reopened.locator('textarea[aria-label="OpenCode 消息"]').waitFor({ timeout: 60_000 });
	terminal = false;
	for (let i = 0; i < 120 && !terminal; i++) {
		terminal = Boolean(appMessageId) && hasTerminal(appMessageId as string);
		if (!terminal) await reopened.waitForTimeout(500);
	}
	check(terminal, "the SAME native messageID reached its terminal after app-tab close", appMessageId ?? "none");
	await reopened.screenshot({ path: `${OUT}/14-linked-closed-app-tab.png`, fullPage: true });
	db.close();
} finally {
	await browser.close();
	console.log(results.join("\n"));
}
