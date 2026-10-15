import { beforeAll, beforeEach, expect, test } from "bun:test";
import "../db/__test_db.js";
import { eq } from "drizzle-orm";
import { getDb, initializeDatabase } from "../db/client.js";
import {
	events,
	controlActions,
	launchRequests,
	managedSessions,
	sessions,
	supervisors,
} from "../db/schema/index.js";
import { claimNextControlAction } from "./control-actions.js";
import {
	appendManagedSessionEvents,
	listManagedSessionsNeedingSync,
} from "./managed-session-state.js";
import { bindSession, queueResume } from "./session-binding.js";
const actor = { label: "user", userId: null, mode: "solo" } as const;
beforeAll(() => initializeDatabase());
beforeEach(async () => {
	for (const table of [
		events,
		controlActions,
		managedSessions,
		launchRequests,
		sessions,
		supervisors,
	])
		await getDb().delete(table);
	for (const id of ["host-a", "host-b"])
		await getDb()
			.insert(supervisors)
			.values({
				id,
				hostName: id,
				platform: "linux",
				arch: "x64",
				version: "1",
				status: "connected",
				trustedRoots: ["/tmp"],
				capabilities: {},
			});
	await getDb()
		.insert(sessions)
		.values({ sessionId: "native-id", agentType: "codex_cli", cwd: "/tmp/work" });
});
test("binds existing history and routes resume only to the bound host", async () => {
	await bindSession("native-id", "host-a", actor);
	await bindSession("native-id", "host-a", actor);
	const action = await queueResume("native-id", actor);
	expect(action.actionType).toBe("resume");
	expect(await claimNextControlAction("host-b")).toBeNull();
	expect((await claimNextControlAction("host-a"))?.sessionId).toBe("native-id");
	await expect(bindSession("native-id", "host-b", actor)).rejects.toThrow("another host");
	const rows = await getDb().select().from(launchRequests);
	expect(rows).toHaveLength(1);
	expect(rows[0].launchCorrelationId).toBe("native-id");
});
test("offline replays use durable identity, preserve occurrence time, and keep identical distinct messages", async () => {
	await bindSession("native-id", "host-a", actor);
	const event = {
		eventType: "ManagedAgentMessage",
		category: "assistant_message",
		content: "same text",
		deliveryId: "delivery-1",
		occurredAt: "2026-01-01T05:00:00Z",
	} as const;
	expect(await appendManagedSessionEvents("host-a", "native-id", [event])).toHaveLength(1);
	expect(await appendManagedSessionEvents("host-a", "native-id", [event])).toHaveLength(0);
	expect(
		await appendManagedSessionEvents("host-a", "native-id", [
			{ ...event, deliveryId: "delivery-2" },
		]),
	).toHaveLength(1);
	const rows = await getDb().select().from(events).where(eq(events.sessionId, "native-id"));
	expect(rows).toHaveLength(2);
	expect(rows[0].createdAt).toBe("2026-01-01 05:00:00");
	await expect(appendManagedSessionEvents("host-b", "native-id", [event])).rejects.toThrow();
});

test("recovery polling includes title-synced bindings, scoped to the owner host", async () => {
	await bindSession("native-id", "host-a", actor);
	await getDb()
		.update(managedSessions)
		.set({ desiredThreadTitle: "name", providerThreadTitle: "name" })
		.where(eq(managedSessions.sessionId, "native-id"));
	expect(await listManagedSessionsNeedingSync("host-a")).toHaveLength(0);
	expect(await listManagedSessionsNeedingSync("host-a", true)).toHaveLength(1);
	expect(await listManagedSessionsNeedingSync("host-b", true)).toHaveLength(0);
});
