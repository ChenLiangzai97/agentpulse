/** P1 provenance foundation. No route can issue an instance/binding from session metadata. */
import { and, eq } from "drizzle-orm";
import type { Actor } from "../auth/actor.js";
import { getDb } from "../db/client.js";
import {
	controlActions,
	launchRequests,
	managedSessions,
	opencodeForkRequests,
	opencodeForks,
	providerInstances,
	sessionControlBindings,
	sessions,
	supervisors,
} from "../db/schema/index.js";
import { withTransaction } from "../db/with-transaction.js";
import { assertCanEditSessionNotes } from "./authorization.js";

export class SessionControlOriginError extends Error {
	constructor(
		readonly code:
			| "session_observe_only"
			| "opencode_control_not_enabled"
			| "provider_binding_invalid",
		readonly status: 403 | 409 = 403,
	) {
		super(code);
	}
}

/** Trusted observation writers can mark external provenance, never promote or rewrite it. */
export async function recordExternalOpenCodeSession(sessionId: string, db = getDb()) {
	await db
		.insert(sessionControlBindings)
		.values({ sessionId, origin: "external_observer" })
		.onConflictDoNothing({ target: sessionControlBindings.sessionId });
	const [binding] = await db
		.select()
		.from(sessionControlBindings)
		.where(eq(sessionControlBindings.sessionId, sessionId));
	if (binding?.origin === "agentpulse_launch")
		throw new SessionControlOriginError("provider_binding_invalid");
}

/** Future P2 launcher entry: only an already-claimed, server-created NEW launch can reserve. */
export async function reserveOpenCodeInstance(supervisorId: string, launchId: string) {
	return withTransaction(async (tx) => {
		const [launch] = await tx.select().from(launchRequests).where(eq(launchRequests.id, launchId));
		const [host] = await tx.select().from(supervisors).where(eq(supervisors.id, supervisorId));
		if (
			!launch ||
			!host ||
			launch.agentType !== "opencode" ||
			launch.requestedLaunchMode !== "managed_opencode" ||
			launch.claimedBySupervisorId !== supervisorId ||
			(launch.requestedSupervisorId && launch.requestedSupervisorId !== supervisorId) ||
			!["queued", "claimed", "launching"].includes(launch.status) ||
			launch.metadata?.boundExistingSession
		)
			throw new SessionControlOriginError("provider_binding_invalid");
		const [existing] = await tx
			.select()
			.from(sessions)
			.where(eq(sessions.sessionId, launch.launchCorrelationId));
		const [bound] = await tx
			.select()
			.from(sessionControlBindings)
			.where(eq(sessionControlBindings.sessionId, launch.launchCorrelationId));
		if (existing || bound) throw new SessionControlOriginError("session_observe_only");
		const [instance] = await tx
			.insert(providerInstances)
			.values({
				agentType: "opencode",
				supervisorId,
				launchRequestId: launch.id,
				sessionId: launch.launchCorrelationId,
				cwd: launch.cwd,
			})
			.returning();
		return instance;
	});
}

/** Native ID comes from the authenticated future provider report, never hook/observer metadata. */
export async function bindCreatedOpenCodeSession(
	supervisorId: string,
	instanceId: string,
	nativeSessionId: string,
	generation: number,
) {
	if (!/^ses_[A-Za-z0-9_-]{1,180}$/.test(nativeSessionId))
		throw new SessionControlOriginError("provider_binding_invalid");
	return withTransaction(async (tx) => {
		const [instance] = await tx
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
		const [session] = await tx
			.select()
			.from(sessions)
			.where(eq(sessions.sessionId, instance.sessionId));
		const [managed] = await tx
			.select()
			.from(managedSessions)
			.where(eq(managedSessions.sessionId, instance.sessionId));
		const [launch] = await tx
			.select()
			.from(launchRequests)
			.where(eq(launchRequests.id, instance.launchRequestId));
		const [before] = await tx
			.select()
			.from(sessionControlBindings)
			.where(eq(sessionControlBindings.sessionId, instance.sessionId));
		if (
			before &&
			(before.origin !== "agentpulse_launch" ||
				before.instanceId !== instanceId ||
				before.nativeSessionId !== nativeSessionId)
		)
			throw new SessionControlOriginError("session_observe_only");
		if (
			!session ||
			session.agentType !== "opencode" ||
			session.cwd !== instance.cwd ||
			!managed ||
			managed.supervisorId !== supervisorId ||
			managed.launchRequestId !== instance.launchRequestId ||
			managed.providerSessionId !== nativeSessionId ||
			!launch ||
			launch.agentType !== "opencode" ||
			launch.requestedLaunchMode !== "managed_opencode" ||
			launch.launchCorrelationId !== session.sessionId ||
			launch.claimedBySupervisorId !== supervisorId ||
			launch.metadata?.boundExistingSession
		)
			throw new SessionControlOriginError("provider_binding_invalid");
		if (before) {
			await tx
				.update(sessionControlBindings)
				.set({ generation })
				.where(eq(sessionControlBindings.sessionId, instance.sessionId));
		} else {
			await tx.insert(sessionControlBindings).values({
				sessionId: instance.sessionId,
				origin: "agentpulse_launch",
				instanceId,
				nativeSessionId,
				generation,
			});
		}
		await tx
			.update(providerInstances)
			.set({ state: "running" })
			.where(eq(providerInstances.id, instanceId));
		return { sessionId: instance.sessionId, instanceId, generation };
	});
}

/** CAS generation advance invalidates old bindings; recovery must re-verify before binding again. */
export async function advanceOpenCodeGeneration(
	supervisorId: string,
	instanceId: string,
	expectedGeneration: number,
) {
	const rows = await getDb()
		.update(providerInstances)
		.set({ generation: expectedGeneration + 1, state: "reserved" })
		.where(
			and(
				eq(providerInstances.id, instanceId),
				eq(providerInstances.supervisorId, supervisorId),
				eq(providerInstances.generation, expectedGeneration),
			),
		)
		.returning();
	if (!rows.length) throw new SessionControlOriginError("provider_binding_invalid");
	return rows[0];
}

/**
 * Shared trusted-fork-child validation (single source of truth for A1 and A3).
 * A child binding is trusted ONLY when the 0015 ledger ties the trusted fork
 * CREATION to this exact instance + native child identity + generation, the
 * execution ledger (opencode_fork_requests) has the action row, and the
 * instance's parent-domain launch invariants hold. The parent SESSION row may
 * be deleted — instance/launch association must survive that.
 *
 * Returns null when trusted, or a machine reason when not.
 */
export async function trustedForkChildIssue(params: {
	childSessionId: string;
	bindingInstanceId: string | null;
	bindingNativeSessionId: string | null;
	bindingGeneration: number | null;
	instance: {
		id: string;
		generation: number;
		supervisorId: string;
		launchRequestId: string;
		sessionId: string;
	};
	snapshotNativeSessionId?: string;
}): Promise<null | string> {
	const { childSessionId, bindingInstanceId, bindingNativeSessionId, bindingGeneration } = params;
	const { instance } = params;
	const [ledger] = await getDb()
		.select()
		.from(opencodeForks)
		.where(eq(opencodeForks.childSessionId, childSessionId))
		.limit(1);
	if (!ledger) return "no_fork_ledger";
	if (!ledger.requestActionId) return "fork_ledger_without_action";
	if (ledger.providerInstanceId !== instance.id) return "fork_ledger_instance_mismatch";
	if (ledger.providerInstanceId !== bindingInstanceId)
		return "fork_ledger_binding_instance_mismatch";
	if (!ledger.nativeSessionId || ledger.nativeSessionId !== bindingNativeSessionId)
		return "fork_ledger_native_mismatch";
	if (params.snapshotNativeSessionId && ledger.nativeSessionId !== params.snapshotNativeSessionId)
		return "fork_ledger_snapshot_native_mismatch";
	if (ledger.generation === null || ledger.generation !== bindingGeneration)
		return "fork_ledger_generation_mismatch";
	if (ledger.generation !== instance.generation) return "fork_ledger_instance_generation_mismatch";
	// FULL creation chain (review round 41): the fork ACTION must be a real,
	// SUCCEEDED opencode_fork on this child, whose execution ledger row carries
	// a NON-EMPTY pinned parent snapshot and whose recorded target agrees with
	// the lineage (parent session, instance, generation). A bare lineage row or
	// an action without the pinned snapshot is not a trusted creation.
	const [request] = await getDb()
		.select()
		.from(opencodeForkRequests)
		.where(eq(opencodeForkRequests.actionId, ledger.requestActionId))
		.limit(1);
	if (!request) return "fork_request_missing";
	const identity = (request.identity ?? null) as Record<string, unknown> | null;
	// The creation identity must be COMPLETE and SELF-SUFFICIENT (review round
	// 43): it is the single immutable evidence used before AND after the
	// parent is deleted, and it must record the FINALIZED SUCCESS RESULT — a
	// queued/failed/unknown fork whose action later disappears with the parent
	// must still be refused. Action metadata is never used to fill gaps; if it
	// contradicts the identity, the child is rejected.
	if (!identity) return "fork_request_identity_missing";
	const [action] = await getDb()
		.select()
		.from(controlActions)
		.where(eq(controlActions.id, ledger.requestActionId))
		.limit(1);
	if (identity.version !== 1) return "fork_request_identity_schema";
	// Two distinct anchors: instance ORIGIN vs DIRECT PARENT.
	const instanceOriginSessionId = identity.instanceOriginSessionId;
	const directParentSessionId = identity.directParentSessionId;
	const parentNative = identity.parentNativeSessionId;
	const identityInstanceId = identity.providerInstanceId;
	const identityGeneration = identity.generation;
	if (typeof instanceOriginSessionId !== "string" || !instanceOriginSessionId)
		return "fork_request_identity_schema";
	if (typeof directParentSessionId !== "string" || !directParentSessionId)
		return "fork_request_identity_schema";
	if (typeof parentNative !== "string" || !parentNative) return "fork_request_identity_schema";
	if (typeof identityInstanceId !== "string" || !identityInstanceId)
		return "fork_request_identity_schema";
	if (typeof identityGeneration !== "number" || identityGeneration <= 0)
		return "fork_request_identity_schema";
	if (instanceOriginSessionId !== instance.sessionId) return "fork_action_instance_origin_mismatch";
	if (identityInstanceId !== instance.id) return "fork_action_instance_mismatch";
	if (identityGeneration !== ledger.generation) return "fork_action_generation_mismatch";
	// DIRECT PARENT anchor must agree with the lineage (when the lineage still
	// names it; NULL after parent deletion is expected).
	if (ledger.parentSessionId !== null && ledger.parentSessionId !== directParentSessionId)
		return "fork_ledger_parent_mismatch";
	// FINALIZED SUCCESS RESULT: the ledger must carry the confirmed result, with
	// the child identity/instance/generation it produced.
	const result = (identity.result ?? null) as Record<string, unknown> | null;
	if (!result) return "fork_result_missing";
	if (result.status !== "succeeded") return "fork_result_not_succeeded";
	if (result.childSessionId !== childSessionId) return "fork_result_child_mismatch";
	if (result.childNativeSessionId !== ledger.nativeSessionId)
		return "fork_result_child_native_mismatch";
	if (result.providerInstanceId !== instance.id) return "fork_result_instance_mismatch";
	if (result.generation !== ledger.generation) return "fork_result_generation_mismatch";
	if (typeof result.confirmedAt !== "string" || !result.confirmedAt)
		return "fork_result_unconfirmed";
	// Defense in depth: a SURVIVING action must agree with the immutable
	// identity; any contradiction rejects.
	if (action) {
		if (action.actionType !== "opencode_fork") return "fork_action_not_fork";
		if (action.status !== "succeeded") return "fork_action_not_succeeded";
		if (action.sessionId !== directParentSessionId) return "fork_action_request_target_mismatch";
		const meta = (action.metadata ?? {}) as Record<string, unknown>;
		if (
			meta.instanceOriginSessionId !== undefined &&
			meta.instanceOriginSessionId !== instanceOriginSessionId
		)
			return "fork_action_identity_contradiction";
		if (
			meta.directParentSessionId !== undefined &&
			meta.directParentSessionId !== directParentSessionId
		)
			return "fork_action_identity_contradiction";
		if (meta.nativeSessionId !== undefined && meta.nativeSessionId !== parentNative)
			return "fork_action_identity_contradiction";
		if (meta.providerInstanceId !== undefined && meta.providerInstanceId !== identityInstanceId)
			return "fork_action_identity_contradiction";
		if (meta.generation !== undefined && meta.generation !== identityGeneration)
			return "fork_action_identity_contradiction";
	}
	// Direct parent's NATIVE identity: while the parent exists its binding must
	// agree; after deletion the immutable label must. The snapshot must agree
	// with the same identity.
	const [parentBinding] = await getDb()
		.select()
		.from(sessionControlBindings)
		.where(eq(sessionControlBindings.sessionId, directParentSessionId))
		.limit(1);
	if (parentBinding) {
		if (parentBinding.instanceId !== instance.id) return "fork_parent_binding_instance_mismatch";
		if (parentBinding.nativeSessionId !== parentNative)
			return "fork_parent_binding_native_mismatch";
	} else {
		const label = (ledger.parentLabel ?? {}) as Record<string, unknown>;
		if (label.directParentSessionId !== directParentSessionId) return "fork_parent_label_missing";
		if (label.parentNativeSessionId !== parentNative) return "fork_parent_label_native_mismatch";
	}
	const snapshot = request.parentSnapshot as Record<string, unknown> | null;
	if (!snapshot) return "fork_request_snapshot_missing";
	if (snapshot.version !== 1) return "fork_request_snapshot_schema";
	if (snapshot.instanceId !== instance.id) return "fork_request_snapshot_instance_mismatch";
	if (snapshot.nativeSessionId !== parentNative) return "fork_request_snapshot_native_mismatch";
	if (!Array.isArray(snapshot.messages)) return "fork_request_snapshot_schema";
	for (const entry of snapshot.messages as unknown[]) {
		const message = entry as Record<string, unknown> | null;
		if (
			!message ||
			typeof message !== "object" ||
			typeof message.nativeId !== "string" ||
			!message.nativeId
		)
			return "fork_request_snapshot_schema";
		if (message.contentHash !== undefined && typeof message.contentHash !== "string")
			return "fork_request_snapshot_schema";
	}
	// parent-domain invariants on the INSTANCE (parent session row may be gone)
	const [launch] = await getDb()
		.select()
		.from(launchRequests)
		.where(eq(launchRequests.id, instance.launchRequestId))
		.limit(1);
	if (!launch) return "launch_missing";
	if (launch.agentType !== "opencode") return "launch_not_opencode";
	if (launch.requestedLaunchMode !== "managed_opencode") return "launch_not_managed";
	if (launch.launchCorrelationId !== instance.sessionId) return "launch_parent_domain_mismatch";
	if (launch.claimedBySupervisorId !== instance.supervisorId) return "launch_claim_mismatch";
	if (launch.metadata?.boundExistingSession) return "launch_bound_existing_session";
	return null;
}

/**
 * Enumerate the fork children of an instance that pass the SAME trusted-
 * creation proof used for authorization. This is the ONLY source the
 * supervisor may use to poll child native sessions: a native session that is
 * merely discovered in a parent snapshot is never included here.
 */
export async function trustedOpenCodeForkChildren(instance: {
	id: string;
	generation: number;
	supervisorId: string;
	launchRequestId: string;
	sessionId: string;
}): Promise<{ sessionId: string; nativeSessionId: string }[]> {
	const bindings = await getDb()
		.select()
		.from(sessionControlBindings)
		.where(
			and(
				eq(sessionControlBindings.instanceId, instance.id),
				eq(sessionControlBindings.generation, instance.generation),
			),
		);
	const children: { sessionId: string; nativeSessionId: string }[] = [];
	for (const binding of bindings) {
		if (
			binding.origin !== "agentpulse_launch" ||
			!binding.nativeSessionId ||
			binding.sessionId === instance.sessionId
		)
			continue;
		const issue = await trustedForkChildIssue({
			childSessionId: binding.sessionId,
			bindingInstanceId: binding.instanceId,
			bindingNativeSessionId: binding.nativeSessionId,
			bindingGeneration: binding.generation,
			instance,
		});
		if (issue === null)
			children.push({ sessionId: binding.sessionId, nativeSessionId: binding.nativeSessionId });
	}
	return children;
}

export async function inspectOpenCodeProvenance(sessionId: string) {
	const [session] = await getDb().select().from(sessions).where(eq(sessions.sessionId, sessionId));
	const [binding] = await getDb()
		.select()
		.from(sessionControlBindings)
		.where(eq(sessionControlBindings.sessionId, sessionId));
	if (session?.agentType !== "opencode" && !binding) return null;
	if (!binding || binding.origin !== "agentpulse_launch")
		return {
			origin: binding?.origin ?? "legacy_unknown",
			bindingValid: false,
			reason: "session_observe_only" as const,
		};
	const [instance] = await getDb()
		.select()
		.from(providerInstances)
		.where(eq(providerInstances.id, binding.instanceId ?? ""));
	const [managed] = await getDb()
		.select()
		.from(managedSessions)
		.where(eq(managedSessions.sessionId, sessionId));
	const [launch] = instance
		? await getDb()
				.select()
				.from(launchRequests)
				.where(eq(launchRequests.id, instance.launchRequestId))
		: [];
	// A1 binding-as-authority (fork design §A1) — EXPLICIT identity branches.
	// The provider instance is the PROCESS authority. Identity decides which
	// path applies; a failure in one path NEVER falls through to the other:
	//
	//  • PARENT path — this session IS the instance's launching session
	//    (instance.sessionId === sessionId). The original checks apply
	//    verbatim: managed launch origin, claim, correlation id, generation,
	//    cwd, supervisor agreement. A failure here is a failure — no
	//    downgrade.
	//
	//  • CHILD path — a fork child on the same instance. It requires a
	//    TRUSTED fork creation record (the 0015 opencode_forks ledger).
	//    Until that ledger ships, the child path is CLOSED: no binding-only
	//    shortcut exists. When it opens, it will verify the ledger row for
	//    THIS session (child_session_id), the instance's managed launch
	//    origin (parent-scoped launch checks), supervisor and generation.
	const isInstanceLaunchingSession =
		instance?.agentType === "opencode" && instance.sessionId === sessionId;
	// Child path: a fork child on the SAME instance, with a TRUSTED ledger row
	// naming THIS session as the child. Verified below (async) — the parent-
	// scoped launch checks still apply to the INSTANCE (managed_opencode etc.),
	// and the child's own managed row must agree on supervisor + native id.
	const childTrustIssue =
		!isInstanceLaunchingSession && instance && binding.instanceId
			? await trustedForkChildIssue({
					childSessionId: sessionId,
					bindingInstanceId: binding.instanceId,
					bindingNativeSessionId: binding.nativeSessionId,
					bindingGeneration: binding.generation,
					instance: {
						id: instance.id,
						generation: instance.generation,
						supervisorId: instance.supervisorId,
						launchRequestId: instance.launchRequestId,
						sessionId: instance.sessionId,
					},
				})
			: "not_a_child_candidate";
	const childPathValid = Boolean(
		childTrustIssue === null &&
			session?.agentType === "opencode" &&
			instance?.agentType === "opencode" &&
			instance.sessionId !== sessionId &&
			instance.generation === binding.generation &&
			(instance.state === "running" || instance.state === "reserved") &&
			session.cwd === instance.cwd &&
			managed?.supervisorId === instance.supervisorId &&
			managed?.providerSessionId === binding.nativeSessionId,
	);
	const parentPathValid = Boolean(
		isInstanceLaunchingSession &&
			session?.agentType === "opencode" &&
			instance?.agentType === "opencode" &&
			instance.generation === binding.generation &&
			instance.state === "running" &&
			session.cwd === instance.cwd &&
			managed?.supervisorId === instance.supervisorId &&
			managed?.launchRequestId === instance.launchRequestId &&
			managed?.providerSessionId === binding.nativeSessionId &&
			launch?.agentType === "opencode" &&
			launch.requestedLaunchMode === "managed_opencode" &&
			launch.launchCorrelationId === sessionId &&
			launch.claimedBySupervisorId === instance.supervisorId &&
			!launch.metadata?.boundExistingSession,
	);
	const valid = parentPathValid || childPathValid;
	return {
		origin: binding.origin,
		bindingValid: valid,
		reason: valid
			? ("opencode_control_not_enabled" as const)
			: ("provider_binding_invalid" as const),
	};
}

/** Shared gate for REST, service/AI paths and future callers. P1 deliberately enables no controls. */
export async function assertSessionControlOrigin(sessionId: string, actor?: Actor) {
	const provenance = await inspectOpenCodeProvenance(sessionId);
	if (!provenance) return;
	if (actor) await assertCanEditSessionNotes(actor, sessionId);
	if (provenance.bindingValid) return;
	throw new SessionControlOriginError(
		provenance.reason,
		provenance.reason === "opencode_control_not_enabled" ? 409 : 403,
	);
}

/** Authenticated report bootstrap: a claimed NEW launch reservation is the sole authority. */
export async function validateOpenCodeReport(
	supervisorId: string,
	input: {
		sessionId: string;
		launchRequestId?: string | null;
		cwd?: string | null;
		providerSessionId?: string | null;
		providerInstanceId?: string;
		providerGeneration?: number;
	},
) {
	const [instance] = await getDb()
		.select()
		.from(providerInstances)
		.where(eq(providerInstances.id, input.providerInstanceId ?? ""));
	const [binding] = await getDb()
		.select()
		.from(sessionControlBindings)
		.where(eq(sessionControlBindings.sessionId, input.sessionId));
	const [session] = await getDb()
		.select()
		.from(sessions)
		.where(eq(sessions.sessionId, input.sessionId));
	if (binding && binding.origin !== "agentpulse_launch")
		throw new SessionControlOriginError("session_observe_only");
	if (session && !binding) throw new SessionControlOriginError("session_observe_only");
	const [launch] = instance
		? await getDb()
				.select()
				.from(launchRequests)
				.where(eq(launchRequests.id, instance.launchRequestId))
		: [];
	if (
		!instance ||
		instance.agentType !== "opencode" ||
		instance.supervisorId !== supervisorId ||
		instance.sessionId !== input.sessionId ||
		instance.generation !== input.providerGeneration ||
		!["reserved", "running"].includes(instance.state) ||
		instance.launchRequestId !== input.launchRequestId ||
		instance.cwd !== input.cwd ||
		!/^ses_[A-Za-z0-9_-]{1,180}$/.test(input.providerSessionId ?? "") ||
		!launch ||
		launch.claimedBySupervisorId !== supervisorId ||
		launch.agentType !== "opencode" ||
		launch.requestedLaunchMode !== "managed_opencode" ||
		launch.metadata?.boundExistingSession ||
		(binding &&
			(binding.instanceId !== instance.id ||
				binding.nativeSessionId !== input.providerSessionId ||
				binding.generation !== input.providerGeneration))
	)
		throw new SessionControlOriginError("provider_binding_invalid");
	return instance;
}
