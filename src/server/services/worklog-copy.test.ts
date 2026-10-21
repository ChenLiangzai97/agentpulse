/**
 * copyOf integration: a fork child's copied events map back to the parent's
 * ORIGINAL event. Facts carry `copyOf` + the parent's occurrence time, and the
 * work-log dedupe keeps the parent's facts only (no double counting).
 */
import "../db/__test_db.js";
import { beforeAll, beforeEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { getDb, initializeDatabase } from "../db/client.js";
import {
	events,
	opencodeForkRequests,
	opencodeForks,
	sessions,
} from "../db/schema/index.js";
import { dedupeFacts, parseFacts } from "./worklog-facts.js";
import { loadCopiedEvents } from "./worklog-copy.js";

beforeAll(() => initializeDatabase());
beforeEach(async () => {
	for (const table of [events, opencodeForkRequests, opencodeForks, sessions]) await getDb().delete(table);
});

async function seed() {
	await getDb().insert(sessions).values([
		{ sessionId: "parent-1", agentType: "opencode", cwd: "/tmp" },
		{ sessionId: "child-1", agentType: "opencode", cwd: "/tmp" },
	]);
	// Parent message msg_p1 has two parts (user text + assistant text).
	const parentRows = await getDb()
		.insert(events)
		.values([
			{
				sessionId: "parent-1",
				eventType: "UserPromptSubmit",
				category: "prompt",
				content: "first task",
				createdAt: "2026-01-01 10:00:00",
				rawPayload: { message_id: "msg_p1" },
			},
			{
				sessionId: "parent-1",
				eventType: "AssistantMessage",
				category: "assistant_message",
				content: "done first",
				createdAt: "2026-01-01 10:01:00",
				rawPayload: { message_id: "msg_p1" },
			},
		])
		.returning({ id: events.id });
	// The child carries the SAME two events (remapped ids, later ingest time).
	const childRows = await getDb()
		.insert(events)
		.values([
			{
				sessionId: "child-1",
				eventType: "UserPromptSubmit",
				category: "prompt",
				content: "first task",
				createdAt: "2026-01-02 09:00:00",
				rawPayload: { message_id: "msg_c1" },
			},
			{
				sessionId: "child-1",
				eventType: "AssistantMessage",
				category: "assistant_message",
				content: "done first",
				createdAt: "2026-01-02 09:01:00",
				rawPayload: { message_id: "msg_c1" },
			},
		])
		.returning({ id: events.id });
	await getDb().insert(opencodeForks).values({
		childSessionId: "child-1",
		parentSessionId: "parent-1",
		requestActionId: "action-1",
	});
	await getDb().insert(opencodeForkRequests).values({
		actionId: "action-1",
		requestHash: "h",
		identity: null,
		childMap: {
			version: 1,
			forkPointMessageId: "msg_p2",
			pairs: [
				{
					parentNativeId: "msg_p1",
					childNativeId: "msg_c1",
					parentOccurredAt: "2026-01-01T10:00:00.000Z",
				},
			],
		},
	});
	return { parentRows, childRows };
}

test("copied child events point at the parent's original events", async () => {
	const { parentRows, childRows } = await seed();
	const copies = await loadCopiedEvents("child-1");
	expect(copies.size).toBe(2);
	expect(copies.get(childRows[0]?.id as number)?.copyOf).toBe(`parent-1:${parentRows[0]?.id}`);
	expect(copies.get(childRows[1]?.id as number)?.occurredAt).toBe("2026-01-01 10:01:00");
});

test("facts from copies carry copyOf + the parent's time and dedupe away", async () => {
	const { parentRows, childRows } = await seed();
	const copies = await loadCopiedEvents("child-1");
	// The fact parser only admits events present in the processed chunk.
	const childEventRows = await getDb()
		.select()
		.from(events)
		.where(eq(events.sessionId, "child-1"));
	const childEvents = new Map(
		childEventRows.map((row) => [
			row.id,
			{
				id: row.id,
				category: row.category ?? "assistant_message",
				createdAt: row.createdAt,
				content: row.content,
				eventType: row.eventType,
			},
		]),
	);
	const parentCopies = new Map();
	const parentEventRows = await getDb()
		.select()
		.from(events)
		.where(eq(events.sessionId, "parent-1"));
	const parentEvents = new Map(
		parentEventRows.map((row) => [
			row.id,
			{
				id: row.id,
				category: row.category ?? "agent_claim",
				createdAt: row.createdAt,
				content: row.content,
				eventType: row.eventType,
			},
		]),
	);
	const childFacts = parseFacts(
		JSON.stringify({
			facts: [
				{ category: "agent_claim", text: "done first", evidenceEventId: childRows[1]?.id },
			],
		}),
		{ sessionId: "child-1", host: null, sessionName: "child", events: childEvents, copies },
	).facts;
	expect(childFacts[0]?.copyOf).toBe(`parent-1:${parentRows[1]?.id}`);
	expect(childFacts[0]?.occurredAt).toBe("2026-01-01 10:01:00");

	const parentFacts = parseFacts(
		JSON.stringify({
			facts: [
				{ category: "agent_claim", text: "done first", evidenceEventId: parentRows[1]?.id },
			],
		}),
		{ sessionId: "parent-1", host: null, sessionName: "parent", events: parentEvents, copies: parentCopies },
	).facts;
	const deduped = dedupeFacts([...childFacts, ...parentFacts]);
	expect(deduped.map((fact) => fact.sessionId)).toEqual(["parent-1"]);
});
