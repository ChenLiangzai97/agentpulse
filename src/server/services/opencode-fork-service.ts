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
	/**
	 * The supervisor's CLAIM/EXECUTION token for this action (issued when the
	 * action was claimed). Binding the result to the token is what authorizes
	 * the write — a bare native-id string proves nothing.
	 */
	claimToken: string;
	/** Native child session id reported by the supervisor over the authed channel. */
	childNativeSessionId: string;
	parentSnapshot: {
		version: 1;
		instanceId: string;
		nativeSessionId: string;
		messages: { nativeId: string; contentHash?: string }[];
		forkPointMessageId?: string | null;
	};
	childMap?: Record<string, unknown> | null;
	/**
	 * Caller-supplied label is NOT trusted: it is verified against the parent
	 * session/binding inside the transaction and rejected on mismatch.
	 */
	parentLabel?: { directParentSessionId: string; parentNativeSessionId: string };
}

/**
 * Allowed source states for finalization. Anything else (cancelled, failed,
 * unknown, already-succeeded-without-our-marker) is refused and rolls back.
 */
const FINALIZABLE_STATES = ["running", "claimed"] as const;

export async function finalizeOpenCodeFork(
	input: FinalizeForkInput,
): Promise<{ actionId: string; childSessionId: string; replayed: boolean }> {
	const childSessionId = crypto.randomUUID(); // minted HERE, never caller-provided
	return withTransaction(async (tx) => {
		const [action] = await tx
			.select()
			.from(controlActions)
			.where(eq(controlActions.id, input.actionId))
			.limit(1);
		if (!action || action.actionType !== "opencode_fork")
			throw new SessionControlOriginError("provider_binding_invalid");
		const meta = (action.metadata ?? {}) as Record<string, unknown>;
		// IDEMPOTENT replay: only when the SAME execution token already
		// finalized this action, and the recorded result is intact.
		if (action.status === "succeeded") {
			if (
				meta.finalizedByClaimToken === input.claimToken &&
				typeof meta.resultChildSessionId === "string"
			) {
				const [existing] = await tx
					.select()
					.from(sessions)
					.where(eq(sessions.sessionId, meta.resultChildSessionId))
					.limit(1);
				const [existingBinding] = await tx
					.select()
					.from(sessionControlBindings)
					.where(eq(sessionControlBindings.sessionId, meta.resultChildSessionId))
					.limit(1);
				if (existing && existingBinding)
					return { actionId: action.id, childSessionId: meta.resultChildSessionId, replayed: true };
			}
			throw new SessionControlOriginError("provider_binding_invalid");
		}
		if (!FINALIZABLE_STATES.includes(action.status as (typeof FINALIZABLE_STATES)[number]))
			throw new SessionControlOriginError("provider_binding_invalid");
		if (meta.claimToken !== input.claimToken)
			throw new SessionControlOriginError("provider_binding_invalid");
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
		const directParentSessionId = String(meta.directParentSessionId ?? "");
		const parentNative = String(meta.nativeSessionId ?? "");
		if (!directParentSessionId || !parentNative)
			throw new SessionControlOriginError("provider_binding_invalid");
		if (action.sessionId !== directParentSessionId)
			throw new SessionControlOriginError("provider_binding_invalid");
		if (instance.sessionId !== String(meta.instanceOriginSessionId ?? ""))
			throw new SessionControlOriginError("provider_binding_invalid");
		// PARENT authorization context: the child inherits the parent's owner;
		// the label is derived here and any caller-provided label must agree.
		const [parent] = await tx
			.select()
			.from(sessions)
			.where(eq(sessions.sessionId, directParentSessionId))
			.limit(1);
		if (!parent || parent.agentType !== "opencode")
			throw new SessionControlOriginError("provider_binding_invalid");
		const [parentBinding] = await tx
			.select()
			.from(sessionControlBindings)
			.where(eq(sessionControlBindings.sessionId, directParentSessionId))
			.limit(1);
		if (
			!parentBinding ||
			parentBinding.origin !== "agentpulse_launch" ||
			parentBinding.instanceId !== instance.id ||
			parentBinding.nativeSessionId !== parentNative
		)
			throw new SessionControlOriginError("provider_binding_invalid");
		const derivedLabel = {
			directParentSessionId,
			parentNativeSessionId: parentNative,
		};
		if (
			input.parentLabel &&
			(input.parentLabel.directParentSessionId !== derivedLabel.directParentSessionId ||
				input.parentLabel.parentNativeSessionId !== derivedLabel.parentNativeSessionId)
		)
			throw new SessionControlOriginError("provider_binding_invalid");
		// Snapshot identity must agree before it is persisted.
		if (
			input.parentSnapshot.version !== 1 ||
			input.parentSnapshot.instanceId !== instance.id ||
			input.parentSnapshot.nativeSessionId !== parentNative
		)
			throw new SessionControlOriginError("provider_binding_invalid");
		// Format guard only — the REPORT context (claim token) is the identity
		// source; a string prefix never grants control by itself.
		if (
			typeof input.childNativeSessionId !== "string" ||
			!/^ses_[A-Za-z0-9_-]{4,}$/.test(input.childNativeSessionId)
		)
			throw new SessionControlOriginError("provider_binding_invalid");
		// Ledger + pinned snapshot must exist BEFORE any row is written.
		const [ledger] = await tx
			.select()
			.from(opencodeForkRequests)
			.where(eq(opencodeForkRequests.actionId, action.id))
			.limit(1);
		if (!ledger) throw new SessionControlOriginError("provider_binding_invalid");

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
				childSessionId,
				childNativeSessionId: input.childNativeSessionId,
				providerInstanceId: instance.id,
				generation: instance.generation,
				confirmedAt: now,
			},
		};
		// Child inherits the PARENT's owner (derived, not caller-supplied).
		await tx.insert(sessions).values({
			sessionId: childSessionId,
			agentType: "opencode",
			cwd: instance.cwd,
			displayName: String(meta.childDisplayName ?? "") || null,
			ownerUserId: parent.ownerUserId ?? null,
		});
		// NOTE (documented deviation): the managed row reuses the PARENT's
		// launch id until migration 0015's NULL-launch relaxation ships — this
		// is NOT the NULL-launch migration.
		await tx.insert(managedSessions).values({
			sessionId: childSessionId,
			launchRequestId: instance.launchRequestId,
			supervisorId: instance.supervisorId,
			providerSessionId: input.childNativeSessionId,
			managedState: "managed",
			correlationSource: "opencode_fork",
		});
		await tx.insert(sessionControlBindings).values({
			sessionId: childSessionId,
			origin: "agentpulse_launch",
			instanceId: instance.id,
			nativeSessionId: input.childNativeSessionId,
			generation: instance.generation,
		});
		await tx.insert(opencodeForks).values({
			childSessionId,
			parentSessionId: directParentSessionId,
			parentLabel: derivedLabel,
			forkPointMessageId: input.parentSnapshot.forkPointMessageId ?? null,
			requestActionId: action.id,
			providerInstanceId: instance.id,
			nativeSessionId: input.childNativeSessionId,
			generation: instance.generation,
		});
		const ledgerRows = await tx
			.update(opencodeForkRequests)
			.set({
				identity: identity as unknown as Record<string, unknown>,
				parentSnapshot: input.parentSnapshot as unknown as Record<string, unknown>,
				childMap: input.childMap ?? null,
			})
			.where(eq(opencodeForkRequests.actionId, action.id))
			.returning({ actionId: opencodeForkRequests.actionId });
		if (ledgerRows.length !== 1) throw new SessionControlOriginError("provider_binding_invalid");
		// State-machine CAS: finalize ONLY from the state we validated, on the
		// same claim token. A cancel/timeout race loses here → rollback.
		const actionRows = await tx
			.update(controlActions)
			.set({
				status: "succeeded",
				finishedAt: now,
				updatedAt: now,
				metadata: {
					...meta,
					resultChildSessionId: childSessionId,
					finalizedByClaimToken: input.claimToken,
				},
			})
			.where(and(eq(controlActions.id, action.id), eq(controlActions.status, action.status)))
			.returning({ id: controlActions.id });
		if (actionRows.length !== 1) throw new SessionControlOriginError("provider_binding_invalid");
		return { actionId: action.id, childSessionId, replayed: false };
	});
}
