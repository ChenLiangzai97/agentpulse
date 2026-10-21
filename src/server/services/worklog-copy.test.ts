/**
 * copyOf integration: a fork child's copied events map back to the ORIGINAL
 * event by PART FINGERPRINTS (never ids or ingestion order). Facts carry
 * copyOf + the parent's occurrence time, dedupe keeps the parent only, and
 * multi-generation chains compose to the top-most resolvable anchor.
 */
import "../db/__test_db.js";
import { beforeAll, beforeEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { partFingerprint } from "../../shared/opencode-copy.js";
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

const part = (text: string, role: "user" | "assistant") => ({
	type: "text",
	text,
	time: { start: 1000, end: 2000 },
	role,
});

async function seedEvent(
	sessionId: string,
	eventType: string,
	category: string,
	content: string,
	messageId: string,
	occurredAt: string,
) {
	const [row] = await getDb()
		.insert(events)
		.values({
			sessionId,
			eventType,
			category,
			content,
			createdAt: occurredAt,
			rawPayload: {
				message_id: messageId,
				source_data: { type: "text", text: content, time: { start: 1000, end: 2000 } },
			},
		})
		.returning({ id: events.id });
	return row.id;
}

async function seedFork(opts: {
	child: string;
	parent: string;
	actionId: string;
	parentMessage: string;
	childMessage: string;
	occurredAt: string;
	parts: { fingerprint: string; parentOccurredAt: string }[];
}) {
	await getDb().insert(opencodeForks).values({
		childSessionId: opts.child,
		parentSessionId: opts.parent,
		requestActionId: opts.actionId,
	});
	await getDb()
		.insert(opencodeForkRequests)
		.values({
			actionId: opts.actionId,
			requestHash: "h",
			identity: null,
			childMap: {
				version: 1,
				forkPointMessageId: null,
				pairs: [
					{
						parentNativeId: opts.parentMessage,
						childNativeId: opts.childMessage,
						parentOccurredAt: opts.occurredAt,
						parts: opts.parts,
					},
				],
			},
		});
}

test("copied child events point at the parent's original events by fingerprint", async () => {
	await getDb().insert(sessions).values([
		{ sessionId: "parent-1", agentType: "opencode", cwd: "/tmp" },
		{ sessionId: "child-1", agentType: "opencode", cwd: "/tmp" },
	]);
	const parentEvent = await seedEvent(
		"parent-1",
		"AssistantMessage",
		"assistant_message",
		"done first",
		"msg_p1",
		"2026-01-01 10:01:00",
	);
	const childEvent = await seedEvent(
		"child-1",
		"AssistantMessage",
		"assistant_message",
		"done first",
		"msg_c1",
		"2026-01-02 09:01:00",
	);
	await seedFork({
		child: "child-1",
		parent: "parent-1",
		actionId: "action-1",
		parentMessage: "msg_p1",
		childMessage: "msg_c1",
		occurredAt: "2026-01-01T10:01:00.000Z",
		parts: [
			{
				fingerprint: partFingerprint(part("done first", "assistant")),
				parentOccurredAt: "2026-01-01 10:01:00",
			},
		],
	});
	const copies = await loadCopiedEvents("child-1");
	expect(copies.size).toBe(1);
	expect(copies.get(childEvent)?.copyOf).toBe(`parent-1:${parentEvent}`);
	expect(copies.get(childEvent)?.occurredAt).toBe("2026-01-01 10:01:00");
});

test("facts from copies carry copyOf + the parent's time and dedupe away", async () => {
	await getDb().insert(sessions).values([
		{ sessionId: "parent-1", agentType: "opencode", cwd: "/tmp" },
		{ sessionId: "child-1", agentType: "opencode", cwd: "/tmp" },
	]);
	const parentEvent = await seedEvent(
		"parent-1",
		"AssistantMessage",
		"assistant_message",
		"done first",
		"msg_p1",
		"2026-01-01 10:01:00",
	);
	const childEvent = await seedEvent(
		"child-1",
		"AssistantMessage",
		"assistant_message",
		"done first",
		"msg_c1",
		"2026-01-02 09:01:00",
	);
	await seedFork({
		child: "child-1",
		parent: "parent-1",
		actionId: "action-1",
		parentMessage: "msg_p1",
		childMessage: "msg_c1",
		occurredAt: "2026-01-01T10:01:00.000Z",
		parts: [
			{
				fingerprint: partFingerprint(part("done first", "assistant")),
				parentOccurredAt: "2026-01-01 10:01:00",
			},
		],
	});
	const copies = await loadCopiedEvents("child-1");
	const chunkEvents = new Map(
		(await getDb().select().from(events).where(eq(events.sessionId, "child-1"))).map((row) => [
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
		JSON.stringify({ facts: [{ category: "agent_claim", text: "done first", evidenceEventId: childEvent }] }),
		{ sessionId: "child-1", host: null, sessionName: "child", events: chunkEvents, copies },
	).facts;
	expect(childFacts[0]?.copyOf).toBe(`parent-1:${parentEvent}`);
	expect(childFacts[0]?.occurredAt).toBe("2026-01-01 10:01:00");

	const parentChunk = new Map(
		(await getDb().select().from(events).where(eq(events.sessionId, "parent-1"))).map((row) => [
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
	const parentFacts = parseFacts(
		JSON.stringify({ facts: [{ category: "agent_claim", text: "done first", evidenceEventId: parentEvent }] }),
		{ sessionId: "parent-1", host: null, sessionName: "parent", events: parentChunk },
	).facts;
	expect(dedupeFacts([...childFacts, ...parentFacts]).map((fact) => fact.sessionId)).toEqual([
		"parent-1",
	]);
});

test("a re-forked child composes to the top-most anchor", async () => {
	await getDb().insert(sessions).values([
		{ sessionId: "root", agentType: "opencode", cwd: "/tmp" },
		{ sessionId: "mid", agentType: "opencode", cwd: "/tmp" },
		{ sessionId: "leaf", agentType: "opencode", cwd: "/tmp" },
	]);
	const rootEvent = await seedEvent(
		"root",
		"AssistantMessage",
		"assistant_message",
		"shared",
		"msg_r",
		"2026-01-01 08:00:00",
	);
	const midEvent = await seedEvent(
		"mid",
		"AssistantMessage",
		"assistant_message",
		"shared",
		"msg_m",
		"2026-01-01 09:00:00",
	);
	const leafEvent = await seedEvent(
		"leaf",
		"AssistantMessage",
		"assistant_message",
		"shared",
		"msg_l",
		"2026-01-01 10:00:00",
	);
	const fingerprint = partFingerprint(part("shared", "assistant"));
	await seedFork({
		child: "mid",
		parent: "root",
		actionId: "a-mid",
		parentMessage: "msg_r",
		childMessage: "msg_m",
		occurredAt: "2026-01-01T08:00:00.000Z",
		parts: [{ fingerprint, parentOccurredAt: "2026-01-01 08:00:00" }],
	});
	await seedFork({
		child: "leaf",
		parent: "mid",
		actionId: "a-leaf",
		parentMessage: "msg_m",
		childMessage: "msg_l",
		occurredAt: "2026-01-01T09:00:00.000Z",
		parts: [{ fingerprint, parentOccurredAt: "2026-01-01 09:00:00" }],
	});
	const copies = await loadCopiedEvents("leaf");
	expect(copies.get(leafEvent)?.copyOf).toBe(`root:${rootEvent}`);
	expect(copies.get(leafEvent)?.occurredAt).toBe("2026-01-01 08:00:00");
	void midEvent;
});

test("a deleted parent leaves the copy UNRESOLVED (fact kept, no dangling anchor)", async () => {
	await getDb().insert(sessions).values([
		{ sessionId: "parent-1", agentType: "opencode", cwd: "/tmp" },
		{ sessionId: "child-1", agentType: "opencode", cwd: "/tmp" },
	]);
	await seedEvent("parent-1", "AssistantMessage", "assistant_message", "gone soon", "msg_p1", "2026-01-01 10:00:00");
	await seedEvent("child-1", "AssistantMessage", "assistant_message", "gone soon", "msg_c1", "2026-01-02 10:00:00");
	await seedFork({
		child: "child-1",
		parent: "parent-1",
		actionId: "action-1",
		parentMessage: "msg_p1",
		childMessage: "msg_c1",
		occurredAt: "2026-01-01T10:00:00.000Z",
		parts: [
			{
				fingerprint: partFingerprint(part("gone soon", "assistant")),
				parentOccurredAt: "2026-01-01 10:00:00",
			},
		],
	});
	// Cascade like the real schema: deleting the session removes its events.
	await getDb().delete(events).where(eq(events.sessionId, "parent-1"));
	await getDb().update(opencodeForks).set({ parentSessionId: null }).where(eq(opencodeForks.childSessionId, "child-1"));
	const copies = await loadCopiedEvents("child-1");
	expect(copies.size).toBe(0);
});

test("duplicate fingerprints are ambiguous: no copy is claimed", async () => {
	await getDb().insert(sessions).values([
		{ sessionId: "parent-1", agentType: "opencode", cwd: "/tmp" },
		{ sessionId: "child-1", agentType: "opencode", cwd: "/tmp" },
	]);
	await seedEvent("parent-1", "AssistantMessage", "assistant_message", "same", "msg_p1", "2026-01-01 10:00:00");
	await seedEvent("parent-1", "AssistantMessage", "assistant_message", "same", "msg_p1", "2026-01-01 10:00:01");
	await seedEvent("child-1", "AssistantMessage", "assistant_message", "same", "msg_c1", "2026-01-02 10:00:00");
	await seedFork({
		child: "child-1",
		parent: "parent-1",
		actionId: "action-1",
		parentMessage: "msg_p1",
		childMessage: "msg_c1",
		occurredAt: "2026-01-01T10:00:00.000Z",
		parts: [
			{
				fingerprint: partFingerprint(part("same", "assistant")),
				parentOccurredAt: "2026-01-01 10:00:00",
			},
		],
	});
	expect((await loadCopiedEvents("child-1")).size).toBe(0);
});
