/** Managed OpenCode protocol boundary. Native state is scoped to a protected instance/generation. */
import { createHash } from "node:crypto";
import { and, eq, gt, inArray, ne, sql } from "drizzle-orm";
import type { Actor } from "../auth/actor.js";
import { getDb } from "../db/client.js";
import {
	events,
	controlActions,
	managedSessions,
	providerInstances,
	providerInteractions,
	sessionControlBindings,
	sessions,
} from "../db/schema/index.js";
import { withTransaction } from "../db/with-transaction.js";
import { assertCanEditSessionNotes } from "./authorization.js";
import { toSessionEventDtos } from "./event-dto.js";
import { notifySessionEvents, notifySessionUpdated } from "./notifier.js";
import {
	SessionControlOriginError,
	assertSessionControlOrigin,
	inspectOpenCodeProvenance,
	recordExternalOpenCodeSession,
} from "./opencode-control-provenance.js";
import { normalizeOpenCodePart } from "./opencode-observer.js";

type Json = Record<string, unknown>;
const object = (v: unknown): Json =>
	v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {};
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
export async function acceptOpenCodeSnapshot(
	supervisorId: string,
	instanceId: string,
	input: {
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
	const instance = await ownedOpenCodeInstance(supervisorId, instanceId, input.generation, true);
	const [binding] = await getDb()
		.select()
		.from(sessionControlBindings)
		.where(eq(sessionControlBindings.sessionId, instance.sessionId));
	if (
		binding?.origin !== "agentpulse_launch" ||
		binding.instanceId !== instanceId ||
		binding.generation !== input.generation ||
		binding.nativeSessionId !== input.nativeSessionId ||
		!Array.isArray(input.messages) ||
		!Array.isArray(input.permissions) ||
		!Array.isArray(input.questions)
	)
		throw new SessionControlOriginError("provider_binding_invalid");
	if (Array.isArray(input.commands)) {
		// Credentials must never reach the catalog: strip provider options/env
		// down to id/name plus bare model ids before persisting.
		const rawProviders = object(input.providers);
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
		await getDb()
			.update(sessions)
			.set({
				metadata: sql`json_patch(coalesce(${sessions.metadata}, '{}'), ${JSON.stringify({
					opencodeCatalog: {
						commands: input.commands.slice(0, 128).map((raw) => {
							const command = object(raw);
							return {
								name: typeof command.name === "string" ? command.name : "",
								description:
									typeof command.description === "string"
										? command.description.slice(0, 200)
										: "",
								source: typeof command.source === "string" ? command.source : "",
							};
						}),
						agents: Array.isArray(input.agents) ? input.agents.slice(0, 64) : [],
						providers: providerList,
						updatedAt: new Date().toISOString(),
					},
				})})`,
			})
			.where(eq(sessions.sessionId, instance.sessionId));
	}
	const historical = instance.generation !== input.generation;
	const interruptedReplay = historical || object(input.status).type === "interrupted";
	if (interruptedReplay) {
		input = { ...input, permissions: [], questions: [], status: { type: "idle" } };
	}
	const children: Array<{ session: Json; messages: unknown[] }> = [];
	const permittedSessions = new Set([input.nativeSessionId]);
	for (let depth = 0; depth < 64; depth++) {
		let changed = false;
		for (const child of (input.children ?? []).slice(0, 256)) {
			const session = object(child.session);
			if (
				typeof session.id !== "string" ||
				!/^ses_[A-Za-z0-9_-]+$/.test(session.id) ||
				session.directory !== instance.cwd ||
				permittedSessions.has(session.id) ||
				!permittedSessions.has(String(session.parentID))
			)
				continue;
			permittedSessions.add(session.id);
			children.push({ session, messages: Array.isArray(child.messages) ? child.messages : [] });
			changed = true;
		}
		if (!changed) break;
	}
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
			const created = Number(object(info.time).created) || Date.now();
			for (const value of message.parts) {
				let part = object(value);
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
					time_created: created,
					time_updated: Number(object(info.time).completed) || created,
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
					.where(and(eq(events.sessionId, instance.sessionId), eq(events.dedupKey, dedupKey)));
				if (before?.rawPayload?.observer_fingerprint === normalized.rawPayload.observer_fingerprint)
					continue;
				const row = {
					...normalized,
					source: "managed_control" as const,
					dedupKey,
					createdAt: new Date(created).toISOString(),
				};
				const rows = await tx
					.insert(events)
					.values({ ...row, sessionId: instance.sessionId })
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
				if (!permittedSessions.has(String(payload.sessionID)) || typeof payload.id !== "string")
					continue;
				const revision = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
				const key = `${kind}:${payload.id}`;
				pendingKeys.add(key);
				await tx
					.insert(providerInteractions)
					.values({
						sessionId: instance.sessionId,
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
		let latestUser = 0,
			latestAssistant = 0;
		for (const value of input.messages) {
			const info = object(object(value).info);
			const time = object(info.time);
			if (info.role === "user") latestUser = Math.max(latestUser, Number(time.created) || 0);
			if (info.role === "assistant") {
				latestAssistant = Math.max(latestAssistant, Number(time.completed) || 0);
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
			.where(and(eq(events.sessionId, instance.sessionId), eq(events.category, "tool_event")));
		const [session] = await tx
			.select()
			.from(sessions)
			.where(eq(sessions.sessionId, instance.sessionId));
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
				metadata: {
					...session.metadata,
					permissionWait: { ids: [...pendingKeys], anon: 0 },
					opencode: {
						...object(session.metadata?.opencode),
						instanceId,
						nativeSessionId: input.nativeSessionId,
						...usage,
					},
					opencodeManaged: { status: input.status, pending: pendingKeys.size },
				},
			})
			.where(eq(sessions.sessionId, instance.sessionId));
		return changedRows;
	});
	const [updated] = await getDb()
		.select()
		.from(sessions)
		.where(eq(sessions.sessionId, instance.sessionId));
	await persistManagedChildren(instance, children, interruptedReplay);
	notifySessionUpdated(updated);
	notifySessionEvents(instance.sessionId, toSessionEventDtos(changed));
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
export async function queueOpenCodeAction(
	sessionId: string,
	kind: "interrupt" | "stop" | "prompt" | "interaction_response" | "opencode_command",
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
	return withTransaction(async (tx) => {
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
			if (kind !== "prompt") {
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
			if (
				input.arguments !== undefined &&
				(typeof input.arguments !== "string" || input.arguments.length > 2000)
			)
				throw new Error("opencode_invalid_command");
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
		const [action] = await tx
			.insert(controlActions)
			.values({
				id: actionId,
				sessionId,
				actionType: kind,
				requestedBy: actor.label,
				requestedByUserId: actor.userId,
				metadata: {
					agentType: "opencode",
					instanceId: binding.instanceId,
					generation: binding.generation,
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
				},
			})
			.returning();
		return action;
	});
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
		const [session] = await tx
			.select()
			.from(sessions)
			.where(eq(sessions.sessionId, instance.sessionId));
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
				metadata: {
					...session?.metadata,
					permissionWait: { ids: [], anon: 0 },
					opencodeManaged: { state, generation: generation + 1, pending: 0 },
				},
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
