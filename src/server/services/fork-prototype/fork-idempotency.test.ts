/**
 * Real-DB tests for durable fork idempotency: the partial unique constraint
 * on a real engine, actor scoping, NULL-key exclusion, replay and request-hash
 * conflict (per review rounds 12/14/17).
 */
import "../../db/__test_db.js";
import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { getDb, initializeDatabase } from "../../db/client.js";
import { controlActions, sessions } from "../../db/schema/index.js";
import {
	applyForkIdempotencyPrototypeIndex,
	resolveForkActionIdempotency,
} from "./fork-idempotency.js";

beforeEach(async () => {
	await initializeDatabase();
	await getDb().delete(controlActions).execute();
	// control_actions.session_id carries an FK to sessions — seed the target.
	await getDb().delete(sessions).where(eq(sessions.sessionId, "s"));
	await getDb().insert(sessions).values({ sessionId: "s", agentType: "opencode", cwd: "/tmp" });
	await applyForkIdempotencyPrototypeIndex();
});

describe("durable fork idempotency (real DB)", () => {
	test("same (actor, key) is a DB-level violation — the unique constraint bites", async () => {
		await resolveForkActionIdempotency({
			actorUserId: "u1",
			idempotencyKey: "k1",
			requestHash: "h1",
			sessionId: "s",
		});
		const duplicate = await getDb()
			.insert(controlActions)
			.values({
				sessionId: "s",
				actionType: "opencode_fork",
				requestedBy: "user",
				requestedByUserId: "u1",
				idempotencyKey: "k1",
				metadata: { requestHash: "h1" },
			})
			.then(
				() => "inserted",
				(error: unknown) => (error instanceof Error ? error.message : String(error)),
			);
		expect(duplicate).toContain("UNIQUE constraint failed");
	});

	test("replay with the same hash returns the existing action; different hash conflicts", async () => {
		const first = await resolveForkActionIdempotency({
			actorUserId: "u1",
			idempotencyKey: "k2",
			requestHash: "h1",
			sessionId: "s",
		});
		expect(first.outcome).toBe("created");
		const replay = await resolveForkActionIdempotency({
			actorUserId: "u1",
			idempotencyKey: "k2",
			requestHash: "h1",
			sessionId: "s",
		});
		expect(replay.outcome).toBe("existing");
		if (replay.outcome === "existing" && first.outcome === "created")
			expect(replay.actionId).toBe(first.actionId);
		const conflict = await resolveForkActionIdempotency({
			actorUserId: "u1",
			idempotencyKey: "k2",
			requestHash: "h2",
			sessionId: "s",
		});
		expect(conflict.outcome).toBe("conflict");
	});

	test("actors are scoped: the same key under another actor creates its own row", async () => {
		const a = await resolveForkActionIdempotency({
			actorUserId: "u1",
			idempotencyKey: "k3",
			requestHash: "h",
			sessionId: "s",
		});
		const b = await resolveForkActionIdempotency({
			actorUserId: "u2",
			idempotencyKey: "k3",
			requestHash: "h",
			sessionId: "s",
		});
		expect(a.outcome).toBe("created");
		expect(b.outcome).toBe("created");
		if (a.outcome === "created" && b.outcome === "created") expect(a.actionId).not.toBe(b.actionId);
		// solo (NULL owner) scopes to the anonymous actor
		const solo1 = await resolveForkActionIdempotency({
			actorUserId: null,
			idempotencyKey: "k4",
			requestHash: "h",
			sessionId: "s",
		});
		const solo2 = await resolveForkActionIdempotency({
			actorUserId: null,
			idempotencyKey: "k4",
			requestHash: "h",
			sessionId: "s",
		});
		expect(solo1.outcome).toBe("created");
		expect(solo2.outcome).toBe("existing");
	});

	test("NULL keys never collide — the partial index excludes them", async () => {
		for (let i = 0; i < 3; i++)
			await getDb().insert(controlActions).values({
				sessionId: "s",
				actionType: "opencode_fork",
				requestedBy: "user",
				requestedByUserId: "u1",
				idempotencyKey: null,
			});
		const rows = await getDb().select().from(controlActions);
		expect(rows.length).toBeGreaterThanOrEqual(3);
	});
});
