/** Managed OpenCode protocol boundary. Native state is scoped to a protected instance/generation. */
import { createHash } from "node:crypto";
import { and, eq, gt, inArray, ne, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { partFingerprint } from "../../shared/opencode-copy.js";
import type { Actor } from "../auth/actor.js";
import { config } from "../config.js";
import { getDb } from "../db/client.js";
import {
	events,
	controlActions,
	managedSessions,
	opencodeForkRequests,
	opencodeForks,
	providerInstances,
	providerInteractions,
	sessionControlBindings,
	sessions,
} from "../db/schema/index.js";
import { withTransaction } from "../db/with-transaction.js";
import { assertCanEditSessionNotes } from "./authorization.js";
import { activeLeases, withControlMutex } from "./control-lease.js";
import { toSessionEventDtos } from "./event-dto.js";
import { notifySessionEvents, notifySessionUpdated } from "./notifier.js";
import {
	SessionControlOriginError,
	assertSessionControlOrigin,
	inspectOpenCodeProvenance,
	recordExternalOpenCodeSession,
	trustedForkChildIssue,
	trustedOpenCodeForkChildren,
} from "./opencode-control-provenance.js";
import { normalizeOpenCodePart } from "./opencode-observer.js";

type Json = Record<string, unknown>;
const object = (v: unknown): Json =>
	v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {};
/**
 * Dialect-native multi-key atomic metadata update (SQLite json_set / PG
 * jsonb_set chain). Each key is set in place, so writers owned by other
 * features (opencodeCatalog, opencodePrefs, worklogInclude, ...) never lose
 * their keys to a whole-object read-modify-write. The PG column is `json`,
 * not `jsonb`, so the expression casts json -> jsonb for jsonb_set and back.
 */
const SAFE_METADATA_KEY = /^[A-Za-z0-9_]+$/;
function metadataSetSql(entries: Record<string, Json>): SQL {
	let expr: SQL =
		config.dialect === "postgres"
			? sql`coalesce(${sessions.metadata}::jsonb, '{}'::jsonb)`
			: sql`coalesce(${sessions.metadata}, '{}')`;
	for (const [key, value] of Object.entries(entries)) {
		// Paths are inlined string literals; only developer-controlled
		// constant keys ever reach here (never user input).
		if (!SAFE_METADATA_KEY.test(key)) throw new Error(`unsafe metadata key: ${key}`);
		const json = JSON.stringify(value);
		expr =
			config.dialect === "postgres"
				? sql`jsonb_set(${expr}, ${sql.raw(`'{${key}}'`)}, ${json}::jsonb)`
				: sql`json_set(${expr}, ${sql.raw(`'$.${key}'`)}, json(${json}))`;
	}
	return config.dialect === "postgres" ? sql`${expr}::json` : expr;
}
export async function openCodeControlCapabilities(sessionId: string, actor?: Actor) {
	const origin = await inspectOpenCodeProvenance(sessionId);
	let enabled = Boolean(origin?.bindingValid);
	if (actor) {
		try {
			await assertCanEditSessionNotes(actor, sessionId);
		} catch {
			enabled = false;
		}
	}
	return {
		origin: origin?.origin ?? null,
		send: enabled,
		interrupt: enabled,
		stop: enabled,
		respondPermission: enabled,
		answerQuestion: enabled,
		reason: enabled ? null : origin?.bindingValid ? "not_owner" : (origin?.reason ?? null),
	};
}
export async function ownedOpenCodeInstance(
	supervisorId: string,
	instanceId: string,
	generation: number,
	allowHistorical = false,
) {
	const [instance] = await getDb()
		.select()
		.from(providerInstances)
		.where(eq(providerInstances.id, instanceId));
	const historical =
		allowHistorical &&
		instance?.generation === generation + 1 &&
		["stopped", "interrupted"].includes(instance.state);
	if (
		!instance ||
		instance.agentType !== "opencode" ||
		instance.supervisorId !== supervisorId ||
		(!historical && (instance.generation !== generation || instance.state !== "running"))
	)
		throw new SessionControlOriginError("provider_binding_invalid");
	if (!historical) await assertSessionControlOrigin(instance.sessionId);
	return instance;
}
/**
 * Supervisor-facing enumeration of TRUSTED committed fork children for one
 * instance/generation. The provider uses this to poll each child by its native
 * id; discovered-but-unbound native sessions are deliberately absent, so a
 * child can never be attached or controlled merely because it appeared in a
 * snapshot. The parent session row may already be gone — the child binding and
 * its creation ledger are the authority.
 */
export async function listOpenCodeForkChildren(
	supervisorId: string,
	instanceId: string,
	generation: number,
) {
	const [instance] = await getDb()
		.select()
		.from(providerInstances)
		.where(eq(providerInstances.id, instanceId));
	if (
		!instance ||
		instance.agentType !== "opencode" ||
		instance.supervisorId !== supervisorId ||
		instance.generation !== generation ||
		!["reserved", "running"].includes(instance.state)
	)
		throw new SessionControlOriginError("provider_binding_invalid");
	const children = await trustedOpenCodeForkChildren({
		id: instance.id,
		generation: instance.generation,
		supervisorId: instance.supervisorId,
		launchRequestId: instance.launchRequestId,
		sessionId: instance.sessionId,
	});
	return {
		instanceId: instance.id,
		generation: instance.generation,
		sessionId: instance.sessionId,
		children,
	};
}

interface ForkCopyInfo {
	occurredAt: string;
	parts: Map<string, string>;
}

function buildForkCopyIndex(childMap: unknown): Map<string, ForkCopyInfo> {
	const index = new Map<string, ForkCopyInfo>();
	const pairs = (childMap as { pairs?: unknown } | null)?.pairs;
	if (!Array.isArray(pairs)) return index;
	for (const raw of pairs) {
		const pair = object(raw);
		const childNativeId = pair.childNativeId;
		const occurredAt = pair.parentOccurredAt;
		if (typeof childNativeId !== "string" || typeof occurredAt !== "string") continue;
		const parts = new Map<string, string>();
		if (Array.isArray(pair.parts)) {
			for (const rawPart of pair.parts) {
				const part = object(rawPart);
				if (typeof part.fingerprint === "string" && typeof part.parentOccurredAt === "string")
					parts.set(part.fingerprint, part.parentOccurredAt);
			}
		}
		const existing = index.get(childNativeId);
		// A duplicated child message id is ambiguous: keep the LAST full entry
		// only when it is the same message, never merge half-evidence.
		if (existing && existing.occurredAt !== occurredAt) continue;
		index.set(childNativeId, {
			occurredAt,
			parts: new Map([...(existing?.parts ?? []), ...parts]),
		});
	}
	return index;
}

/**
 * The ledger map is immutable and execution-time. It is NOT a message source:
 * the timeline always comes from the native child snapshot; the map only
 * restores the ORIGINAL occurrence time of the copied prefix and marks which
 * messages must not be counted again as new usage.
 */
async function loadChildCopyIndex(bindingSessionId: string): Promise<Map<string, ForkCopyInfo>> {
	const [fork] = await getDb()
		.select()
		.from(opencodeForks)
		.where(eq(opencodeForks.childSessionId, bindingSessionId))
		.limit(1);
	if (!fork?.requestActionId) return new Map();
	const [ledger] = await getDb()
		.select({ childMap: opencodeForkRequests.childMap })
		.from(opencodeForkRequests)
		.where(eq(opencodeForkRequests.actionId, fork.requestActionId))
		.limit(1);
	return buildForkCopyIndex(ledger?.childMap);
}

export async function acceptOpenCodeSnapshot(
	supervisorId: string,
	instanceId: string,
	rawInput: {
		generation: number;
		children?: { session: Json; messages: unknown[] }[];
		nativeSessionId: string;
		messages: unknown[];
		permissions: unknown[];
		questions: unknown[];
		status: unknown;
		commands?: unknown[];
		agents?: unknown[];
		providers?: unknown;
	},
) {
	const instance = await ownedOpenCodeInstance(supervisorId, instanceId, rawInput.generation, true);
	// A3 snapshot routing (fork design §A3): the snapshot's nativeSessionId
	// decides WHICH session this snapshot belongs to — the launching session's
	// own binding, or a fork child's binding ON THE SAME INSTANCE registered
	// in the trusted 0015 ledger. A native session with NO matching binding is
	// rejected (never silently attached, never auto-created as external).
	const instanceBindings = await getDb()
		.select()
		.from(sessionControlBindings)
		.where(eq(sessionControlBindings.instanceId, instanceId));
	const instanceSessionId = instance.sessionId;
	const binding: (typeof instanceBindings)[number] | undefined =
		instanceBindings.find(
			(b) =>
				b.origin === "agentpulse_launch" &&
				b.generation === rawInput.generation &&
				b.nativeSessionId === rawInput.nativeSessionId &&
				b.sessionId === instanceSessionId,
		) ??
		(await (async () => {
			// child candidates: same instance, same generation, matching native id,
			// and a TRUSTED fork-ledger row for that child session
			const child = instanceBindings.find(
				(b) =>
					b.origin === "agentpulse_launch" &&
					b.generation === rawInput.generation &&
					b.nativeSessionId === rawInput.nativeSessionId &&
					b.sessionId !== instanceSessionId,
			);
			if (!child) return undefined;
			// SAME trusted-creation validation as the authorization path.
			const issue = await trustedForkChildIssue({
				childSessionId: child.sessionId,
				bindingInstanceId: child.instanceId,
				bindingNativeSessionId: child.nativeSessionId,
				bindingGeneration: child.generation,
				instance: {
					id: instance.id,
					generation: instance.generation,
					supervisorId: instance.supervisorId,
					launchRequestId: instance.launchRequestId,
					sessionId: instance.sessionId,
				},
				snapshotNativeSessionId: rawInput.nativeSessionId,
			});
			return issue === null ? child : undefined;
		})());
	if (
		!binding ||
		!Array.isArray(rawInput.messages) ||
		!Array.isArray(rawInput.permissions) ||
		!Array.isArray(rawInput.questions)
	)
		throw new SessionControlOriginError("provider_binding_invalid");
	if (Array.isArray(rawInput.commands)) {
		// Credentials must never reach the catalog: strip provider options/env
		// down to id/name plus bare model ids, agents to name/description/mode,
		// and keep only native custom commands (source=command) — skills are
		// listed nowhere until an explicit source policy lands.
		const rawProviders = object(rawInput.providers);
		const providerList = Array.isArray(rawProviders.providers)
			? rawProviders.providers.slice(0, 32).map((entry) => {
					const provider = object(entry);
					const models = object(provider.models);
					return {
						id: typeof provider.id === "string" ? provider.id : "",
						name: typeof provider.name === "string" ? provider.name : "",
						models: Object.keys(models)
							.slice(0, 128)
							.filter((modelId) => typeof modelId === "string" && modelId.length <= 200),
					};
				})
			: [];
		const commands = rawInput.commands
			.filter((raw) => object(raw).source === "command")
			.slice(0, 128)
			.map((raw) => {
				const command = object(raw);
				return {
					name: typeof command.name === "string" ? command.name : "",
					description:
						typeof command.description === "string" ? command.description.slice(0, 200) : "",
					source: "command",
				};
			});
		const agents = (Array.isArray(rawInput.agents) ? rawInput.agents : [])
			.slice(0, 64)
			.map((raw) => {
				const agent = object(raw);
				return {
					name: typeof agent.name === "string" ? agent.name : "",
					description: typeof agent.description === "string" ? agent.description.slice(0, 200) : "",
					mode: typeof agent.mode === "string" ? agent.mode.slice(0, 32) : "",
				};
			});
		// Dialect-native atomic single-key update: SQLite json_set / PG jsonb_set
		// touch only the opencodeCatalog key, so a concurrent writer updating a
		// different metadata field (permissionWait, worklogInclude, ...) never
		// loses its update to a whole-object overwrite.
		const catalog = {
			commands,
			agents,
			providers: providerList,
			updatedAt: new Date().toISOString(),
		};
		await getDb()
			.update(sessions)
			.set({ metadata: metadataSetSql({ opencodeCatalog: catalog }) })
			.where(eq(sessions.sessionId, binding.sessionId));
	}
	const historical = instance.generation !== rawInput.generation;
	const interruptedReplay = historical || object(rawInput.status).type === "interrupted";
	// Replay of an interrupted/stopped generation is sanitized before it can
	// resurrect permissions or questions the operator never answered.
	const input = interruptedReplay
		? { ...rawInput, permissions: [], questions: [], status: { type: "idle" } }
		: rawInput;
	const children: Array<{ session: Json; messages: unknown[] }> = [];
	const descendants = new Set([input.nativeSessionId]);
	for (let depth = 0; depth < 64; depth++) {
		let changed = false;
		for (const child of (input.children ?? []).slice(0, 256)) {
			const session = object(child.session);
			if (
				typeof session.id !== "string" ||
				!/^ses_[A-Za-z0-9_-]+$/.test(session.id) ||
				session.directory !== instance.cwd ||
				descendants.has(session.id) ||
				!descendants.has(String(session.parentID))
			)
				continue;
			descendants.add(session.id);
			children.push({ session, messages: Array.isArray(child.messages) ? child.messages : [] });
			changed = true;
		}
		if (!changed) break;
	}
	// TRUSTED fork children have their OWN binding and are ingested from their
	// own snapshot (the supervisor polls each of them). They must never also be
	// materialized as a discovered, observe-only pseudo session. Unknown
	// discovered sessions keep the old observe-only path — never a binding and
	// never control.
	const trustedNativeIds = new Set(
		children.length > 0
			? (
					await trustedOpenCodeForkChildren({
						id: instance.id,
						generation: instance.generation,
						supervisorId: instance.supervisorId,
						launchRequestId: instance.launchRequestId,
						sessionId: instance.sessionId,
					})
				).map((child) => child.nativeSessionId)
			: [],
	);
	const observedChildren = children.filter(
		(child) => !trustedNativeIds.has(String(child.session.id)),
	);
	const copyIndex =
		binding.sessionId === instanceSessionId
			? new Map<string, ForkCopyInfo>()
			: await loadChildCopyIndex(binding.sessionId);
	const timestamp = new Date().toISOString();
	const changed = await withTransaction(async (tx) => {
		const fence = await tx
			.update(providerInstances)
			.set({ protocolVersion: "1.18.35" })
			.where(
				and(
					eq(providerInstances.id, instanceId),
					eq(providerInstances.generation, instance.generation),
					eq(providerInstances.state, instance.state),
				),
			)
			.returning();
		if (!fence.length) throw new SessionControlOriginError("provider_binding_invalid");
		const changedRows = [];
		for (const item of input.messages) {
			const message = object(item);
			const info = object(message.info);
			if (
				info.sessionID !== input.nativeSessionId ||
				typeof info.id !== "string" ||
				!Array.isArray(message.parts)
			)
				continue;
			const nativeCreated = Number(object(info.time).created) || Date.now();
			const copy = copyIndex.get(info.id);
			const messageCreated = copy ? Date.parse(copy.occurredAt) || nativeCreated : nativeCreated;
			for (const value of message.parts) {
				const nativePart = object(value);
				const copiedPartTime = copy?.parts.get(partFingerprint(nativePart));
				const partCreated = copiedPartTime
					? Date.parse(copiedPartTime) || messageCreated
					: messageCreated;
				let part = nativePart;
				if (
					interruptedReplay &&
					part.type === "tool" &&
					["running", "pending"].includes(String(object(part.state).status))
				)
					part = {
						...part,
						state: {
							...object(part.state),
							status: "error",
							error: "OpenCode process interrupted; native tool completion unconfirmed.",
						},
					};
				if (
					part.sessionID !== input.nativeSessionId ||
					part.messageID !== info.id ||
					typeof part.id !== "string"
				)
					continue;
				const source = {
					session_id: input.nativeSessionId,
					data: JSON.stringify(info),
					id: info.id,
					time_created: partCreated,
					time_updated: Number(object(info.time).completed) || partCreated,
				};
				const normalized = normalizeOpenCodePart(
					{ ...source, id: part.id, message_id: info.id, data: JSON.stringify(part) },
					source,
				);
				if (!normalized) continue;
				const dedupKey = `opencode-managed:${part.id}`;
				const [before] = await tx
					.select()
					.from(events)
					.where(and(eq(events.sessionId, binding.sessionId), eq(events.dedupKey, dedupKey)));
				if (before?.rawPayload?.observer_fingerprint === normalized.rawPayload.observer_fingerprint)
					continue;
				const row = {
					...normalized,
					source: "managed_control" as const,
					dedupKey,
					createdAt: new Date(partCreated).toISOString(),
				};
				const rows = await tx
					.insert(events)
					.values({ ...row, sessionId: binding.sessionId })
					.onConflictDoUpdate({ target: [events.sessionId, events.dedupKey], set: row })
					.returning();
				changedRows.push(...rows);
			}
		}
		const pendingKeys = new Set<string>();
		for (const [kind, requests] of [
			["permission", input.permissions],
			["question", input.questions],
		] as const) {
			for (const value of requests) {
				const payload = object(value);
				// STRICT native-session routing: an interaction belongs to the
				// snapshot's OWN binding. Child interactions can never be written
				// into the parent (and vice versa).
				if (payload.sessionID !== input.nativeSessionId || typeof payload.id !== "string") continue;
				const revision = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
				const key = `${kind}:${payload.id}`;
				pendingKeys.add(key);
				await tx
					.insert(providerInteractions)
					.values({
						sessionId: binding.sessionId,
						instanceId,
						generation: input.generation,
						nativeRequestId: payload.id,
						kind,
						payload,
						revision,
						expiresAt: new Date(Date.now() + 3600000).toISOString(),
					})
					.onConflictDoUpdate({
						set: { payload, revision, updatedAt: timestamp },
						setWhere: and(
							eq(providerInteractions.status, "pending"),
							ne(providerInteractions.revision, revision),
						),
						target: [
							providerInteractions.instanceId,
							providerInteractions.generation,
							providerInteractions.kind,
							providerInteractions.nativeRequestId,
						],
					});
			}
		}
		const pending = await tx
			.select()
			.from(providerInteractions)
			.where(
				and(
					eq(providerInteractions.sessionId, binding.sessionId),
					eq(providerInteractions.instanceId, instanceId),
					eq(providerInteractions.generation, input.generation),
				),
			);
		for (const row of pending) {
			if (!["pending", "answering"].includes(row.status)) continue;
			const expired = Date.parse(row.expiresAt) <= Date.now();
			if (expired || !pendingKeys.has(`${row.kind}:${row.nativeRequestId}`))
				await tx
					.update(providerInteractions)
					.set({
						status: expired ? "expired" : row.status === "answering" ? "resolved" : "withdrawn",
						updatedAt: timestamp,
					})
					.where(eq(providerInteractions.id, row.id));
		}
		const usage = {
			cost: 0,
			tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
		};
		let latestUser = 0;
		let latestAssistant = 0;
		for (const value of input.messages) {
			const info = object(object(value).info);
			const time = object(info.time);
			const nativeCreated = Number(time.created) || 0;
			const copy = typeof info.id === "string" ? copyIndex.get(info.id) : undefined;
			const occurredAt = copy ? Date.parse(copy.occurredAt) || nativeCreated : nativeCreated;
			if (info.role === "user") latestUser = Math.max(latestUser, occurredAt);
			if (info.role === "assistant") {
				latestAssistant = Math.max(
					latestAssistant,
					copy ? occurredAt : Number(time.completed) || 0,
				);
				// COPIED prefix messages belong to the parent's original turn:
				// they are not NEW child usage and must not be counted twice.
				if (copy) continue;
				usage.cost += Number(info.cost) || 0;
				const tokens = object(info.tokens);
				usage.tokens.input += Number(tokens.input) || 0;
				usage.tokens.output += Number(tokens.output) || 0;
				usage.tokens.reasoning += Number(tokens.reasoning) || 0;
				usage.tokens.cacheRead += Number(object(tokens.cache).read) || 0;
				usage.tokens.cacheWrite += Number(object(tokens.cache).write) || 0;
			}
		}
		const busy = object(input.status).type === "busy" || object(input.status).type === "retry";
		const tools = await tx
			.select({ count: sql<number>`count(*)` })
			.from(events)
			.where(and(eq(events.sessionId, binding.sessionId), eq(events.category, "tool_event")));
		const [session] = await tx
			.select()
			.from(sessions)
			.where(eq(sessions.sessionId, binding.sessionId));
		await tx
			.update(sessions)
			.set({
				isWorking: busy,
				status: busy ? "active" : "idle",
				totalToolUses: Number(tools[0]?.count ?? 0),
				...(latestUser ? { lastUserAcknowledgedAt: new Date(latestUser).toISOString() } : {}),
				...(latestAssistant
					? { lastAgentTurnCompletedAt: new Date(latestAssistant).toISOString() }
					: {}),
				lastActivityAt: changedRows.length ? timestamp : session.lastActivityAt,
				metadata: metadataSetSql({
					permissionWait: { ids: [...pendingKeys], anon: 0 },
					opencode: {
						...object(session.metadata?.opencode),
						instanceId,
						nativeSessionId: input.nativeSessionId,
						...usage,
					},
					opencodeManaged: { status: input.status, pending: pendingKeys.size },
				}),
			})
			.where(eq(sessions.sessionId, binding.sessionId));
		return changedRows;
	});
	const [updated] = await getDb()
		.select()
		.from(sessions)
		.where(eq(sessions.sessionId, binding.sessionId));
	await persistManagedChildren(instance, observedChildren, interruptedReplay);
	notifySessionUpdated(updated);
	notifySessionEvents(binding.sessionId, toSessionEventDtos(changed));
	return { changed: changed.length };
}
export async function listOpenCodeInteractions(sessionId: string) {
	await assertSessionControlOrigin(sessionId);
	return getDb()
		.select()
		.from(providerInteractions)
		.where(
			and(
				eq(providerInteractions.sessionId, sessionId),
				eq(providerInteractions.status, "pending"),
				gt(providerInteractions.expiresAt, new Date().toISOString()),
			),
		);
}
export async function readOpenCodePrefs(
	sessionId: string,
): Promise<{ model: string | null; agent: string | null }> {
	const [row] = await getDb()
		.select({ metadata: sessions.metadata })
		.from(sessions)
		.where(eq(sessions.sessionId, sessionId))
		.limit(1);
	const prefs = (
		row?.metadata as { opencodePrefs?: { model?: unknown; agent?: unknown } } | undefined
	)?.opencodePrefs;
	return {
		model: typeof prefs?.model === "string" ? prefs.model : null,
		agent: typeof prefs?.agent === "string" ? prefs.agent : null,
	};
}

export async function writeOpenCodePrefs(
	sessionId: string,
	update: { model?: string | null; agent?: string | null },
	actor?: Actor,
): Promise<{ model: string | null; agent: string | null }> {
	// Managed-only: prefs steer real prompts, so an observe-only session may
	// read but never write them.
	await assertSessionControlOrigin(sessionId, actor);
	const before = await readOpenCodePrefs(sessionId);
	const next = {
		model: update.model === undefined ? before.model : update.model,
		agent: update.agent === undefined ? before.agent : update.agent,
	};
	await getDb()
		.update(sessions)
		.set({ metadata: metadataSetSql({ opencodePrefs: next }) })
		.where(eq(sessions.sessionId, sessionId));
	return next;
}

export async function queueOpenCodeAction(
	sessionId: string,
	kind:
		| "interrupt"
		| "stop"
		| "prompt"
		| "interaction_response"
		| "opencode_command"
		| "opencode_fork"
		| "opencode_resume",
	input: Json,
	actor: Actor,
) {
	await assertCanEditSessionNotes(actor, sessionId);
	await assertSessionControlOrigin(sessionId, actor);
	const [binding] = await getDb()
		.select()
		.from(sessionControlBindings)
		.where(eq(sessionControlBindings.sessionId, sessionId));
	if (!binding || binding.origin !== "agentpulse_launch")
		throw new SessionControlOriginError("session_observe_only");
	let forkRequestHash: string | null = null;
	const runTransaction = () => withTransaction(async (tx) => {
		const fence = await tx
			.update(providerInstances)
			.set({ protocolVersion: "1.18.35" })
			.where(
				and(
					eq(providerInstances.id, binding.instanceId ?? ""),
					eq(providerInstances.generation, binding.generation ?? 0),
					eq(providerInstances.state, "running"),
				),
			)
			.returning();
		if (!fence.length) throw new SessionControlOriginError("provider_binding_invalid");
		// PROTECTED STOP GATE: the binding carries the epoch every executable
		// action is queued at; STOP increments it and moves active -> stopping.
		const [controlBinding] = await tx
			.select()
			.from(sessionControlBindings)
			.where(eq(sessionControlBindings.sessionId, sessionId))
			.limit(1);
		const executable =
			kind === "prompt" ||
			kind === "opencode_command" ||
			kind === "opencode_fork" ||
			kind === "interaction_response" ||
			kind === "interrupt";
		let controlEpoch = controlBinding?.stopEpoch ?? 0;
		if (kind === "opencode_resume") {
			// Resume exists ONLY from a TRUSTED stopped state (native stop
			// confirmed) with the instance still alive; a killed instance needs a
			// relaunch. Entry-gated; default closed.
			if (!config.opencodeResumeEntry) throw new Error("opencode_resume_entry_closed");
			if (!controlBinding) throw new SessionControlOriginError("provider_binding_invalid");
			if (controlBinding.stopState !== "stopped")
				throw new Error("opencode_resume_not_stopped");
			const [instance] = await tx
				.select()
				.from(providerInstances)
				.where(eq(providerInstances.id, controlBinding.instanceId ?? ""));
			if (!instance || instance.state !== "running")
				throw new Error("opencode_resume_requires_relaunch");
			// TWO-PHASE: the transition happens ONLY after the supervisor has
			// verified there are no unresolved attempts and reports success. The
			// queued resume carries the candidate epoch; the binding stays stopped.
			controlEpoch = controlBinding.stopEpoch + 1;
		} else if (kind === "stop") {
			if (!controlBinding) throw new SessionControlOriginError("provider_binding_invalid");
			if (controlBinding.stopState !== "active") throw new Error("opencode_session_already_stopping");
			// DRAIN: an execution permit already handed out must finish before the
			// epoch advances. Expired leases are UNKNOWN, never treated as safe.
			// Running actions in the DB cover a control-service restart (leases are
			// in memory); either one defers the stop for an explicit retry.
			if (activeLeases(sessionId).length > 0) throw new Error("opencode_stop_deferred");
			const running = await tx
				.select({ id: controlActions.id })
				.from(controlActions)
				.where(
					and(
						eq(controlActions.sessionId, sessionId),
						eq(controlActions.status, "running"),
						inArray(controlActions.actionType, [
							"prompt",
							"opencode_command",
							"opencode_fork",
							"interaction_response",
							"interrupt",
						]),
					),
				)
				.limit(1);
			if (running.length > 0) throw new Error("opencode_stop_deferred");
			controlEpoch = controlBinding.stopEpoch + 1;
			await tx
				.update(sessionControlBindings)
				.set({ stopState: "stopping", stopEpoch: controlEpoch })
				.where(eq(sessionControlBindings.sessionId, sessionId));
			// Cancel EVERY queued executable delivery, not just prompts.
			await tx
				.update(controlActions)
				.set({
					status: "failed",
					error: "opencode_session_stopped",
					finishedAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
				})
				.where(
					and(
						eq(controlActions.sessionId, sessionId),
						inArray(controlActions.actionType, [
							"prompt",
							"opencode_command",
							"opencode_fork",
							"interaction_response",
							"interrupt",
						]),
						eq(controlActions.status, "queued"),
					),
				);
			await tx
				.update(providerInteractions)
				.set({ status: "expired", updatedAt: new Date().toISOString() })
				.where(
					and(
						eq(providerInteractions.sessionId, sessionId),
						eq(providerInteractions.status, "pending"),
					),
				);
		} else if (executable && controlBinding && controlBinding.stopState !== "active") {
			throw new Error("opencode_session_stopping");
		}
		if (kind === "opencode_fork") {
			const [instance] = await tx
				.select()
				.from(providerInstances)
				.where(eq(providerInstances.id, binding.instanceId ?? ""));
			// This slice forks the INSTANCE's launching session only.
			if (!instance || instance.sessionId !== sessionId)
				throw new Error("opencode_fork_child_source_unsupported");
			if (
				input.forkPointMessageId !== undefined &&
				input.forkPointMessageId !== null &&
				(typeof input.forkPointMessageId !== "string" ||
					!/^msg_[A-Za-z0-9_-]{1,180}$/.test(input.forkPointMessageId))
			)
				throw new Error("opencode_fork_point_invalid");
			if (
				input.childDisplayName !== undefined &&
				(typeof input.childDisplayName !== "string" || input.childDisplayName.length > 120)
			)
				throw new Error("opencode_fork_label_invalid");
			forkRequestHash = createHash("sha256")
				.update(
					JSON.stringify({
						version: 1,
						sessionId,
						instanceId: binding.instanceId,
						generation: binding.generation,
						nativeSessionId: binding.nativeSessionId,
						forkPointMessageId:
							typeof input.forkPointMessageId === "string" ? input.forkPointMessageId : null,
						childDisplayName:
							typeof input.childDisplayName === "string" && input.childDisplayName.trim()
								? input.childDisplayName.trim()
								: "分支",
					}),
				)
				.digest("hex");
		}
		if (kind !== "interaction_response") {
			const queued = await tx
				.select()
				.from(controlActions)
				.where(
					and(
						eq(controlActions.sessionId, sessionId),
						inArray(controlActions.status, ["queued", "running"]),
					),
				);
			if (kind === "opencode_fork") {
				const key = typeof input.idempotencyKey === "string" ? input.idempotencyKey : null;
				if (key) {
					const [existing] = await tx
						.select()
						.from(controlActions)
						.where(
							and(
								eq(controlActions.actionType, "opencode_fork"),
								eq(controlActions.idempotencyKey, key),
								sql`COALESCE(${controlActions.requestedByUserId}, '') = ${actor.userId ?? ""}`,
							),
						)
						.limit(1);
					if (existing) {
						const stored = (existing.metadata as Record<string, unknown> | null)?.forkRequestHash;
						if (stored !== forkRequestHash)
							throw new Error("opencode_fork_idempotency_conflict");
						return existing;
					}
				} else if (
					queued.some((row: typeof controlActions.$inferSelect) => row.actionType === "opencode_fork")
				) {
					// No key: never borrow another request's action.
					throw new Error("opencode_fork_busy");
				}
			} else if (kind !== "prompt") {
				const existing = queued.find(
					(row: typeof controlActions.$inferSelect) => row.actionType === kind,
				);
				if (existing) return existing;
			}
			if (
				queued.filter((row: typeof controlActions.$inferSelect) => row.actionType === "prompt")
					.length >= 4 &&
				kind === "prompt"
			)
				throw new Error("opencode_prompt_queue_full");
		}

		if (kind === "interrupt")
			await tx
				.update(controlActions)
				.set({
					status: "failed",
					error: "opencode_prompt_cancelled_before_delivery",
					finishedAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
				})
				.where(
					and(
						eq(controlActions.sessionId, sessionId),
						eq(controlActions.actionType, "prompt"),
						eq(controlActions.status, "queued"),
					),
				);
		let interaction: typeof providerInteractions.$inferSelect | undefined;
		if (kind === "interaction_response") {
			if (input.decision === "always") throw new Error("permission_decision_not_allowed");
			[interaction] = await tx
				.select()
				.from(providerInteractions)
				.where(
					and(
						eq(providerInteractions.id, String(input.interactionId)),
						eq(providerInteractions.sessionId, sessionId),
					),
				);
			if (
				!interaction ||
				interaction.instanceId !== binding.instanceId ||
				interaction.generation !== binding.generation ||
				interaction.status !== "pending" ||
				interaction.revision !== input.revision ||
				Date.parse(interaction.expiresAt) <= Date.now()
			)
				throw new Error("interaction_stale_or_answered");
			if (interaction.kind === "permission" && !["once", "reject"].includes(String(input.decision)))
				throw new Error("permission_decision_not_allowed");
			if (interaction.kind === "question" && input.decision !== "reject") {
				const questions = interaction.payload.questions;
				if (
					!Array.isArray(input.answers) ||
					!Array.isArray(questions) ||
					input.answers.length !== questions.length ||
					input.answers.some(
						(a) =>
							!Array.isArray(a) ||
							a.length === 0 ||
							a.length > 50 ||
							a.some((v) => typeof v !== "string" || v.length > 10000),
					)
				)
					throw new Error("invalid_question_answers");
				const answers = input.answers as string[][];
				for (let index = 0; index < answers.length; index++) {
					const question = object(questions[index]);
					const labels = Array.isArray(question.options)
						? question.options.map((option) => String(object(option).label))
						: [];
					if (
						new Set(answers[index]).size !== answers[index].length ||
						(!question.multiple && answers[index].length > 1) ||
						(question.custom === false && answers[index].some((value) => !labels.includes(value)))
					)
						throw new Error("invalid_question_answers");
				}
			}
		}
		const actionId = crypto.randomUUID();
		if (interaction) {
			const claimed = await tx
				.update(providerInteractions)
				.set({
					status: "answering",
					actionId,
					answeredBy: actor.userId ?? actor.label,
					updatedAt: new Date().toISOString(),
				})
				.where(
					and(
						eq(providerInteractions.id, interaction.id),
						eq(providerInteractions.status, "pending"),
					),
				)
				.returning();
			if (!claimed.length) throw new Error("interaction_stale_or_answered");
		}
		if (
			kind === "prompt" &&
			(typeof input.prompt !== "string" || !input.prompt.trim() || input.prompt.length > 12000)
		)
			throw new Error("invalid_prompt");
		if (kind === "opencode_command") {
			if (typeof input.command !== "string" || !/^[a-zA-Z0-9_-]+$/.test(input.command))
				throw new Error("opencode_invalid_command");
			// Server-side source policy: the name must exist in this session's
			// own stored catalog as a native custom command (source=command).
			const [catalogRow] = await getDb()
				.select({ metadata: sessions.metadata })
				.from(sessions)
				.where(eq(sessions.sessionId, sessionId))
				.limit(1);
			const catalog = (
				catalogRow?.metadata as { opencodeCatalog?: { commands?: { name: string }[] } } | undefined
			)?.opencodeCatalog;
			const listed = (catalog?.commands ?? []).some((entry) => entry.name === input.command);
			if (!listed) throw new Error("opencode_invalid_command");
			if (
				input.arguments !== undefined &&
				(typeof input.arguments !== "string" || input.arguments.length > 2000)
			)
				throw new Error("opencode_invalid_command");
		}
		if (kind === "opencode_fork") {
			const [instance] = await tx
				.select()
				.from(providerInstances)
				.where(eq(providerInstances.id, binding.instanceId ?? ""));
			// This slice forks the INSTANCE's launching session only; a child as
			// a copy source is not supported yet.
			if (!instance || instance.sessionId !== sessionId)
				throw new Error("opencode_fork_child_source_unsupported");
			if (
				input.forkPointMessageId !== undefined &&
				input.forkPointMessageId !== null &&
				(typeof input.forkPointMessageId !== "string" ||
					!/^msg_[A-Za-z0-9_-]{1,180}$/.test(input.forkPointMessageId))
			)
				throw new Error("opencode_fork_point_invalid");
			if (
				input.childDisplayName !== undefined &&
				(typeof input.childDisplayName !== "string" || input.childDisplayName.length > 120)
			)
				throw new Error("opencode_fork_label_invalid");
		}
		if (kind === "opencode_command" && input.model !== undefined) {
			const model = input.model as { providerID?: unknown; modelID?: unknown } | null;
			if (
				model === null ||
				typeof model !== "object" ||
				typeof model.providerID !== "string" ||
				typeof model.modelID !== "string" ||
				!model.providerID ||
				!model.modelID ||
				model.providerID.length > 120 ||
				model.modelID.length > 200
			)
				throw new Error("invalid_prompt_model");
		}
		if (
			kind === "opencode_command" &&
			input.agent !== undefined &&
			(input.agent === null || typeof input.agent !== "string" || input.agent.length > 120)
		)
			throw new Error("invalid_prompt_agent");
		if (kind === "prompt" && input.model !== undefined) {
			const model = input.model as { providerID?: unknown; modelID?: unknown } | null;
			if (
				model === null ||
				typeof model !== "object" ||
				typeof model.providerID !== "string" ||
				typeof model.modelID !== "string" ||
				!model.providerID ||
				!model.modelID ||
				model.providerID.length > 120 ||
				model.modelID.length > 200
			)
				throw new Error("invalid_prompt_model");
		}
		if (
			kind === "prompt" &&
			input.agent !== undefined &&
			(input.agent === null || typeof input.agent !== "string" || input.agent.length > 120)
		)
			throw new Error("invalid_prompt_agent");
		const [instanceForFork] =
			kind === "opencode_fork"
				? await tx
						.select()
						.from(providerInstances)
						.where(eq(providerInstances.id, binding.instanceId ?? ""))
				: [];
		const forkMetadata =
			kind === "opencode_fork"
				? {
						instanceOriginSessionId: instanceForFork?.sessionId ?? "",
						directParentSessionId: sessionId,
						childDisplayName:
							typeof input.childDisplayName === "string" && input.childDisplayName.trim()
								? input.childDisplayName.trim()
								: "分支",
						...(typeof input.forkPointMessageId === "string"
							? { forkPointMessageId: input.forkPointMessageId }
							: {}),
					}
				: {};
		const forkIdempotencyKey =
			kind === "opencode_fork" && typeof input.idempotencyKey === "string"
				? input.idempotencyKey
				: null;
		const [action] = await tx
			.insert(controlActions)
			.values({
				id: actionId,
				sessionId,
				actionType: kind,
				requestedBy: actor.label,
				requestedByUserId: actor.userId,
				...(forkIdempotencyKey ? { idempotencyKey: forkIdempotencyKey } : {}),
				metadata: {
					agentType: "opencode",
					instanceId: binding.instanceId,
					generation: binding.generation,
					// A6 addressing: the RESOLVED binding's native session id —
					// a fork child's action names the child, not the parent.
					nativeSessionId: binding.nativeSessionId,
					...(kind === "prompt"
						? {
								prompt: input.prompt,
								...(input.model ? { model: input.model } : {}),
								...(input.agent ? { agent: input.agent } : {}),
							}
						: {}),
					...(kind === "opencode_command"
						? {
								command: input.command,
								arguments: input.arguments ?? "",
								...(input.model ? { model: input.model } : {}),
								...(input.agent ? { agent: input.agent } : {}),
							}
						: {}),
					...(interaction
						? {
								interactionId: interaction.id,
								nativeRequestId: interaction.nativeRequestId,
								kind: interaction.kind,
								revision: interaction.revision,
								decision: input.decision,
								answers: input.answers,
							}
						: {}),
					controlEpoch,
				...(kind === "opencode_fork" ? { ...forkMetadata, forkRequestHash } : {}),
				},
			})
			.returning();
		if (kind === "opencode_fork") {
			// The acceptance ledger row is what finalize verifies. The identity
			// (claim token etc.) is only filled in by the supervisor report.
			await tx.insert(opencodeForkRequests).values({
				actionId,
				requestHash: createHash("sha256")
					.update(
						JSON.stringify({
							sessionId,
							instanceId: binding.instanceId,
							generation: binding.generation,
							nativeSessionId: binding.nativeSessionId,
							forkPointMessageId: input.forkPointMessageId ?? null,
						}),
					)
					.digest("hex"),
				identity: null,
			});
		}
		return action;
	});
	const transaction = kind === "stop" ? withControlMutex(runTransaction) : runTransaction();
	if (kind === "opencode_fork" && typeof input.idempotencyKey === "string") {
		try {
			return await transaction;
		} catch (error) {
			// Concurrent requests race on uq_fork_action_idem: re-read and answer
			// with the winner (identical body) or a conflict (different body).
			if (!/UNIQUE constraint failed|duplicate key value/i.test(String(error))) throw error;
			const [existing] = await getDb()
				.select()
				.from(controlActions)
				.where(
					and(
						eq(controlActions.actionType, "opencode_fork"),
						eq(controlActions.idempotencyKey, input.idempotencyKey),
						sql`COALESCE(${controlActions.requestedByUserId}, '') = ${actor.userId ?? ""}`,
					),
				)
				.limit(1);
			if (!existing) throw error;
			const stored = (existing.metadata as Record<string, unknown> | null)?.forkRequestHash;
			if (stored !== forkRequestHash) throw new Error("opencode_fork_idempotency_conflict");
			return existing;
		}
	}
	return transaction;
}
export async function interruptOpenCodeInstance(
	supervisorId: string,
	instanceId: string,
	generation: number,
	state: "stopped" | "interrupted",
) {
	const [instance] = await getDb()
		.select()
		.from(providerInstances)
		.where(eq(providerInstances.id, instanceId));
	if (!instance || instance.supervisorId !== supervisorId || instance.agentType !== "opencode")
		throw new SessionControlOriginError("provider_binding_invalid");
	if (instance.generation === generation + 1 && instance.state === state) return;
	if (instance.generation !== generation || !["reserved", "running"].includes(instance.state))
		throw new SessionControlOriginError("provider_binding_invalid");
	await withTransaction(async (tx) => {
		await tx
			.update(providerInstances)
			.set({ state, generation: generation + 1 })
			.where(
				and(eq(providerInstances.id, instanceId), eq(providerInstances.generation, generation)),
			);
		await tx
			.update(providerInteractions)
			.set({ status: "interrupted", updatedAt: new Date().toISOString() })
			.where(
				and(
					eq(providerInteractions.instanceId, instanceId),
					eq(providerInteractions.generation, generation),
				),
			);
		await tx
			.update(managedSessions)
			.set({
				managedState: state === "stopped" ? "stopped" : "degraded",
				providerSyncState: state === "stopped" ? "synced" : "failed",
				providerSyncError:
					state === "interrupted"
						? "OpenCode process interrupted; old interactions invalidated."
						: null,
				activeControlActionId: null,
				controlLockExpiresAt: null,
				updatedAt: new Date().toISOString(),
			})
			.where(eq(managedSessions.sessionId, instance.sessionId));
		await tx
			.update(controlActions)
			.set({
				status: "failed",
				error: "opencode_process_interrupted",
				finishedAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			})
			.where(
				and(
					eq(controlActions.sessionId, instance.sessionId),
					inArray(controlActions.status, ["queued", "running"]),
				),
			);
		await tx
			.update(sessions)
			.set({
				isWorking: false,
				status: "idle",
				metadata: metadataSetSql({
					permissionWait: { ids: [], anon: 0 },
					opencodeManaged: { state, generation: generation + 1, pending: 0 },
				}),
			})
			.where(eq(sessions.sessionId, instance.sessionId));
	});
	const [updated] = await getDb()
		.select()
		.from(sessions)
		.where(eq(sessions.sessionId, instance.sessionId));
	if (updated) notifySessionUpdated(updated);
}

async function persistManagedChildren(
	instance: { id: string; sessionId: string; cwd: string; generation: number; state: string },
	children: { session: Json; messages: unknown[] }[],
	interrupted: boolean,
) {
	for (const child of children) {
		const nativeId = String(child.session.id);
		const sessionId = `${instance.sessionId}:opencode-child:${nativeId}`;
		const changed = await withTransaction(async (tx) => {
			const fence = await tx
				.update(providerInstances)
				.set({ protocolVersion: "1.18.35" })
				.where(
					and(
						eq(providerInstances.id, instance.id),
						eq(providerInstances.generation, instance.generation),
						eq(providerInstances.state, instance.state),
					),
				)
				.returning();
			if (!fence.length) throw new SessionControlOriginError("provider_binding_invalid");
			const [root] = await tx
				.select()
				.from(sessions)
				.where(eq(sessions.sessionId, instance.sessionId));
			const parentId = String(child.session.parentID);
			await tx
				.insert(sessions)
				.values({
					sessionId,
					agentType: "opencode",
					cwd: instance.cwd,
					displayName: String(child.session.title ?? "OpenCode sub-session"),
					ownerUserId: root.ownerUserId,
					status: "idle",
					metadata: {
						opencode: {
							instanceId: instance.id,
							nativeSessionId: nativeId,
							nativeParentId: parentId,
							parentSessionId: children.some((other) => other.session.id === parentId)
								? `${instance.sessionId}:opencode-child:${parentId}`
								: instance.sessionId,
							managedChildObservedOnly: true,
						},
					},
				})
				.onConflictDoNothing({ target: sessions.sessionId });
			await recordExternalOpenCodeSession(sessionId, tx);
			const changedRows = [];
			for (const message of child.messages) {
				const record = object(message);
				const info = object(record.info);
				if (
					info.sessionID !== nativeId ||
					typeof info.id !== "string" ||
					!Array.isArray(record.parts)
				)
					continue;
				for (const value of record.parts) {
					let part = object(value);
					if (
						part.sessionID !== nativeId ||
						part.messageID !== info.id ||
						typeof part.id !== "string"
					)
						continue;
					if (
						interrupted &&
						part.type === "tool" &&
						["running", "pending"].includes(String(object(part.state).status))
					)
						part = {
							...part,
							state: {
								...object(part.state),
								status: "error",
								error: "OpenCode process interrupted; native tool completion unconfirmed.",
							},
						};
					const created = Number(object(info.time).created) || Date.now();
					const source = {
						id: String(info.id),
						session_id: nativeId,
						data: JSON.stringify(info),
						time_created: created,
						time_updated: Number(object(info.time).completed) || created,
					};
					const event = normalizeOpenCodePart(
						{ ...source, id: String(part.id), message_id: source.id, data: JSON.stringify(part) },
						source,
					);
					if (!event) continue;
					const dedupKey = `opencode-managed:${part.id}`;
					const [before] = await tx
						.select()
						.from(events)
						.where(and(eq(events.sessionId, sessionId), eq(events.dedupKey, dedupKey)));
					if (before?.rawPayload?.observer_fingerprint === event.rawPayload.observer_fingerprint)
						continue;
					const row = {
						...event,
						source: "managed_control",
						dedupKey,
						createdAt: new Date(created).toISOString(),
					};
					const rows = await tx
						.insert(events)
						.values({ ...row, sessionId })
						.onConflictDoUpdate({ target: [events.sessionId, events.dedupKey], set: row })
						.returning();
					changedRows.push(...rows);
				}
			}
			const [tools] = await tx
				.select({ count: sql<number>`count(*)` })
				.from(events)
				.where(and(eq(events.sessionId, sessionId), eq(events.category, "tool_event")));
			await tx
				.update(sessions)
				.set({
					totalToolUses: Number(tools?.count ?? 0),
					...(changedRows.length ? { lastActivityAt: new Date().toISOString() } : {}),
				})
				.where(eq(sessions.sessionId, sessionId));
			return changedRows;
		});
		const [row] = await getDb().select().from(sessions).where(eq(sessions.sessionId, sessionId));
		notifySessionUpdated(row);
		notifySessionEvents(sessionId, toSessionEventDtos(changed));
	}
}
