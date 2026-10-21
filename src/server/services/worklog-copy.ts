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
	/** Dedupe anchor "sessionId:eventId" — null when the original is GONE. */
	copyOf: string | null;
	/** The ORIGINAL occurrence time: kept even when the anchor is lost. */
	occurredAt: string;
}

/**
 * Anchors are "sessionId:eventId" and session ids MAY contain colons, so the
 * event id is always taken from the LAST separator.
 */
export const copyAnchor = (sessionId: string, eventId: number) => `${sessionId}:${eventId}`;

export function parseCopyAnchor(anchor: string): { sessionId: string; eventId: number } | null {
	const split = anchor.lastIndexOf(":");
	if (split <= 0) return null;
	const eventId = Number(anchor.slice(split + 1));
	const sessionId = anchor.slice(0, split);
	if (!sessionId || !Number.isInteger(eventId)) return null;
	return { sessionId, eventId };
}

/** Canonical DB timestamp: copied times may arrive as ISO; store one format. */
export function canonicalDbTime(value: string): string {
	const text = value.includes("T") ? value : value.replace(" ", "T");
	const date = new Date(text.endsWith("Z") || /[+-]\d\d:?\d\d$/.test(text) ? text : `${text}Z`);
	if (Number.isNaN(date.getTime())) return value;
	return date.toISOString().replace("T", " ").replace("Z", "").slice(0, 19);
}

export function timeMs(value: string): number {
	return new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`).getTime();
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
	if (!fork || !fork.requestActionId) return { links, parentSessionId: null };
	// The ledger is keyed by ACTION, so it survives the parent row's deletion
	// (SET NULL): time ownership must still resolve then; only the anchor needs
	// the parent session.
	const parentSessionId = fork.parentSessionId;
	const [ledger] = await getDb()
		.select({ childMap: opencodeForkRequests.childMap })
		.from(opencodeForkRequests)
		.where(eq(opencodeForkRequests.actionId, fork.requestActionId))
		.limit(1);
	const pairs = (ledger?.childMap as { pairs?: ChildMapPair[] } | null)?.pairs;
	if (!Array.isArray(pairs) || pairs.length === 0) return { links, parentSessionId };

	const [childRows, parentRows] = await Promise.all([
		eventsForSession(sessionId),
		parentSessionId ? eventsForSession(parentSessionId) : Promise.resolve([]),
	]);
	const childByMessage = new Map<string, EventRow[]>();
	for (const row of childRows) {
		const messageId = messageIdOf(row.rawPayload);
		if (!messageId) continue;
		const list = childByMessage.get(messageId) ?? [];
		list.push(row);
		childByMessage.set(messageId, list);
	}
	// parent: message -> fingerprint -> rows (duplicates are ambiguous)
	const parentIndex = new Map<string, Map<string, EventRow[]>>();
	for (const row of parentRows) {
		const messageId = messageIdOf(row.rawPayload);
		if (!messageId) continue;
		const perMessage = parentIndex.get(messageId) ?? new Map<string, EventRow[]>();
		const fingerprint = partFingerprint(partOf(row.rawPayload));
		const list = perMessage.get(fingerprint) ?? [];
		list.push(row);
		perMessage.set(fingerprint, list);
		parentIndex.set(messageId, perMessage);
	}

	for (const pair of pairs) {
		if (!Array.isArray(pair.parts)) continue;
		const childRowsForMessage = childByMessage.get(pair.childNativeId) ?? [];
		for (const part of pair.parts) {
			// Exactly ONE child event for this part, or we cannot prove it.
			const childMatches = childRowsForMessage.filter(
				(row) => partFingerprint(partOf(row.rawPayload)) === part.fingerprint,
			);
			if (childMatches.length !== 1) continue;
			const childEvent = childMatches[0];
			if (!childEvent) continue;
			const parentMatches = parentIndex.get(pair.parentNativeId)?.get(part.fingerprint) ?? [];
			// TIME ownership comes from the persisted ledger and survives the
			// parent's deletion; the DEDUPE anchor needs the original row.
			links.set(childEvent.id, {
				copyOf:
					parentSessionId && parentMatches.length === 1 && parentMatches[0]
						? copyAnchor(parentSessionId, parentMatches[0].id)
						: null,
				occurredAt: canonicalDbTime(part.parentOccurredAt || childEvent.createdAt),
			});
		}
	}
	return { links, parentSessionId };
}

/**
 * Resolves copy provenance for a session: the ORIGINAL occurrence time always
 * (when the ledger proves the part), the dedupe anchor only while the original
 * event still exists. Multi-generation forks compose to the top-most anchor;
 * a deleted ancestor costs the anchor, never the time.
 */
export async function loadCopiedEvents(sessionId: string): Promise<Map<number, EventCopy>> {
	const start = await directLinks(sessionId);
	if (start.links.size === 0) return new Map();
	// Ancestor maps for chain composition (0 = direct parent, 1 = grandparent...)
	const ancestors = new Map<string, Map<number, EventCopy>>();
	let parentSession = start.parentSessionId;
	const visited = new Set<string>([sessionId]);
	for (let depth = 0; depth < 16 && parentSession && !visited.has(parentSession); depth++) {
		visited.add(parentSession);
		const ancestor = await directLinks(parentSession);
		ancestors.set(parentSession, ancestor.links);
		parentSession = ancestor.parentSessionId;
	}

	const resolved = new Map<number, EventCopy>();
	for (const [childEventId, link] of start.links) {
		if (!link.copyOf) {
			// Parent rows are gone: keep the inherited TIME, no dedupe anchor.
			resolved.set(childEventId, { copyOf: null, occurredAt: link.occurredAt });
			continue;
		}
		const anchor = parseCopyAnchor(link.copyOf);
		if (!anchor) {
			resolved.set(childEventId, { copyOf: null, occurredAt: link.occurredAt });
			continue;
		}
		let sessionIdAt = anchor.sessionId;
		let eventIdAt = anchor.eventId;
		let occurredAt = link.occurredAt;
		let copyOfAt: string | null = link.copyOf;
		const chain = new Set<string>([`${sessionIdAt}:${eventIdAt}`]);
		for (let depth = 0; depth < 16; depth++) {
			const step = ancestors.get(sessionIdAt)?.get(eventIdAt);
			if (!step?.copyOf) break; // original, or its parent is gone
			const next = parseCopyAnchor(step.copyOf);
			if (!next) break;
			const key = `${next.sessionId}:${next.eventId}`;
			if (chain.has(key)) break; // cycle: the direct anchor is still real
			chain.add(key);
			sessionIdAt = next.sessionId;
			eventIdAt = next.eventId;
			occurredAt = step.occurredAt;
			copyOfAt = step.copyOf;
		}
		resolved.set(childEventId, { copyOf: copyOfAt, occurredAt });
	}
	return resolved;
}
