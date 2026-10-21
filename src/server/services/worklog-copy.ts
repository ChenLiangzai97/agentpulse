/**
 * copyOf provenance for fork children (P4 x fork A6).
 *
 * The native fork REMAPS message ids and is exclusive at the fork point, so a
 * child's history is a PREFIX of the parent's. The supervisor records the
 * execution-time map (parent message id -> child message id, plus the parent's
 * original occurrence time) in opencode_fork_requests.child_map.
 *
 * Here we turn that into event-level provenance: for each event COPIED into
 * the child, the id of the parent event it duplicates. Facts derived from a
 * copy then carry `copyOf` and inherit the parent's occurrence time, so the
 * work-log dedupe drops the duplicate instead of double-counting it.
 */
import { eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { events, opencodeForkRequests, opencodeForks } from "../db/schema/index.js";

export interface ChildMapPair {
	parentNativeId: string;
	childNativeId: string;
	parentOccurredAt: string;
}

interface CopyEventRow {
	id: number;
	eventType: string;
	content: string | null;
	createdAt: string;
	messageId: string | null;
}

const messageIdOf = (raw: unknown): string | null => {
	const value = (raw as { message_id?: unknown } | null)?.message_id;
	return typeof value === "string" ? value : null;
};

const keyOf = (event: CopyEventRow) => `${event.eventType}:${event.content ?? ""}`;

/**
 * Resolves the copy provenance for a session created by a fork. Returns an
 * empty map when the session is not a fork child, when the ledger has no map,
 * or when the recorded map is malformed (never a guess).
 */
export async function loadCopiedEvents(sessionId: string): Promise<
	Map<number, { copyOf: string; occurredAt: string }>
> {
	const copies = new Map<number, { copyOf: string; occurredAt: string }>();
	const [fork] = await getDb()
		.select({
			parentSessionId: opencodeForks.parentSessionId,
			requestActionId: opencodeForks.requestActionId,
		})
		.from(opencodeForks)
		.where(eq(opencodeForks.childSessionId, sessionId))
		.limit(1);
	if (!fork || !fork.requestActionId || !fork.parentSessionId) return copies;
	const parentSessionId = fork.parentSessionId;
	const [ledger] = await getDb()
		.select({ childMap: opencodeForkRequests.childMap })
		.from(opencodeForkRequests)
		.where(eq(opencodeForkRequests.actionId, fork.requestActionId))
		.limit(1);
	const pairs = (ledger?.childMap as { pairs?: ChildMapPair[] } | null)?.pairs;
	if (!Array.isArray(pairs) || pairs.length === 0) return copies;

	const childRows = await getDb()
		.select({
			id: events.id,
			eventType: events.eventType,
			content: events.content,
			createdAt: events.createdAt,
			rawPayload: events.rawPayload,
		})
		.from(events)
		.where(eq(events.sessionId, sessionId));
	const parentRows = await getDb()
		.select({
			id: events.id,
			eventType: events.eventType,
			content: events.content,
			createdAt: events.createdAt,
			rawPayload: events.rawPayload,
		})
		.from(events)
		.where(eq(events.sessionId, parentSessionId));

	const toRows = (rows: (typeof childRows)[number][]): Map<string, CopyEventRow[]> => {
		const byMessage = new Map<string, CopyEventRow[]>();
		for (const row of rows) {
			const messageId = messageIdOf(row.rawPayload);
			if (!messageId) continue;
			const list = byMessage.get(messageId) ?? [];
			list.push({
				id: row.id,
				eventType: row.eventType,
				content: row.content,
				createdAt: row.createdAt,
				messageId,
			});
			byMessage.set(messageId, list);
		}
		for (const list of byMessage.values()) list.sort((a, b) => a.id - b.id);
		return byMessage;
	};
	const childByMessage = toRows(childRows);
	const parentByMessage = toRows(parentRows);

	for (const pair of pairs) {
		const parentEvents = parentByMessage.get(pair.parentNativeId);
		const childEvents = childByMessage.get(pair.childNativeId);
		// The child may have FEWER events (aborted parts); pair in order by a
		// stable key and stop at the first divergence — never guess a pairing.
		const limit = Math.min(parentEvents?.length ?? 0, childEvents?.length ?? 0);
		for (let index = 0; index < limit; index++) {
			const parentEvent = parentEvents?.[index];
			const childEvent = childEvents?.[index];
			if (!parentEvent || !childEvent) break;
			if (keyOf(parentEvent) !== keyOf(childEvent)) break;
			copies.set(childEvent.id, {
				// Dedupe anchors are "sessionId:eventId" of the ORIGINAL event.
				copyOf: `${parentSessionId}:${parentEvent.id}`,
				occurredAt: parentEvent.createdAt,
			});
		}
	}
	return copies;
}
