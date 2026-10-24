/** P1 isolated REAL fork: inherited marker, parent/child isolation, child stop boundary. */
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { chromium } from "playwright";
import { turnTerminal } from "/home/ch/project/work_station/agentpulse/scripts/opencode-p0/p1-turn-correlation.ts";

const S = JSON.parse(await Bun.file(process.argv[2] ?? "/tmp/opencode/fixture-state.json").text());
const OUT = "/home/ch/project/work_station/agentpulse/scripts/opencode-p0/worklog-ui-evidence";
const A = S.managedUrl as string;
const AID = S.sessionId as string;
const tag = crypto.randomUUID().slice(0, 8);
const results: string[] = [];
const check = (ok: boolean, label: string, detail = "") => {
	results.push(`${ok ? "PASS" : "FAIL"}: ${label}${detail ? ` [${detail}]` : ""}`);
	if (!ok) process.exitCode = 1;
};
const db = new Database(join(S.root as string, "agentpulse.db"), { readonly: true });
const rows = (sessionId: string) =>
	db.query("SELECT id, event_type, content, raw_payload FROM events WHERE session_id = $sid ORDER BY id").all({ $sid: sessionId }) as { id: number; event_type?: string; content?: string; raw_payload?: string }[];
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const ta = (p: typeof page) => p.locator('textarea[aria-label="OpenCode 消息"]');
async function sendAndWait(p: typeof page, text: string) {
	await ta(p).fill(text);
	await ta(p).press("Enter");
	for (let i = 0; i < 240; i++) {
		if (turnTerminal(rows(AID), text)) return true;
		await p.waitForTimeout(500);
	}
	return false;
}
try {
	await page.goto(A, { waitUntil: "networkidle" });
	await ta(page).waitFor({ timeout: 90_000 });
	const srcMarker = `P1FORKSRC-${tag}`;
	check(await sendAndWait(page, `P0_HELLO ${srcMarker}`), "parent pre-fork turn completed");
	// Queue a REAL fork through the acceptance route (fixture entry is enabled).
	const fork = await fetch(`${S.url}/api/v1/sessions/${AID}/fork`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ idempotencyKey: `p1fork-${tag}`, childDisplayName: "P1 fork child" }),
	});
	check(fork.status === 202, "fork request accepted", String(fork.status));
	let childId: string | null = null;
	for (let i = 0; i < 240 && !childId; i++) {
		const row = db.query("SELECT child_session_id FROM opencode_forks WHERE parent_session_id = $p").get({ $p: AID }) as { child_session_id?: string } | null;
		childId = row?.child_session_id ?? null;
		if (!childId) await page.waitForTimeout(500);
	}
	check(Boolean(childId), "fork child committed (finalize)", childId ?? "none");
	if (!childId) throw new Error("no_child");
	// Child page: inherited marker present.
	const child = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
	await child.goto(`${S.url}/sessions/${childId}`, { waitUntil: "networkidle" });
	await ta(child).waitFor({ timeout: 90_000 });
	const childText = () => child.locator("main").innerText();
	let inherited = false;
	for (let i = 0; i < 60 && !inherited; i++) {
		inherited = (await childText()).includes(srcMarker);
		if (!inherited) await child.waitForTimeout(500);
	}
	check(inherited, "child INHERITS the pre-fork marker (copyOf history)");
	// Parent post-fork turn must NOT appear in the child; child turn must NOT appear in the parent.
	const parentPost = `P1PARENTPOST-${tag}`;
	check(await sendAndWait(page, `P0_HELLO ${parentPost}`), "parent post-fork turn completed");
	await child.waitForTimeout(1000);
	check(!(await childText()).includes(parentPost), "child does NOT receive the parent's post-fork turn");
	const childTurn = `P1CHILD-${tag}`;
	await ta(child).fill(`P0_HELLO ${childTurn}`);
	await ta(child).press("Enter");
	let childDone = false;
	for (let i = 0; i < 240 && !childDone; i++) {
		childDone = Boolean(turnTerminal(rows(childId), childTurn));
		if (!childDone) await child.waitForTimeout(500);
	}
	check(childDone, "child turn completed on the same instance");
	await page.waitForTimeout(1000);
	check(!(await page.locator("main").innerText()).includes(childTurn), "parent does NOT receive the child's turn");
	// Child stop boundary: abort-only; the parent keeps working.
	await child.getByRole("button", { name: "停止实例" }).click();
	await child.waitForTimeout(2500);
	const afterStop = `P1AFTERSTOP-${tag}`;
	check(await sendAndWait(page, `P0_HELLO ${afterStop}`), "parent still works after the CHILD stop (no shared-instance kill)");
	await page.screenshot({ path: `${OUT}/16-fork-parent-after-child-stop.png`, fullPage: true });
	await child.screenshot({ path: `${OUT}/17-fork-child.png`, fullPage: true });
	await Bun.write(
		`${OUT}/16-fork-correlation.json`,
		JSON.stringify({ tag, parent: AID, child: childId, srcMarker, parentPost, childTurn, afterStop }, null, 1),
	);
} finally {
	db.close();
	await browser.close();
	console.log(results.join("\n"));
}
