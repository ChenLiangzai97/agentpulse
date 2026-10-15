import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import "../db/__test_db.js";
import { app } from "../app.js";
import { createApiKey } from "../auth/api-key.js";
import { config } from "../config.js";
import { getDb, initializeDatabase } from "../db/client.js";
import { apiKeys, sessions, settings } from "../db/schema/index.js";
import { upsertSetting } from "../services/settings-service.js";
const original = config.disableAuth;
beforeAll(() => initializeDatabase());
beforeEach(async () => {
	config.disableAuth = false;
	for (const table of [apiKeys, sessions, settings]) await getDb().delete(table);
});
afterEach(() => {
	config.disableAuth = original;
});
const jsonHeaders = (key: string) => ({
	Authorization: `Bearer ${key}`,
	"Content-Type": "application/json",
});
test("observe and ingest keys cannot read or mutate log exports and native approvals", async () => {
	for (const scope of ["observe", "ingest"] as const) {
		const { key } = await createApiKey(`log-${scope}`, [scope]);
		for (const path of [
			"/worklog/config",
			"/worklog/runs",
			"/sessions/native/native-approvals",
			"/sessions/native/worklog",
		]) {
			const response = await app.request(`/api/v1${path}`, { headers: jsonHeaders(key) });
			expect(response.status).toBe(403);
		}
		const response = await app.request("/api/v1/worklog/runs", {
			method: "POST",
			headers: jsonHeaders(key),
			body: JSON.stringify({ date: "2026-01-01" }),
		});
		expect(response.status).toBe(403);
	}
});
test("manage callers can select a session's log scope; general settings don't expose log bodies", async () => {
	const { key } = await createApiKey("worklog-manage", ["manage"]);
	await getDb().insert(sessions).values({ sessionId: "scope-session", agentType: "codex_cli" });
	const response = await app.request("/api/v1/sessions/scope-session/worklog", {
		method: "PUT",
		headers: jsonHeaders(key),
		body: JSON.stringify({ included: false }),
	});
	expect(response.status).toBe(200);
	const read = await app.request("/api/v1/sessions/scope-session/worklog", {
		headers: jsonHeaders(key),
	});
	expect(await read.json()).toEqual({ included: false });
	await upsertSetting(
		"worklog.run.Asia/Shanghai.2026-01-01",
		{ markdown: "PRIVATE_LOG" },
		{ allowProtected: true },
	);
	const all = await app.request("/api/v1/settings", { headers: jsonHeaders(key) });
	expect(await all.text()).not.toContain("PRIVATE_LOG");
});
test("a team member's manage key cannot aggregate instance-wide logs", async () => {
	await upsertSetting("instance.mode", "team", { allowProtected: true });
	const { key } = await createApiKey("unowned-member", ["manage"]);
	for (const path of ["/worklog/config", "/worklog/runs"]) {
		const response = await app.request(`/api/v1${path}`, { headers: jsonHeaders(key) });
		expect(response.status).toBe(403);
	}
});
