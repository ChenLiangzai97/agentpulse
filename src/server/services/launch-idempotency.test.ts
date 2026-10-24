/**
 * Actor-scoped launch idempotency (drizzle 0014 / review blocker: launch
 * request server-side idempotency).
 *
 * createValidatedLaunchRequest accepts an optional idempotencyKey. A retry
 * or concurrent duplicate carrying the same (actor, key) must map to the
 * FIRST launch instead of starting a second one — the pre-check short-circuits
 * the common case and the uq_launch_idempotency unique index is the
 * concurrent-race backstop. Keys are actor-scoped: the same key under a
 * different actor is a different launch. The server still mints the
 * correlation id; the key never influences it.
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import type { Actor } from "../auth/actor.js";
import "./ai/__test_db.js";

const USER_A: Actor = { userId: "user-a", label: "user" };
const USER_B: Actor = { userId: "user-b", label: "user" };

const { getDb, initializeDatabase } = await import("../db/client.js");
const { launchRequests, supervisors } = await import("../db/schema/index.js");
const { createValidatedLaunchRequest } = await import("./launch-validator.js");

beforeAll(() => initializeDatabase());

beforeEach(async () => {
	await getDb().delete(launchRequests).execute();
	await getDb().delete(supervisors).execute();
});

async function seedConnectedSupervisor(id: string): Promise<void> {
	await getDb()
		.insert(supervisors)
		.values({
			id,
			hostName: id,
			platform: "linux",
			arch: "x64",
			version: "0.1.0",
			capabilities: {
				version: 1,
				agentTypes: ["claude_code", "codex_cli"],
				launchModes: ["interactive_terminal", "headless"],
				os: "linux",
				terminalSupport: [],
				executables: {
					claude: { available: true, version: "1.0", path: "/usr/bin/claude" },
					codex: { available: true, version: "1.0", path: "/usr/bin/codex" },
				},
				features: [],
			},
			trustedRoots: ["/tmp"],
			status: "connected",
			capabilitySchemaVersion: 2,
			configSchemaVersion: 1,
			heartbeatLeaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
		});
}

function minimalLaunchInput(requestedSupervisorId: string) {
	return {
		requestedSupervisorId,
		template: {
			name: "idem-template",
			agentType: "claude_code" as const,
			cwd: "/tmp/idem",
		},
		launchSpec: {
			version: 1 as const,
			launchCorrelationId: crypto.randomUUID(),
			managedMode: "unmanaged_preview" as const,
			agentType: "claude_code" as const,
			cwd: "/tmp/idem",
			model: null,
			approvalPolicy: null,
			sandboxMode: null,
			baseInstructions: "",
			taskPrompt: "",
			env: {},
			providerConfig: {
				command: "claude",
				cliArgs: [],
				instructionsFile: "CLAUDE.md" as const,
			},
		},
	};
}

describe("launch idempotency", () => {
	test("retrying with the same key returns the first launch, not a second one", async () => {
		await seedConnectedSupervisor("sup-idem");
		const input = minimalLaunchInput("sup-idem");
		const first = await createValidatedLaunchRequest(
			{ ...input, idempotencyKey: "retry-1" },
			USER_A,
		);
		const second = await createValidatedLaunchRequest(
			{ ...input, idempotencyKey: "retry-1" },
			USER_A,
		);
		expect(second.launchRequest.id).toBe(first.launchRequest.id);
		expect(second.launchRequest.launchCorrelationId).toBe(first.launchRequest.launchCorrelationId);
		const rows = await getDb().select().from(launchRequests);
		expect(rows).toHaveLength(1);
	});

	test("the same key under a different actor starts a separate launch", async () => {
		await seedConnectedSupervisor("sup-scope");
		const input = minimalLaunchInput("sup-scope");
		const a = await createValidatedLaunchRequest({ ...input, idempotencyKey: "scoped" }, USER_A);
		const b = await createValidatedLaunchRequest({ ...input, idempotencyKey: "scoped" }, USER_B);
		expect(b.launchRequest.id).not.toBe(a.launchRequest.id);
		const rows = await getDb().select().from(launchRequests);
		expect(rows).toHaveLength(2);
	});

	test("concurrent duplicates with the same key collapse to one launch", async () => {
		await seedConnectedSupervisor("sup-race");
		const input = minimalLaunchInput("sup-race");
		const [r1, r2] = await Promise.all([
			createValidatedLaunchRequest({ ...input, idempotencyKey: "race" }, USER_A),
			createValidatedLaunchRequest({ ...input, idempotencyKey: "race" }, USER_A),
		]);
		expect(r1.launchRequest.id).toBe(r2.launchRequest.id);
		const rows = await getDb().select().from(launchRequests);
		expect(rows).toHaveLength(1);
	});

	test("without a key every call starts a new launch", async () => {
		await seedConnectedSupervisor("sup-nokey");
		const input = minimalLaunchInput("sup-nokey");
		await createValidatedLaunchRequest(input, USER_A);
		await createValidatedLaunchRequest(input, USER_A);
		const rows = await getDb().select().from(launchRequests);
		expect(rows).toHaveLength(2);
		for (const row of rows) expect(row.idempotencyKey).toBeNull();
	});

	test("an invalid key is rejected before anything is written", async () => {
		await seedConnectedSupervisor("sup-badkey");
		const input = minimalLaunchInput("sup-badkey");
		await expect(
			createValidatedLaunchRequest({ ...input, idempotencyKey: "not valid!" }, USER_A),
		).rejects.toThrow("Invalid idempotency key.");
		await expect(
			createValidatedLaunchRequest({ ...input, idempotencyKey: "x".repeat(121) }, USER_A),
		).rejects.toThrow("Invalid idempotency key.");
		const rows = await getDb().select().from(launchRequests);
		expect(rows).toHaveLength(0);
	});

	test("the unique index blocks a same-(owner,key) second row at the DB layer", async () => {
		await seedConnectedSupervisor("sup-index");
		const input = minimalLaunchInput("sup-index");
		const { launchRequest } = await createValidatedLaunchRequest(
			{ ...input, idempotencyKey: "dup" },
			USER_A,
		);
		// Bypass the service pre-check and force the constraint path.
		await expect(
			getDb()
				.insert(launchRequests)
				.values({
					launchCorrelationId: `forced-${crypto.randomUUID()}`,
					agentType: "claude_code",
					cwd: "/tmp/idem",
					requestedLaunchMode: "interactive_terminal",
					status: "validated",
					idempotencyKey: "dup",
					idempotencyOwner: `user:${USER_A.userId}`,
				})
				.execute(),
		).rejects.toThrow();
		// The stored row carries both scope columns for the retry lookup.
		const [row] = await getDb()
			.select()
			.from(launchRequests)
			.where(and(eq(launchRequests.id, launchRequest.id)));
		expect(row.idempotencyKey).toBe("dup");
		expect(row.idempotencyOwner).toBe(`user:${USER_A.userId}`);
	});
});
