/** Fork result finalization: atomic commit of child+managed+binding+lineage+
 *  ledger+action, idempotent replay, rollback on invalid input, and the
 *  identity being immune to ordinary session-metadata writes. */
import "../db/__test_db.js";
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { getDb, initializeDatabase } from "../db/client.js";
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
import {
	inspectOpenCodeProvenance,
	reserveOpenCodeInstance,
} from "./opencode-control-provenance.js";
import { type FinalizeForkInput, finalizeOpenCodeFork } from "./opencode-fork-service.js";

beforeAll(() => initializeDatabase());
beforeEach(async () => {
	for (const t of [
		opencodeForkRequests,
		opencodeForks,
		sessionControlBindings,
		providerInstances,
		managedSessions,
		launchRequests,
		controlActions,
		sessions,
		supervisors,
	])
		await getDb().delete(t);
	await getDb()
		.insert(supervisors)
		.values({
			id: "f-host",
			hostName: "f",
			platform: "linux",
			arch: "x64",
			version: "t",
			status: "connected",
			trustedRoots: ["/tmp"],
			capabilities: {},
		});
});

async function seedRunningForkRequest(opts: { status?: string } = {}) {
	const [launch] = await getDb()
		.insert(launchRequests)
		.values({
			launchCorrelationId: "f-parent",
			agentType: "opencode",
			cwd: "/tmp",
			requestedLaunchMode: "managed_opencode",
			claimedBySupervisorId: "f-host",
			status: "launching",
		})
		.returning();
	const instance = await reserveOpenCodeInstance("f-host", launch.id);
	await getDb()
		.update(providerInstances)
		.set({ state: "running" })
		.where(eq(providerInstances.id, instance.id));
	await getDb()
		.insert(sessions)
		.values({ sessionId: "f-parent", agentType: "opencode", cwd: "/tmp" });
	await getDb().insert(managedSessions).values({
		sessionId: "f-parent",
		launchRequestId: launch.id,
		supervisorId: "f-host",
		providerSessionId: "ses_p",
		managedState: "managed",
	});
	await getDb().insert(sessionControlBindings).values({
		sessionId: "f-parent",
		origin: "agentpulse_launch",
		instanceId: instance.id,
		nativeSessionId: "ses_p",
		generation: 1,
	});
	const [action] = await getDb()
		.insert(controlActions)
		.values({
			sessionId: "f-parent",
			actionType: "opencode_fork",
			requestedBy: "user",
			status: opts.status ?? "running",
			metadata: {
				claimToken: "claim-1",
				instanceOriginSessionId: "f-parent",
				directParentSessionId: "f-parent",
				nativeSessionId: "ses_p",
				instanceId: instance.id,
				generation: 1,
				childDisplayName: "父 · 分支",
			},
		})
		.returning();
	await getDb()
		.insert(opencodeForkRequests)
		.values({ actionId: action.id, requestHash: "h", identity: null });
	const input: FinalizeForkInput = {
		actionId: action.id,
		supervisorId: "f-host",
		claimToken: "claim-1",
		childNativeSessionId: "ses_child",
		parentSnapshot: {
			version: 1,
			instanceId: instance.id,
			nativeSessionId: "ses_p",
			messages: [],
			forkPointMessageId: "msg_x",
		},
		parentLabel: { directParentSessionId: "f-parent", parentNativeSessionId: "ses_p" },
	};
	return { action, instance, input };
}

describe("fork result finalization", () => {
	test("ONE transaction commits child, managed row, binding, lineage, ledger identity and action success", async () => {
		const { action, instance, input } = await seedRunningForkRequest();
		const out = await finalizeOpenCodeFork(input);
		expect(out.replayed).toBe(false);
		const childId = out.childSessionId;
		expect(
			await getDb().select().from(sessions).where(eq(sessions.sessionId, childId)),
		).toHaveLength(1);
		const [managed] = await getDb()
			.select()
			.from(managedSessions)
			.where(eq(managedSessions.sessionId, childId));
		expect(managed.correlationSource).toBe("opencode_fork");
		const [binding] = await getDb()
			.select()
			.from(sessionControlBindings)
			.where(eq(sessionControlBindings.sessionId, childId));
		expect(binding.nativeSessionId).toBe("ses_child");
		const [lineage] = await getDb()
			.select()
			.from(opencodeForks)
			.where(eq(opencodeForks.childSessionId, childId));
		expect(lineage.requestActionId).toBe(action.id);
		expect(lineage.parentSessionId).toBe("f-parent");
		const [request] = await getDb()
			.select()
			.from(opencodeForkRequests)
			.where(eq(opencodeForkRequests.actionId, action.id));
		const identity = request.identity as { result?: { status: string; childSessionId: string } };
		expect(identity.result?.status).toBe("succeeded");
		expect(identity.result?.childSessionId).toBe(childId);
		const [row] = await getDb()
			.select()
			.from(controlActions)
			.where(eq(controlActions.id, action.id));
		expect(row.status).toBe("succeeded");
		// and the child now validates through the real provenance path
		expect((await inspectOpenCodeProvenance(childId))?.bindingValid).toBe(true);
	});

	test("replay is idempotent — no duplicate rows, same child", async () => {
		const { input } = await seedRunningForkRequest();
		const first = await finalizeOpenCodeFork(input);
		const again = await finalizeOpenCodeFork(input);
		expect(again.replayed).toBe(true);
		expect(again.childSessionId).toBe(first.childSessionId);
		expect(await getDb().select().from(opencodeForks)).toHaveLength(1);
		expect(
			await getDb()
				.select()
				.from(sessionControlBindings)
				.where(eq(sessionControlBindings.sessionId, first.childSessionId)),
		).toHaveLength(1);
	});

	test("invalid generation/supervisor/snapshot rolls back — no partial rows", async () => {
		const { instance, input } = await seedRunningForkRequest();
		await getDb()
			.update(providerInstances)
			.set({ generation: 2 })
			.where(eq(providerInstances.id, instance.id));
		await expect(finalizeOpenCodeFork(input)).rejects.toThrow();
		expect(await getDb().select().from(opencodeForks)).toHaveLength(0);
		// only the parent's binding remains — no child artifacts
		expect(await getDb().select().from(sessionControlBindings)).toHaveLength(1);
	});

	test("ordinary session-metadata writes cannot alter the immutable creation identity", async () => {
		const { action, input } = await seedRunningForkRequest();
		const { childSessionId } = await finalizeOpenCodeFork(input);
		// a metadata writer touches the child session's metadata (display-only)
		await getDb()
			.update(sessions)
			.set({ metadata: { forkOf: "tampered", origin: "agentpulse_launch" } })
			.where(eq(sessions.sessionId, childSessionId));
		const [request] = await getDb()
			.select()
			.from(opencodeForkRequests)
			.where(eq(opencodeForkRequests.actionId, action.id));
		const identity = request.identity as { result?: { status: string } };
		expect(identity.result?.status).toBe("succeeded");
		expect((await inspectOpenCodeProvenance(childSessionId))?.bindingValid).toBe(true);
	});
});

describe("fork finalization state machine and trust boundaries (review round 44)", () => {
	for (const status of ["cancelled", "failed", "unknown"] as const) {
		test(`a ${status} action cannot be finalized`, async () => {
			const { action, input } = await seedRunningForkRequest({ status });
			await expect(finalizeOpenCodeFork(input)).rejects.toThrow();
			const [row] = await getDb()
				.select()
				.from(controlActions)
				.where(eq(controlActions.id, action.id));
			expect(row.status).toBe(status); // untouched
			expect(await getDb().select().from(opencodeForks)).toHaveLength(0);
		});
	}

	test("a wrong claim token is refused (result must bind to the claimed execution)", async () => {
		const { input } = await seedRunningForkRequest();
		await expect(finalizeOpenCodeFork({ ...input, claimToken: "someone-else" })).rejects.toThrow();
		expect(await getDb().select().from(opencodeForks)).toHaveLength(0);
	});

	test("two concurrent finalizes produce ONE child (no duplicates)", async () => {
		const { input } = await seedRunningForkRequest();
		const results = await Promise.allSettled([
			finalizeOpenCodeFork(input),
			finalizeOpenCodeFork(input),
		]);
		const ok = results.filter((r) => r.status === "fulfilled");
		expect(ok.length).toBeGreaterThanOrEqual(1);
		expect(await getDb().select().from(opencodeForks)).toHaveLength(1);
		expect(
			await getDb()
				.select()
				.from(sessionControlBindings)
				.where(eq(sessionControlBindings.sessionId, "f-parent")),
		).toHaveLength(1);
	});

	test("missing execution ledger refuses the write — no child rows at all", async () => {
		const { action, input } = await seedRunningForkRequest();
		await getDb().delete(opencodeForkRequests).where(eq(opencodeForkRequests.actionId, action.id));
		await expect(finalizeOpenCodeFork(input)).rejects.toThrow();
		expect(await getDb().select().from(opencodeForks)).toHaveLength(0);
		expect(await getDb().select().from(sessionControlBindings)).toHaveLength(1); // parent only
		expect(await getDb().select().from(sessions)).toHaveLength(1); // parent only
	});

	test("the child inherits the PARENT's owner; a forged label is rejected", async () => {
		const { input } = await seedRunningForkRequest();
		await getDb()
			.update(sessions)
			.set({ ownerUserId: "owner-1" })
			.where(eq(sessions.sessionId, "f-parent"));
		const forged = await finalizeOpenCodeFork({
			...input,
			parentLabel: { directParentSessionId: "f-parent", parentNativeSessionId: "ses_WRONG" },
		}).then(
			() => "NO_THROW",
			() => "REJECTED",
		);
		expect(forged).toBe("REJECTED");
		const out = await finalizeOpenCodeFork(input);
		const [child] = await getDb()
			.select()
			.from(sessions)
			.where(eq(sessions.sessionId, out.childSessionId));
		expect(child.ownerUserId).toBe("owner-1");
	});

	test("replay whose recorded child artifacts are gone is refused, not silently replayed", async () => {
		const { input } = await seedRunningForkRequest();
		const out = await finalizeOpenCodeFork(input);
		await getDb()
			.delete(sessionControlBindings)
			.where(eq(sessionControlBindings.sessionId, out.childSessionId));
		await expect(finalizeOpenCodeFork(input)).rejects.toThrow();
	});
});
