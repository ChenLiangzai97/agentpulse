/**
 * Isolated prototype (NOT wired to the main path): durable fork-action
 * idempotency per docs/OPENCODE_FORK_DESIGN.md §B — a REAL partial unique
 * index on control_actions (the column exists; the constraint does not) plus
 * the resolution helper. Migration 0015 formalizes the index; the prototype
 * applies the identical statement to the test database so the constraint
 * semantics are proven on a real engine, both dialects.
 */
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../../db/client.js";
import { controlActions } from "../../db/schema/index.js";

export const FORK_IDEMPOTENCY_INDEX_SQLITE =
	"CREATE UNIQUE INDEX IF NOT EXISTS uq_fork_action_idem ON control_actions(COALESCE(requested_by_user_id,''), idempotency_key) WHERE action_type = 'opencode_fork' AND idempotency_key IS NOT NULL";

export async function applyForkIdempotencyPrototypeIndex(): Promise<void> {
	await getDb().run(sql.raw(FORK_IDEMPOTENCY_INDEX_SQLITE));
}

export type ForkIdempotencyResolution =
	| { outcome: "created"; actionId: string }
	| { outcome: "existing"; actionId: string }
	| { outcome: "conflict"; existingActionId: string };

/**
 * Actor-scoped idempotency with request-hash conflict detection:
 *  - no prior (actor, key) row → create;
 *  - prior with the SAME request hash → return it (retry/replay);
 *  - prior with a DIFFERENT hash → conflict (caller surfaces 409).
 */
export async function resolveForkActionIdempotency(input: {
	actorUserId: string | null;
	idempotencyKey: string;
	requestHash: string;
	sessionId: string;
}): Promise<ForkIdempotencyResolution> {
	const actorKey = input.actorUserId ?? "";
	const existing = await getDb()
		.select()
		.from(controlActions)
		.where(
			and(
				eq(controlActions.actionType, "opencode_fork"),
				eq(controlActions.idempotencyKey, input.idempotencyKey),
				// COALESCE match so solo (NULL owner) keys scope to the anonymous actor
				sql`COALESCE(${controlActions.requestedByUserId}, '') = ${actorKey}`,
			),
		)
		.limit(1);
	if (existing.length) {
		const priorHash = (existing[0].metadata as { requestHash?: string } | null)?.requestHash;
		if (priorHash && priorHash !== input.requestHash)
			return { outcome: "conflict", existingActionId: existing[0].id };
		return { outcome: "existing", actionId: existing[0].id };
	}
	const [row] = await getDb()
		.insert(controlActions)
		.values({
			sessionId: input.sessionId,
			actionType: "opencode_fork",
			requestedBy: "user",
			requestedByUserId: input.actorUserId,
			idempotencyKey: input.idempotencyKey,
			metadata: { requestHash: input.requestHash },
		})
		.returning();
	return { outcome: "created", actionId: row.id };
}
