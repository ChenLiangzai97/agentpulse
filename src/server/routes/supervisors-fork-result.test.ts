/**
 * Fork RESULT reporting (isolation slice): the authenticated endpoint only
 * accepts a complete report for a known action that carries a pinned parent
 * snapshot. Entry points remain closed; these guards are what the future
 * supervisor caller relies on.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import "../db/__test_db.js";
import { deleteAllSupervisors } from "../services/__test_supervisors.js";

const { config } = await import("../config.js");
const { initializeDatabase, getDb } = await import("../db/client.js");
const { controlActions } = await import("../db/schema/index.js");
const { Hono } = await import("hono");
const { supervisorsAgentRouter } = await import("./supervisors.js");

const app = new Hono().route("/api/v1", supervisorsAgentRouter);
const originalDisableAuth = config.disableAuth;

beforeAll(async () => {
	await initializeDatabase();
	(config as Record<string, unknown>).disableAuth = true;
});

afterAll(async () => {
	await deleteAllSupervisors();
	(config as Record<string, unknown>).disableAuth = originalDisableAuth;
});

const post = (actionId: string, body: unknown) =>
	app.request(`/api/v1/supervisors/sup-1/control-actions/${actionId}/fork-result`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});

describe("POST /supervisors/:id/control-actions/:actionId/fork-result", () => {
	test("refuses an incomplete report", async () => {
		const res = await post("missing-action", { claimToken: "t" });
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "fork_result_incomplete" });
	});

	test("refuses an unknown action", async () => {
		const res = await post("missing-action", {
			claimToken: "t",
			childNativeSessionId: "ses_x",
		});
		expect(res.status).toBe(404);
	});

	test("refuses a report without the pinned parent snapshot", async () => {
		const actionId = crypto.randomUUID();
		await getDb()
			.insert(controlActions)
			.values({
				id: actionId,
				sessionId: null,
				actionType: "opencode_fork",
				status: "running",
				metadata: { claimToken: "t" },
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			});
		const res = await post(actionId, { claimToken: "t", childNativeSessionId: "ses_x" });
		expect(res.status).toBe(409);
		expect(await res.json()).toEqual({ error: "fork_snapshot_missing" });
	});
});

test("the pinned snapshot cannot come from the action metadata mirror", async () => {
	const actionId = crypto.randomUUID();
	await getDb()
		.insert(controlActions)
		.values({
			id: actionId,
			sessionId: null,
			actionType: "opencode_fork",
			status: "running",
			metadata: { claimToken: "t", parentSnapshot: { version: 1 } },
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		});
	const res = await post(actionId, { claimToken: "t", childNativeSessionId: "ses_x" });
	expect(res.status).toBe(409);
});

test("a non-fork action cannot be finalized as a fork", async () => {
	const actionId = crypto.randomUUID();
	await getDb()
		.insert(controlActions)
		.values({
			id: actionId,
			sessionId: null,
			actionType: "stop",
			status: "running",
			metadata: { claimToken: "t" },
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		});
	const res = await post(actionId, {
		claimToken: "t",
		childNativeSessionId: "ses_x",
		parentSnapshot: {
			version: 1,
			instanceId: "i",
			nativeSessionId: "ses_y",
			messages: [],
			forkPointMessageId: null,
		},
	});
	expect(res.status).toBe(403);
	expect(await res.json()).toEqual({ error: "provider_binding_invalid" });
});
