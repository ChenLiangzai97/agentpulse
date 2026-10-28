import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import "../db/__test_db.js";
import { app } from "../app.js";
import { createApiKey } from "../auth/api-key.js";
import { config } from "../config.js";
import { getDb, initializeDatabase } from "../db/client.js";
import { apiKeys, events, sessions, settings } from "../db/schema/index.js";
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

test("run detail exposes dual views and adopt switches the export version", async () => {
	const { key } = await createApiKey("worklog-detail", ["manage"]);
	// Inject a completed run the way the service persists it.
	const versionPersonal = {
		versionId: "v1-personal-test",
		kind: "personal" as const,
		markdown: "# 个人回顾\n- 目标：完成 X（事件 #1）",
		createdAt: "2026-01-02T00:05:00.000Z",
		generator: { model: "m", source: "facts" as const },
	};
	const versionTeam = {
		versionId: "v2-team-test",
		kind: "team" as const,
		markdown: "## 成果\n- 完成 X",
		createdAt: "2026-01-02T00:05:01.000Z",
		generator: { model: "m", source: "facts" as const },
	};
	await upsertSetting(
		"worklog.config",
		{
			enabled: false,
			timezone: "Asia/Shanghai",
			time: "00:05",
			providerId: "p",
			model: "m",
			documentUrl: "",
			documentId: "",
		},
		{ allowProtected: true },
	);
	await upsertSetting(
		"worklog.run.Asia/Shanghai.2026-01-01",
		{
			date: "2026-01-01",
			timezone: "Asia/Shanghai",
			status: "ready",
			markdown: versionTeam.markdown,
			sessionIds: ["s1"],
			error: null,
			updatedAt: "2026-01-02T00:05:02.000Z",
			facts: [
				{
					id: "f1",
					sessionId: "s1",
					host: null,
					occurredAt: "2026-01-01T01:00:00.000Z",
					category: "user_goal",
					text: "完成 X",
					evidenceEventId: 1,
					projectHint: null,
					confidence: "stated",
					contentKey: "k1",
				},
			],
			factMeta: { model: "m", extractedAt: "2026-01-02T00:05:00.000Z", rejected: 0, deduped: 0 },
			versions: [versionPersonal, versionTeam],
			adoptedVersionId: versionTeam.versionId,
		},
		{ allowProtected: true },
	);
	const detail = await app.request("/api/v1/worklog/runs/2026-01-01", {
		headers: jsonHeaders(key),
	});
	expect(detail.status).toBe(200);
	const body = (await detail.json()) as {
		run: { versions: unknown[]; facts: unknown[]; adoptedVersionId: string };
	};
	expect(body.run.versions).toHaveLength(2);
	expect(body.run.facts).toHaveLength(1);
	expect(body.run.adoptedVersionId).toBe("v2-team-test");
	const adopt = await app.request("/api/v1/worklog/runs/2026-01-01/adopt", {
		method: "POST",
		headers: jsonHeaders(key),
		body: JSON.stringify({ versionId: "v1-personal-test" }),
	});
	expect(adopt.status).toBe(200);
	const adopted = (await adopt.json()) as { run: { markdown: string; adoptedVersionId: string } };
	expect(adopted.run.adoptedVersionId).toBe("v1-personal-test");
	expect(adopted.run.markdown).toContain("# 个人回顾");
	const badAdopt = await app.request("/api/v1/worklog/runs/2026-01-01/adopt", {
		method: "POST",
		headers: jsonHeaders(key),
		body: JSON.stringify({ versionId: "v9-missing" }),
	});
	expect(badAdopt.status).toBe(404);
	const missing = await app.request("/api/v1/worklog/runs/2026-01-05", {
		headers: jsonHeaders(key),
	});
	expect(missing.status).toBe(404);
});

test("scope preview and manual edit work over real HTTP", async () => {
	const { key } = await createApiKey("worklog-preview-edit", ["manage"]);
	await getDb()
		.insert(sessions)
		.values({ sessionId: "pv-1", agentType: "codex_cli", displayName: "预览会话" });
	await getDb().insert(events).values({
		sessionId: "pv-1",
		eventType: "UserPromptSubmit",
		category: "prompt",
		content: "预览内容",
		createdAt: "2026-01-02 05:00:00",
		rawPayload: {},
	});
	await upsertSetting(
		"worklog.config",
		{
			enabled: false,
			timezone: "Asia/Shanghai",
			time: "00:05",
			providerId: "p",
			model: "m",
			documentUrl: "",
			documentId: "",
		},
		{ allowProtected: true },
	);
	const preview = await app.request("/api/v1/worklog/preview/2026-01-02", {
		headers: jsonHeaders(key),
	});
	expect(preview.status).toBe(200);
	const previewBody = (await preview.json()) as {
		sessions: Array<{ sessionId: string; included: boolean; counts: { prompt: number } }>;
	};
	expect(previewBody.sessions).toHaveLength(1);
	expect(previewBody.sessions[0].sessionId).toBe("pv-1");
	expect(previewBody.sessions[0].included).toBe(true);
	expect(previewBody.sessions[0].counts.prompt).toBe(1);
	// Manual edit: seed a run with one version, then edit it over HTTP.
	const base = {
		versionId: "v1-base",
		kind: "personal" as const,
		markdown: "# original",
		createdAt: "2026-01-02T00:05:00.000Z",
		generator: { model: "m", source: "facts" as const },
	};
	await upsertSetting(
		"worklog.run.Asia/Shanghai.2026-01-02",
		{
			date: "2026-01-02",
			timezone: "Asia/Shanghai",
			status: "ready",
			markdown: "# original",
			sessionIds: ["pv-1"],
			error: null,
			updatedAt: "2026-01-02T00:05:01.000Z",
			versions: [base],
			adoptedVersionId: base.versionId,
		},
		{ allowProtected: true },
	);
	const edit = await app.request("/api/v1/worklog/runs/2026-01-02/edit", {
		method: "POST",
		headers: jsonHeaders(key),
		body: JSON.stringify({ baseVersionId: "v1-base", markdown: "# 人工修订" }),
	});
	expect(edit.status).toBe(200);
	const edited = (await edit.json()) as {
		run: {
			markdown: string;
			adoptedVersionId: string;
			versions: Array<{ generator: { source: string } }>;
		};
	};
	expect(edited.run.markdown).toBe("# 人工修订");
	expect(edited.run.versions.at(-1)?.generator.source).toBe("manual");
	const badEdit = await app.request("/api/v1/worklog/runs/2026-01-02/edit", {
		method: "POST",
		headers: jsonHeaders(key),
		body: JSON.stringify({ baseVersionId: "v1-base", markdown: "" }),
	});
	expect(badEdit.status).toBe(400);
});
