import { and, desc, eq } from "drizzle-orm";
import type { Actor } from "../auth/actor.js";
import { getDb } from "../db/client.js";
import {
	events,
	controlActions,
	launchRequests,
	managedSessions,
	sessions,
	supervisors,
} from "../db/schema/index.js";
import { withTransaction } from "../db/with-transaction.js";
import { assertCanEditSessionNotes, assertCanManageHost } from "./authorization.js";
import { mapLaunchRequest } from "./launch-validator.js";
import {
	assertSessionControlOrigin,
	inspectOpenCodeProvenance,
} from "./opencode-control-provenance.js";
import { resolveSessionOwner } from "./session-ownership.js";

/** Bind an observed native session to its enrolled host; never migrate a bound session. */
export async function bindSession(sessionId: string, supervisorId: string, actor: Actor) {
	await assertSessionControlOrigin(sessionId, actor);
	await assertCanEditSessionNotes(actor, sessionId);
	await assertCanManageHost(actor, supervisorId);
	const [session] = await getDb().select().from(sessions).where(eq(sessions.sessionId, sessionId));
	const [host] = await getDb().select().from(supervisors).where(eq(supervisors.id, supervisorId));
	if (!session || !host) throw new Error("Session or host not found");
	if (!["codex_cli", "claude_code"].includes(session.agentType))
		throw new Error("This provider is observe-only");
	if (!session.cwd) throw new Error("Session has no working directory");
	if (host.status !== "connected") throw new Error("Host is offline");
	const owner = await resolveSessionOwner(sessionId);
	if (owner && owner !== supervisorId) throw new Error("Session is already bound to another host");
	const [bound] = await getDb()
		.select()
		.from(managedSessions)
		.where(eq(managedSessions.sessionId, sessionId));
	if (bound) return bound;
	await withTransaction(async (tx) => {
		const [launch] = await tx
			.insert(launchRequests)
			.values({
				launchCorrelationId: sessionId,
				agentType: session.agentType,
				cwd: session.cwd!,
				model: session.model,
				requestedLaunchMode: session.agentType === "codex_cli" ? "managed_codex" : "headless",
				requestedSupervisorId: supervisorId,
				claimedBySupervisorId: supervisorId,
				requestedBy: actor.label,
				requestedByUserId: actor.userId,
				status: "completed",
				metadata: { boundExistingSession: true },
			})
			.returning();
		await tx.insert(managedSessions).values({
			sessionId,
			launchRequestId: launch.id,
			supervisorId,
			providerSessionId: sessionId,
			providerThreadId: session.agentType === "codex_cli" ? sessionId : null,
			managedState: "degraded",
			hostName: host.hostName,
		});
	});
	return { sessionId, supervisorId };
}

export async function queueResume(sessionId: string, actor: Actor) {
	await assertSessionControlOrigin(sessionId, actor);
	await assertCanEditSessionNotes(actor, sessionId);
	const [managed] = await getDb()
		.select()
		.from(managedSessions)
		.where(eq(managedSessions.sessionId, sessionId));
	if (!managed) throw new Error("Bind the session to a host first");
	const [launch] = await getDb()
		.select()
		.from(launchRequests)
		.where(eq(launchRequests.id, managed.launchRequestId));
	if (
		!launch ||
		launch.launchCorrelationId !== sessionId ||
		(await resolveSessionOwner(sessionId)) !==
			(launch.claimedBySupervisorId ?? launch.requestedSupervisorId)
	) {
		throw new Error("Launch does not belong to this session's host");
	}
	const [action] = await getDb()
		.insert(controlActions)
		.values({
			sessionId,
			launchRequestId: launch.id,
			actionType: "resume",
			requestedBy: actor.label,
			requestedByUserId: actor.userId,
			metadata: {
				launch: mapLaunchRequest(launch),
				providerThreadId: managed.providerThreadId ?? managed.providerSessionId,
				cwd: launch.cwd,
			},
		})
		.returning();
	return action;
}

export async function queueApproval(
	sessionId: string,
	approvalId: string,
	decision: string,
	actor: Actor,
) {
	await assertSessionControlOrigin(sessionId, actor);
	await assertCanEditSessionNotes(actor, sessionId);
	if (await inspectOpenCodeProvenance(sessionId))
		throw new Error("Use the generation-fenced OpenCode interaction endpoint");
	const recent = await getDb()
		.select()
		.from(events)
		.where(and(eq(events.sessionId, sessionId), eq(events.eventType, "NativeApprovalRequested")))
		.orderBy(desc(events.id))
		.limit(100);
	const request = recent.find(
		(event) => (event.rawPayload as Record<string, unknown>).approvalId === approvalId,
	);
	if (
		!request ||
		Date.parse(String((request.rawPayload as Record<string, unknown>).expiresAt)) <= Date.now()
	)
		throw new Error("Approval expired or not found");
	if (!["accept", "decline", "cancel"].includes(decision)) throw new Error("Invalid decision");
	const [managed] = await getDb()
		.select()
		.from(managedSessions)
		.where(eq(managedSessions.sessionId, sessionId));
	if (!managed) throw new Error("Session is not bound");
	// The provider checks the opaque ID against its live connection and consumes it once.
	const [action] = await getDb()
		.insert(controlActions)
		.values({
			sessionId,
			launchRequestId: managed.launchRequestId,
			actionType: "approval",
			requestedBy: actor.label,
			requestedByUserId: actor.userId,
			metadata: { approvalId, decision },
		})
		.returning();
	return action;
}
