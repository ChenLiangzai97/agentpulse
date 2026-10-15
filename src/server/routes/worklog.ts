import { Hono } from "hono";
import { requireAuth } from "../auth/middleware.js";
import { getRequestActor, requireOperatorScope } from "../auth/route-scope-policy.js";
import { NotOwnerError, assertCanEditSessionNotes } from "../services/authorization.js";
import {
	discardWorklog,
	getWorklogConfig,
	getWorklogIncluded,
	listWorklogs,
	queueWorklog,
	saveWorklogConfig,
	setWorklogIncluded,
	validateDate,
} from "../services/worklog-service.js";

export const worklogRouter = new Hono();
worklogRouter.use("*", requireAuth(), requireOperatorScope());
// An instance-wide personal log. In team deployments only admins may aggregate/export it.
worklogRouter.use("/worklog/*", async (c, next) => {
	const actor = await getRequestActor(c);
	if (actor.mode === "team" && actor.role !== "admin")
		return c.json({ error: "admin_required" }, 403);
	await next();
});
worklogRouter.get("/worklog/config", async (c) => c.json({ config: await getWorklogConfig() }));
worklogRouter.put("/worklog/config", async (c) => {
	try {
		return c.json({ config: await saveWorklogConfig(await c.req.json()) });
	} catch (error) {
		return c.json({ error: error instanceof Error ? error.message : "Invalid configuration" }, 400);
	}
});
worklogRouter.get("/worklog/runs", async (c) => c.json({ runs: await listWorklogs() }));
worklogRouter.post("/worklog/runs", async (c) => {
	const body = await c.req.json().catch(() => null);
	if (
		!body ||
		typeof body.date !== "string" ||
		(body.deliver !== undefined && typeof body.deliver !== "boolean")
	)
		return c.json({ error: "Invalid request" }, 400);
	try {
		validateDate(body.date);
	} catch {
		return c.json({ error: "Invalid date" }, 400);
	}
	// Durable status is polled by the UI; don't keep an HTTP request open through model calls.
	try {
		return c.json(await queueWorklog(body.date, body.deliver === true), 202);
	} catch (error) {
		return c.json({ error: error instanceof Error ? error.message : "Unable to queue" }, 409);
	}
});
worklogRouter.delete("/worklog/runs/:date", async (c) => {
	try {
		await discardWorklog(c.req.param("date"));
		return c.json({ ok: true });
	} catch (error) {
		return c.json({ error: error instanceof Error ? error.message : "Delete failed" }, 409);
	}
});
worklogRouter.get("/sessions/:sessionId/worklog", async (c) =>
	c.json({ included: await getWorklogIncluded(c.req.param("sessionId")) }),
);
worklogRouter.put("/sessions/:sessionId/worklog", async (c) => {
	const body = await c.req.json().catch(() => null);
	if (!body || typeof body.included !== "boolean")
		return c.json({ error: "included must be boolean" }, 400);
	try {
		await assertCanEditSessionNotes(await getRequestActor(c), c.req.param("sessionId"));
		await setWorklogIncluded(c.req.param("sessionId"), body.included);
		return c.json({ included: body.included });
	} catch (error) {
		return c.json(
			{ error: error instanceof Error ? error.message : "Update failed" },
			error instanceof NotOwnerError ? 403 : 400,
		);
	}
});
