/** P1 provenance foundation. No route can issue an instance/binding from session metadata. */
import { and, eq } from "drizzle-orm";
import type { Actor } from "../auth/actor.js";
import { getDb } from "../db/client.js";
import {
	launchRequests,
	managedSessions,
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
	const childPathValid = false; // CLOSED until the 0015 fork ledger lands
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
