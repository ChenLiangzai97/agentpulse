/**
 * copyOf provenance for fork children (P4 x fork A6).
 *
 * The native fork REMAPS ids and is exclusive at the fork point, so a child's
 * history is a PREFIX of the parent's. The supervisor records the execution-time
 * map in opencode_fork_requests.child_map: parent message -> child message,
 * plus per-part FINGERPRINTS (type/text/tool/call id/state/times — never ids).
 *
 * This module resolves child event -> the ORIGINAL event it duplicates:
 *  - pairing is by fingerprint only; any missing/duplicate fingerprint stops
 *    that message pair (never inferred from ingestion order);
 *  - chains are composed to the top-most resolvable ancestor (a re-forked
 *    child points at the original anchor), bounded and cycle-guarded;
 *  - when the ancestor is gone (parent deleted) the link is UNRESOLVED and no
 *    copyOf is emitted — the fact is kept, never guessed.
 */
import { eq } from "drizzle-orm";
import { partFingerprint } from "../../shared/opencode-copy.js";
import { getDb } from "../db/client.js";
import { events, opencodeForkRequests, opencodeForks } from "../db/schema/index.js";

interface ChildMapPart {
	fingerprint: string;
	parentOccurredAt: string;
}

interface ChildMapPair {
	parentNativeId: string;
	childNativeId: string;
	parentOccurredAt: string;
	parts?: ChildMapPart[];
}

export interface EventCopy {
	/** "sessionId:eventId" of the ORIGINAL event (dedupe anchor). */
	copyOf: string;
	/** The original occurrence time (a copied event keeps it). */
	occurredAt: string;
}

const messageIdOf = (raw: unknown): string | null => {
	const value = (raw as { message_id?: unknown } | null)?.message_id;
	return typeof value === "string" ? value : null;
};

const partOf = (raw: unknown) => (raw as { source_data?: unknown } | null)?.source_data;

interface EventRow {
	id: number;
	eventType: string;
	content: string | null;
	createdAt: string;
	rawPayload: unknown;
}

async function eventsForSession(sessionId: string): Promise<EventRow[]> {
	return (await getDb()
		.select({
			id: events.id,
			eventType: events.eventType,
			content: events.content,
			createdAt: events.createdAt,
			rawPayload: events.rawPayload,
		})
		.from(events)
		.where(eq(events.sessionId, sessionId))) as EventRow[];
}

/** Direct child -> parent event links from the execution-time ledger. */
async function directLinks(sessionId: string): Promise<{
	links: Map<number, EventCopy>;
	parentSessionId: string | null;
	eventIds: Set<number>;
}> {
	const links = new Map<number, EventCopy>();
	const [fork] = await getDb()
		.select({
			parentSessionId: opencodeForks.parentSessionId,
			requestActionId: opencodeForks.requestActionId,
		})
		.from(opencodeForks)
		.where(eq(opencodeForks.childSessionId, sessionId))
		.limit(1);
	if (!fork || !fork.requestActionId || !fork.parentSessionId)
		return { links, parentSessionId: null, eventIds: new Set() };
	const parentSessionId = fork.parentSessionId;
	const [ledger] = await getDb()
		.select({ childMap: opencodeForkRequests.childMap })
		.from(opencodeForkRequests)
		.where(eq(opencodeForkRequests.actionId, fork.requestActionId))
		.limit(1);
	const pairs = (ledger?.childMap as { pairs?: ChildMapPair[] } | null)?.pairs;
	if (!Array.isArray(pairs) || pairs.length === 0)
		return { links, parentSessionId, eventIds: new Set() };

	const [childRows, parentRows] = await Promise.all([
		eventsForSession(sessionId),
		eventsForSession(parentSessionId),
	]);
	const index = (rows: EventRow[]) => {
		// message -> fingerprint -> events (duplicates are AMBIGUOUS, never paired)
		const byMessage = new Map<string, Map<string, EventRow[]>>();
		for (const row of rows) {
			const messageId = messageIdOf(row.rawPayload);
			if (!messageId) continue;
			const fingerprint = partFingerprint(partOf(row.rawPayload));
			const perMessage = byMessage.get(messageId) ?? new Map<string, EventRow[]>();
			const list = perMessage.get(fingerprint) ?? [];
			list.push(row);
			perMessage.set(fingerprint, list);
			byMessage.set(messageId, perMessage);
		}
		return byMessage;
	};
	const childIndex = index(childRows);
	const parentIndex = index(parentRows);
	const parentEventIds = new Set(parentRows.map((row) => row.id));

	for (const pair of pairs) {
		const childParts = childIndex.get(pair.childNativeId);
		const parentPartsIndex = parentIndex.get(pair.parentNativeId);
		if (!childParts || !parentPartsIndex || !Array.isArray(pair.parts)) continue;
		for (const part of pair.parts) {
			const childCandidates = childParts.get(part.fingerprint) ?? [];
			const parentCandidates = parentPartsIndex.get(part.fingerprint) ?? [];
			// Exactly ONE of each, or stop: duplicates mean we cannot prove which
			// event is the copy.
			if (childCandidates.length !== 1 || parentCandidates.length !== 1) continue;
			const childEvent = childCandidates[0];
			const parentEvent = parentCandidates[0];
			if (!childEvent || !parentEvent) continue;
			links.set(childEvent.id, {
				copyOf: `${parentSessionId}:${parentEvent.id}`,
				occurredAt: part.parentOccurredAt || parentEvent.createdAt,
			});
		}
	}
	return { links, parentSessionId, eventIds: parentEventIds };
}

/**
 * Resolves copy provenance for a session, composing multi-generation forks to
 * the top-most anchor that still exists. Bounded depth + cycle guard.
 */
export async function loadCopiedEvents(sessionId: string): Promise<Map<number, EventCopy>> {
	const resolved = new Map<number, EventCopy>();
	const start = await directLinks(sessionId);
	if (start.links.size === 0) return resolved;
	// Ancestor copy maps, keyed by session id (0 = the direct parent).
	const ancestors = new Map<string, Map<number, EventCopy>>();
	const ancestorEventIds = new Map<string, Set<number>>();
	let currentSession = sessionId;
	let currentLinks = start.links;
	let parentSession = start.parentSessionId;
	const visited = new Set<string>([sessionId]);
	for (let depth = 0; depth < 16 && parentSession && !visited.has(parentSession); depth++) {
		visited.add(parentSession);
		const ancestor = await directLinks(parentSession);
		ancestors.set(parentSession, ancestor.links);
		ancestorEventIds.set(parentSession, ancestor.eventIds);
		currentSession = parentSession;
		currentLinks = ancestor.links;
		parentSession = ancestor.parentSessionId;
	}
	void currentSession;
	void currentLinks;

	// Compose: child event -> parent event -> ... until an anchor not itself a copy.
	for (const [childEventId, link] of start.links) {
		const [anchorSessionId, anchorIdText] = link.copyOf.split(":");
		const anchorId = Number(anchorIdText);
		if (!anchorSessionId || !Number.isInteger(anchorId)) continue;
		// A deleted parent cascades its events away: a dangling anchor is NOT a
		// proven copy. Keep the fact without copyOf instead of guessing.
		if (!start.eventIds.has(anchorId)) continue;
		let sessionIdAt = anchorSessionId;
		let eventIdAt = anchorId;
		let occurredAt = link.occurredAt;
		const chain = new Set<string>([`${sessionIdAt}:${eventIdAt}`]);
		let composed = true;
		for (let depth = 0; depth < 16; depth++) {
			const upstream = ancestors.get(sessionIdAt);
			const step = upstream?.get(eventIdAt);
			if (!step) break; // parent event is an original (or gone): stop here
			const [nextSessionId, nextIdText] = step.copyOf.split(":");
			const nextId = Number(nextIdText);
			if (!nextSessionId || !Number.isInteger(nextId)) {
				composed = false;
				break;
			}
			const key = `${nextSessionId}:${nextId}`;
			if (chain.has(key)) {
				composed = false;
				break;
			}
			chain.add(key);
			sessionIdAt = nextSessionId;
			eventIdAt = nextId;
			occurredAt = step.occurredAt;
		}
		if (!composed) continue; // ambiguous chain: keep the fact, no copyOf
		resolved.set(childEventId, {
			copyOf: `${sessionIdAt}:${eventIdAt}`,
			occurredAt,
		});
	}
	return resolved;
}
