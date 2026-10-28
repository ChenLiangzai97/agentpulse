/**
 * Fork CHILD ingestion (server domain): the trusted child binding is the only
 * routing authority; a child snapshot is ingested into the CHILD session, the
 * copied prefix keeps the parent's original time and is not counted again, and
 * discovered-but-unbound native sessions stay observe-only (or absent).
 *
 * These are DB-level tests; the provider that fetches each child native id is
 * exercised by the real-runtime chain test.
 */
import "../db/__test_db.js";
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { partFingerprint } from "../../shared/opencode-copy.js";
import { getDb, initializeDatabase } from "../db/client.js";
import {
	events,
	controlActions,
	launchRequests,
	managedSessions,
	opencodeForkRequests,
	opencodeForks,
	providerInstances,
	providerInteractions,
	sessionControlBindings,
	sessions,
	supervisors,
} from "../db/schema/index.js";
import {
	assertSessionControlOrigin,
	bindCreatedOpenCodeSession,
	reserveOpenCodeInstance,
	trustedOpenCodeForkChildren,
} from "./opencode-control-provenance.js";
import { acceptOpenCodeSnapshot, listOpenCodeForkChildren } from "./opencode-managed.js";
import { loadCopiedEvents } from "./worklog-copy.js";

const HOST = "fork-child-host";
const PARENT_SESSION = "fork-parent";
const PARENT_NATIVE = "ses_parent";

const iso = (ms: number) => new Date(ms).toISOString();

type NativeMessage = {
	info: Record<string, unknown>;
	parts: Record<string, unknown>[];
};

function message(
	id: string,
	sessionId: string,
	role: "user" | "assistant",
	text: string,
	created: number,
	extra: Record<string, unknown> = {},
): NativeMessage {
	return {
		info: {
			id,
			sessionID: sessionId,
			role,
			time: { created, ...(role === "assistant" ? { completed: created + 10 } : {}) },
			...(role === "assistant"
				? {
						cost: 0,
						tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
						...extra,
					}
				: extra),
		},
		parts: [
			{
				id: `${id}_text`,
				sessionID: sessionId,
				messageID: id,
				type: "text",
				text,
				time: { start: created, end: created + 5 },
			},
		],
	};
}

beforeAll(() => initializeDatabase());

beforeEach(async () => {
	for (const table of [
		providerInstances,
		opencodeForkRequests,
		opencodeForks,
		sessionControlBindings,
		managedSessions,
		controlActions,
		events,
		launchRequests,
		sessions,
		supervisors,
	])
		await getDb().delete(table);
	await getDb()
		.insert(supervisors)
		.values({
			id: HOST,
			hostName: HOST,
			platform: "linux",
			arch: "x64",
			version: "test",
			status: "connected",
			trustedRoots: ["/tmp"],
			capabilities: {},
		});
});

async function seedParent() {
	const [launch] = await getDb()
		.insert(launchRequests)
		.values({
			launchCorrelationId: PARENT_SESSION,
			agentType: "opencode",
			cwd: "/tmp",
			requestedLaunchMode: "managed_opencode",
			claimedBySupervisorId: HOST,
			status: "launching",
		})
		.returning();
	const instance = await reserveOpenCodeInstance(HOST, launch.id);
	await getDb()
		.update(providerInstances)
		.set({ state: "running" })
		.where(eq(providerInstances.id, instance.id));
	await getDb()
		.insert(sessions)
		.values({ sessionId: PARENT_SESSION, agentType: "opencode", cwd: "/tmp" });
	await getDb().insert(managedSessions).values({
		sessionId: PARENT_SESSION,
		launchRequestId: launch.id,
		supervisorId: HOST,
		providerSessionId: PARENT_NATIVE,
		managedState: "managed",
	});
	await bindCreatedOpenCodeSession(HOST, instance.id, PARENT_NATIVE, 1);
	return { launch, instance };
}

async function seedChild(
	childSessionId: string,
	childNative: string,
	instanceId: string,
	parentSnapshot: {
		messages: {
			nativeId: string;
			occurredAt: string;
			parts: { fingerprint: string; occurredAt: string }[];
		}[];
	} | null,
	options: { parentSessionId?: string; generation?: number; trusted?: boolean } = {},
) {
	const parentSessionId = options.parentSessionId ?? PARENT_SESSION;
	const generation = options.generation ?? 1;
	await getDb().insert(sessions).values({
		sessionId: childSessionId,
		agentType: "opencode",
		cwd: "/tmp",
		displayName: childSessionId,
	});
	await getDb().insert(sessionControlBindings).values({
		sessionId: childSessionId,
		origin: "agentpulse_launch",
		instanceId,
		nativeSessionId: childNative,
		generation,
	});
	if (options.trusted === false) return;
	const [parentLaunch] = await getDb()
		.select()
		.from(launchRequests)
		.where(eq(launchRequests.launchCorrelationId, PARENT_SESSION));
	await getDb().insert(managedSessions).values({
		sessionId: childSessionId,
		launchRequestId: parentLaunch.id,
		supervisorId: HOST,
		providerSessionId: childNative,
		managedState: "managed",
		correlationSource: "opencode_fork",
	});
	const [action] = await getDb()
		.insert(controlActions)
		.values({
			sessionId: parentSessionId,
			actionType: "opencode_fork",
			requestedBy: "user",
			status: "succeeded",
			metadata: {
				instanceOriginSessionId: PARENT_SESSION,
				directParentSessionId: parentSessionId,
				nativeSessionId: PARENT_NATIVE,
				providerInstanceId: instanceId,
				generation,
			},
		})
		.returning();
	await getDb()
		.insert(opencodeForkRequests)
		.values({
			actionId: action.id,
			requestHash: "hash",
			identity: {
				version: 1,
				instanceOriginSessionId: PARENT_SESSION,
				directParentSessionId: parentSessionId,
				parentNativeSessionId: PARENT_NATIVE,
				providerInstanceId: instanceId,
				generation,
				result: {
					status: "succeeded",
					childSessionId,
					childNativeSessionId: childNative,
					providerInstanceId: instanceId,
					generation,
					confirmedAt: iso(500),
				},
			},
			parentSnapshot: {
				version: 1,
				instanceId,
				nativeSessionId: PARENT_NATIVE,
				messages: parentSnapshot?.messages ?? [],
			},
			childMap: parentSnapshot
				? {
						version: 1,
						forkPointMessageId: null,
						pairs: parentSnapshot.messages.map((entry, index) => ({
							parentNativeId: entry.nativeId,
							childNativeId: `msg_child_${index}`,
							parentOccurredAt: entry.occurredAt,
							parts: entry.parts.map((part) => ({
								fingerprint: part.fingerprint,
								parentOccurredAt: part.occurredAt,
							})),
						})),
					}
				: null,
		});
	await getDb()
		.insert(opencodeForks)
		.values({
			childSessionId,
			parentSessionId,
			parentLabel: { directParentSessionId: parentSessionId, parentNativeSessionId: PARENT_NATIVE },
			forkPointMessageId: null,
			requestActionId: action.id,
			providerInstanceId: instanceId,
			nativeSessionId: childNative,
			generation,
		});
}

const snapshot = (
	nativeSessionId: string,
	messages: NativeMessage[],
	extra: Record<string, unknown> = {},
) => ({
	generation: 1,
	nativeSessionId,
	messages,
	permissions: [],
	questions: [],
	status: { type: "idle" },
	...extra,
});

describe("trusted child enumeration", () => {
	test("returns only trusted committed children for this instance/generation", async () => {
		const { instance } = await seedParent();
		const parentMessage = message("msg_p0", PARENT_NATIVE, "user", "inherited", 1_000);
		const parentSnapshot = {
			messages: [
				{
					nativeId: "msg_p0",
					occurredAt: iso(1_000),
					parts: [{ fingerprint: partFingerprint(parentMessage.parts[0]), occurredAt: iso(1_000) }],
				},
			],
		};
		await seedChild("fork-child-a", "ses_child_a", instance.id, parentSnapshot);
		await seedChild("fork-child-b", "ses_child_b", instance.id, parentSnapshot);
		// unbound (no creation ledger) and wrong-generation children
		await seedChild("fork-child-orphan", "ses_orphan", instance.id, null, { trusted: false });
		await seedChild("fork-child-old", "ses_old", instance.id, parentSnapshot, { generation: 7 });

		const listed = await listOpenCodeForkChildren(HOST, instance.id, 1);
		expect(listed.children.map((child) => child.sessionId).sort()).toEqual([
			"fork-child-a",
			"fork-child-b",
		]);
		const trusted = await trustedOpenCodeForkChildren({
			id: instance.id,
			generation: 1,
			supervisorId: HOST,
			launchRequestId: instance.launchRequestId,
			sessionId: instance.sessionId,
		});
		expect(trusted.map((child) => child.nativeSessionId).sort()).toEqual([
			"ses_child_a",
			"ses_child_b",
		]);
	});

	test("children remain enumerable after the parent session row is deleted", async () => {
		const { instance } = await seedParent();
		await seedChild("fork-child-a", "ses_child_a", instance.id, null);
		await getDb().delete(sessions).where(eq(sessions.sessionId, PARENT_SESSION));
		expect((await getDb().select().from(sessionControlBindings)).map((b) => b.sessionId)).toEqual([
			"fork-child-a",
		]);
		const listed = await listOpenCodeForkChildren(HOST, instance.id, 1);
		expect(listed.children).toEqual([
			{ sessionId: "fork-child-a", nativeSessionId: "ses_child_a" },
		]);
	});

	test("a supervisor cannot enumerate another host's instance or the wrong generation", async () => {
		const { instance } = await seedParent();
		await seedChild("fork-child-a", "ses_child_a", instance.id, null);
		await expect(listOpenCodeForkChildren("other-host", instance.id, 1)).rejects.toThrow(
			"provider_binding_invalid",
		);
		await expect(listOpenCodeForkChildren(HOST, instance.id, 2)).rejects.toThrow(
			"provider_binding_invalid",
		);
	});
});

describe("child snapshot ingestion", () => {
	test("inherited prefix + new turn land ONLY in the child, with parent time and copyOf", async () => {
		const { instance } = await seedParent();
		const parentText = "INHERITED-PARENT-MARKER";
		const parentMessage = message("msg_p0", PARENT_NATIVE, "user", parentText, 1_000);
		const parentParts = [
			{ fingerprint: partFingerprint(parentMessage.parts[0]), occurredAt: iso(1_000) },
		];
		await seedChild("fork-child-a", "ses_child_a", instance.id, {
			messages: [{ nativeId: "msg_p0", occurredAt: iso(1_000), parts: parentParts }],
		});
		// Parent timeline (original).
		await acceptOpenCodeSnapshot(HOST, instance.id, snapshot(PARENT_NATIVE, [parentMessage]));
		const [parentEvent] = await getDb()
			.select()
			.from(events)
			.where(eq(events.sessionId, PARENT_SESSION));

		// Child copied message has a NEW native id and fork-time clock; the ledger
		// says the original was created at 1_000.
		const copied = message("msg_child_0", "ses_child_a", "user", parentText, 99_000);
		// The native fork preserves part content/time but the child message clock
		// is the fork time; the fingerprint (content + part time) is what the
		// ledger maps. The parent's original time wins for ingestion.
		for (const part of copied.parts) part.time = { start: 1_000, end: 1_005 };
		const newChild = message("msg_child_new", "ses_child_a", "assistant", "CHILD-NEW", 2_000, {
			cost: 7,
			tokens: { input: 11, output: 13, reasoning: 0, cache: { read: 0, write: 0 } },
		});
		await acceptOpenCodeSnapshot(HOST, instance.id, snapshot("ses_child_a", [copied, newChild]));

		const childEvents = await getDb()
			.select()
			.from(events)
			.where(eq(events.sessionId, "fork-child-a"));
		expect(childEvents).toHaveLength(2);
		const copiedEvent = childEvents.find((row) => row.content === parentText);
		const newEvent = childEvents.find((row) => row.content === "CHILD-NEW");
		expect(copiedEvent?.createdAt).toBe(iso(1_000));
		expect(newEvent?.createdAt).toBe(iso(2_000));
		// The parent never receives the child's new turn.
		const parentRows = await getDb()
			.select()
			.from(events)
			.where(eq(events.sessionId, PARENT_SESSION));
		expect(parentRows).toHaveLength(1);

		// copyOf resolves back to the original PARENT event.
		expect(typeof parentEvent?.id).toBe("number");
		const copies = await loadCopiedEvents("fork-child-a");
		expect(copies.get(copiedEvent?.id ?? -1)?.copyOf).toBe(`${PARENT_SESSION}:${parentEvent?.id}`);
		expect(copies.get(copiedEvent?.id ?? -1)?.occurredAt).toBe("1970-01-01 00:00:01");

		// Copied usage belongs to the parent's turn, never re-counted on the child.
		const [childSession] = await getDb()
			.select()
			.from(sessions)
			.where(eq(sessions.sessionId, "fork-child-a"));
		const childMeta = childSession?.metadata as {
			opencode?: { cost?: number; tokens?: { input?: number; output?: number } };
		};
		expect(childMeta?.opencode?.cost).toBe(7);
		expect(childMeta?.opencode?.tokens?.input).toBe(11);
		expect(childMeta?.opencode?.tokens?.output).toBe(13);
	});

	test("duplicate child snapshots are idempotent", async () => {
		const { instance } = await seedParent();
		await seedChild("fork-child-a", "ses_child_a", instance.id, null);
		const childMessage = message("msg_child_0", "ses_child_a", "assistant", "ONCE", 3_000);
		await acceptOpenCodeSnapshot(HOST, instance.id, snapshot("ses_child_a", [childMessage]));
		const first = await getDb().select().from(events).where(eq(events.sessionId, "fork-child-a"));
		await acceptOpenCodeSnapshot(HOST, instance.id, snapshot("ses_child_a", [childMessage]));
		await acceptOpenCodeSnapshot(HOST, instance.id, snapshot("ses_child_a", [childMessage]));
		const after = await getDb().select().from(events).where(eq(events.sessionId, "fork-child-a"));
		expect(after).toHaveLength(first.length);
	});

	test("parents and children do not leak messages into each other", async () => {
		const { instance } = await seedParent();
		await seedChild("fork-child-a", "ses_child_a", instance.id, null);
		await acceptOpenCodeSnapshot(
			HOST,
			instance.id,
			snapshot(PARENT_NATIVE, [message("msg_p0", PARENT_NATIVE, "user", "PARENT-ONLY", 1_000)]),
		);
		await acceptOpenCodeSnapshot(
			HOST,
			instance.id,
			snapshot("ses_child_a", [message("msg_child_0", "ses_child_a", "user", "CHILD-ONLY", 2_000)]),
		);
		const parentRows = await getDb()
			.select()
			.from(events)
			.where(eq(events.sessionId, PARENT_SESSION));
		const childRows = await getDb()
			.select()
			.from(events)
			.where(eq(events.sessionId, "fork-child-a"));
		expect(parentRows.map((row) => row.content)).toEqual(["PARENT-ONLY"]);
		expect(childRows.map((row) => row.content)).toEqual(["CHILD-ONLY"]);
	});

	test("two branches ingest independently and do not cross", async () => {
		const { instance } = await seedParent();
		await seedChild("fork-child-a", "ses_child_a", instance.id, null);
		await seedChild("fork-child-b", "ses_child_b", instance.id, null);
		await acceptOpenCodeSnapshot(
			HOST,
			instance.id,
			snapshot("ses_child_a", [message("msg_a", "ses_child_a", "user", "BRANCH-A", 1_000)]),
		);
		await acceptOpenCodeSnapshot(
			HOST,
			instance.id,
			snapshot("ses_child_b", [message("msg_b", "ses_child_b", "user", "BRANCH-B", 2_000)]),
		);
		const a = await getDb().select().from(events).where(eq(events.sessionId, "fork-child-a"));
		const b = await getDb().select().from(events).where(eq(events.sessionId, "fork-child-b"));
		expect(a.map((row) => row.content)).toEqual(["BRANCH-A"]);
		expect(b.map((row) => row.content)).toEqual(["BRANCH-B"]);
	});

	test("child ingestion survives deletion of the parent session row", async () => {
		const { instance } = await seedParent();
		await seedChild("fork-child-a", "ses_child_a", instance.id, null);
		await getDb().delete(sessions).where(eq(sessions.sessionId, PARENT_SESSION));
		await acceptOpenCodeSnapshot(
			HOST,
			instance.id,
			snapshot("ses_child_a", [
				message("msg_child_0", "ses_child_a", "user", "AFTER-PARENT-GONE", 1_000),
			]),
		);
		const childRows = await getDb()
			.select()
			.from(events)
			.where(eq(events.sessionId, "fork-child-a"));
		expect(childRows.map((row) => row.content)).toEqual(["AFTER-PARENT-GONE"]);
	});

	test("an UNKNOWN child native session is never auto-bound or routed", async () => {
		const { instance } = await seedParent();
		await expect(
			acceptOpenCodeSnapshot(
				HOST,
				instance.id,
				snapshot("ses_stranger", [message("msg_s", "ses_stranger", "user", "NOPE", 1_000)]),
			),
		).rejects.toThrow("provider_binding_invalid");
		expect(
			await getDb().select().from(sessions).where(eq(sessions.sessionId, "fork-stranger")),
		).toHaveLength(0);
	});

	test("a trusted child discovered in the parent snapshot is NOT duplicated observe-only", async () => {
		const { instance } = await seedParent();
		await seedChild("fork-child-a", "ses_child_a", instance.id, null);
		const trustedChild = {
			session: {
				id: "ses_child_a",
				parentID: PARENT_NATIVE,
				directory: "/tmp",
				title: "trusted",
			},
			messages: [message("msg_child_0", "ses_child_a", "user", "TRUSTED-SNAPSHOT", 1_000)],
		};
		const unknownChild = {
			session: {
				id: "ses_unknown_a",
				parentID: PARENT_NATIVE,
				directory: "/tmp",
				title: "unknown",
			},
			messages: [message("msg_unknown", "ses_unknown_a", "user", "UNKNOWN-SNAPSHOT", 2_000)],
		};
		await acceptOpenCodeSnapshot(HOST, instance.id, {
			...snapshot(PARENT_NATIVE, []),
			children: [trustedChild, unknownChild],
		});
		const rows = await getDb().select().from(sessions);
		expect(
			rows.some((row) => row.sessionId === `${PARENT_SESSION}:opencode-child:ses_child_a`),
		).toBe(false);
		const observed = rows.find(
			(row) => row.sessionId === `${PARENT_SESSION}:opencode-child:ses_unknown_a`,
		);
		expect(observed?.metadata?.opencode).toMatchObject({ managedChildObservedOnly: true });
		await expect(assertSessionControlOrigin(observed?.sessionId ?? "", undefined)).rejects.toThrow(
			"session_observe_only",
		);
		// The discovered child's messages stay out of the trusted child session;
		// only the child's OWN snapshot may fill that timeline.
		expect(
			await getDb().select().from(events).where(eq(events.sessionId, "fork-child-a")),
		).toHaveLength(0);
	});
});

describe("interaction isolation", () => {
	const permission = (id: string, sessionID: string) => ({ id, sessionID, type: "permission" });

	test("child interactions land on the child and never withdraw the parent's pending card", async () => {
		const { instance } = await seedParent();
		await seedChild("fork-child-a", "ses_child_a", instance.id, null);
		await acceptOpenCodeSnapshot(HOST, instance.id, {
			...snapshot(PARENT_NATIVE, []),
			permissions: [
				permission("per_parent", PARENT_NATIVE),
				permission("per_child", "ses_child_a"),
			],
		});
		let rows = await getDb().select().from(providerInteractions);
		expect(rows.map((row) => [row.sessionId, row.nativeRequestId])).toEqual([
			[PARENT_SESSION, "per_parent"],
		]);
		await acceptOpenCodeSnapshot(HOST, instance.id, {
			...snapshot("ses_child_a", []),
			permissions: [
				permission("per_child", "ses_child_a"),
				permission("per_parent", PARENT_NATIVE),
			],
		});
		rows = await getDb().select().from(providerInteractions);
		expect(
			rows
				.map((row) => [row.sessionId, row.nativeRequestId, row.status])
				.sort((a, b) => String(a[1]).localeCompare(String(b[1]))),
		).toEqual([
			["fork-child-a", "per_child", "pending"],
			[PARENT_SESSION, "per_parent", "pending"],
		]);
		// The next CHILD snapshot withdrawing its own card must not touch the
		// parent's pending card.
		await acceptOpenCodeSnapshot(HOST, instance.id, snapshot("ses_child_a", []));
		rows = await getDb().select().from(providerInteractions);
		const parentCard = rows.find((row) => row.nativeRequestId === "per_parent");
		const childCard = rows.find((row) => row.nativeRequestId === "per_child");
		expect(parentCard?.status).toBe("pending");
		expect(childCard?.status).toBe("withdrawn");
	});
});
