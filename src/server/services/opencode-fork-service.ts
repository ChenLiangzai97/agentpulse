/**
 * Fork result finalization (A6 / fork design §B/C). ONE transaction commits:
 *   child session row · managed session row · protected control binding ·
 *   lineage row · execution-ledger identity+snapshot+map · action success.
 *
 * The immutable creation identity lives in its OWN table
 * (opencode_fork_requests.identity_json), so ordinary session-metadata
 * writers can never rewrite the authorization evidence.
 *
 * Entry points (HTTP route, UI) remain CLOSED — this is the service slice the
 * supervisor result report will call once review opens the entry.
 */
import { and, eq } from "drizzle-orm";
import {
	controlActions,
	managedSessions,
	opencodeForkRequests,
	opencodeForks,
	providerInstances,
	sessionControlBindings,
	sessions,
} from "../db/schema/index.js";
import { withTransaction } from "../db/with-transaction.js";
import { SessionControlOriginError } from "./opencode-control-provenance.js";

export interface ForkIdentity {
	version: 1;
	instanceOriginSessionId: string;
	directParentSessionId: string;
	parentNativeSessionId: string;
	providerInstanceId: string;
	generation: number;
	result: {
		status: "succeeded";
		childSessionId: string;
		childNativeSessionId: string;
		providerInstanceId: string;
		generation: number;
		confirmedAt: string;
	};
}

export interface FinalizeForkInput {
	actionId: string;
	supervisorId: string;
	childNativeSessionId: string;
	/** Server-minted child session id (never client-chosen). */
	childSessionId: string;
	parentSnapshot: {
		version: 1;
		instanceId: string;
		nativeSessionId: string;
		messages: { nativeId: string; contentHash?: string }[];
		forkPointMessageId?: string | null;
	};
	childMap?: Record<string, unknown> | null;
	/** Immutable label for the direct parent (survives parent deletion). */
	parentLabel: { directParentSessionId: string; parentNativeSessionId: string };
}

export async function finalizeOpenCodeFork(
	input: FinalizeForkInput,
): Promise<{ actionId: string; childSessionId: string; replayed: boolean }> {
	return withTransaction(async (tx) => {
		const [action] = await tx
			.select()
			.from(controlActions)
			.where(eq(controlActions.id, input.actionId))
			.limit(1);
		if (!action || action.actionType !== "opencode_fork")
			throw new SessionControlOriginError("provider_binding_invalid");
		const meta = (action.metadata ?? {}) as Record<string, unknown>;
		if (meta.instanceId === undefined)
			throw new SessionControlOriginError("provider_binding_invalid");
		const [instance] = await tx
			.select()
			.from(providerInstances)
			.where(eq(providerInstances.id, String(meta.instanceId)))
			.limit(1);
		if (
			!instance ||
			instance.agentType !== "opencode" ||
			instance.supervisorId !== input.supervisorId ||
			instance.generation !== Number(meta.generation) ||
			!["running", "reserved"].includes(instance.state)
		)
			throw new SessionControlOriginError("provider_binding_invalid");
		// IDEMPOTENT replay: the action already carries a finalized result.
		if (action.status === "succeeded" && typeof meta.resultChildSessionId === "string") {
			return { actionId: action.id, childSessionId: meta.resultChildSessionId, replayed: true };
		}
		const directParentSessionId = String(meta.directParentSessionId ?? "");
		const parentNative = String(meta.nativeSessionId ?? "");
		if (!directParentSessionId || !parentNative)
			throw new SessionControlOriginError("provider_binding_invalid");
		if (action.sessionId !== directParentSessionId)
			throw new SessionControlOriginError("provider_binding_invalid");
		if (instance.sessionId !== String(meta.instanceOriginSessionId ?? ""))
			throw new SessionControlOriginError("provider_binding_invalid");
		// Snapshot identity must agree with the action before it is persisted.
		if (
			input.parentSnapshot.version !== 1 ||
			input.parentSnapshot.instanceId !== instance.id ||
			input.parentSnapshot.nativeSessionId !== parentNative
		)
			throw new SessionControlOriginError("provider_binding_invalid");
		if (!input.childNativeSessionId.startsWith("ses_"))
			throw new SessionControlOriginError("provider_binding_invalid");

		const now = new Date().toISOString();
		const identity: ForkIdentity = {
			version: 1,
			instanceOriginSessionId: instance.sessionId,
			directParentSessionId,
			parentNativeSessionId: parentNative,
			providerInstanceId: instance.id,
			generation: instance.generation,
			result: {
				status: "succeeded",
				childSessionId: input.childSessionId,
				childNativeSessionId: input.childNativeSessionId,
				providerInstanceId: instance.id,
				generation: instance.generation,
				confirmedAt: now,
			},
		};
		// Child session + managed row (display name/metadata are NOT authority).
		await tx.insert(sessions).values({
			sessionId: input.childSessionId,
			agentType: "opencode",
			cwd: instance.cwd,
			displayName: String(meta.childDisplayName ?? ""),
		});
		await tx.insert(managedSessions).values({
			sessionId: input.childSessionId,
			launchRequestId: instance.launchRequestId,
			supervisorId: instance.supervisorId,
			providerSessionId: input.childNativeSessionId,
			managedState: "managed",
			correlationSource: "opencode_fork",
		});
		await tx.insert(sessionControlBindings).values({
			sessionId: input.childSessionId,
			origin: "agentpulse_launch",
			instanceId: instance.id,
			nativeSessionId: input.childNativeSessionId,
			generation: instance.generation,
		});
		await tx.insert(opencodeForks).values({
			childSessionId: input.childSessionId,
			parentSessionId: directParentSessionId,
			parentLabel: input.parentLabel,
			forkPointMessageId: input.parentSnapshot.forkPointMessageId ?? null,
			requestActionId: action.id,
			providerInstanceId: instance.id,
			nativeSessionId: input.childNativeSessionId,
			generation: instance.generation,
		});
		await tx
			.update(opencodeForkRequests)
			.set({
				identity: identity as unknown as Record<string, unknown>,
				parentSnapshot: input.parentSnapshot as unknown as Record<string, unknown>,
				childMap: input.childMap ?? null,
			})
			.where(eq(opencodeForkRequests.actionId, action.id));
		await tx
			.update(controlActions)
			.set({
				status: "succeeded",
				finishedAt: now,
				updatedAt: now,
				metadata: { ...meta, resultChildSessionId: input.childSessionId },
			})
			.where(and(eq(controlActions.id, action.id), eq(controlActions.status, action.status)));
		return { actionId: action.id, childSessionId: input.childSessionId, replayed: false };
	});
}
