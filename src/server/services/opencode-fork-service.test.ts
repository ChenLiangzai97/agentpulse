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
	await getDb()
		.insert(managedSessions)
		.values({
			sessionId: "f-parent",
			launchRequestId: launch.id,
			supervisorId: "f-host",
			providerSessionId: "ses_p",
			managedState: "managed",
		});
	await getDb()
		.insert(sessionControlBindings)
		.values({
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
		childNativeSessionId: "ses_child",
		childSessionId: "f-child",
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
		expect(
			await getDb().select().from(sessions).where(eq(sessions.sessionId, "f-child")),
		).toHaveLength(1);
		const [managed] = await getDb()
			.select()
			.from(managedSessions)
			.where(eq(managedSessions.sessionId, "f-child"));
		expect(managed.correlationSource).toBe("opencode_fork");
		const [binding] = await getDb()
			.select()
			.from(sessionControlBindings)
			.where(eq(sessionControlBindings.sessionId, "f-child"));
		expect(binding.nativeSessionId).toBe("ses_child");
		const [lineage] = await getDb()
			.select()
			.from(opencodeForks)
			.where(eq(opencodeForks.childSessionId, "f-child"));
		expect(lineage.requestActionId).toBe(action.id);
		expect(lineage.parentSessionId).toBe("f-parent");
		const [request] = await getDb()
			.select()
			.from(opencodeForkRequests)
			.where(eq(opencodeForkRequests.actionId, action.id));
		const identity = request.identity as { result?: { status: string; childSessionId: string } };
		expect(identity.result?.status).toBe("succeeded");
		expect(identity.result?.childSessionId).toBe("f-child");
		const [row] = await getDb()
			.select()
			.from(controlActions)
			.where(eq(controlActions.id, action.id));
		expect(row.status).toBe("succeeded");
		// and the child now validates through the real provenance path
		expect((await inspectOpenCodeProvenance("f-child"))?.bindingValid).toBe(true);
	});

	test("replay is idempotent — no duplicate rows, same child", async () => {
		const { input } = await seedRunningForkRequest();
		await finalizeOpenCodeFork(input);
		const again = await finalizeOpenCodeFork(input);
		expect(again.replayed).toBe(true);
		expect(again.childSessionId).toBe("f-child");
		expect(await getDb().select().from(opencodeForks)).toHaveLength(1);
		expect(
			await getDb()
				.select()
				.from(sessionControlBindings)
				.where(eq(sessionControlBindings.sessionId, "f-child")),
		).toHaveLength(1);
	});

	test("invalid generation/supervisor/snapshot rolls back — no partial rows", async () => {
		const { instance, input } = await seedRunningForkRequest();
		await getDb()
			.update(providerInstances)
			.set({ generation: 2 })
			.where(eq(providerInstances.id, instance.id));
		await expect(finalizeOpenCodeFork(input)).rejects.toThrow();
		expect(
			await getDb().select().from(sessions).where(eq(sessions.sessionId, "f-child")),
		).toHaveLength(0);
		expect(await getDb().select().from(opencodeForks)).toHaveLength(0);
		expect(
			await getDb()
				.select()
				.from(sessionControlBindings)
				.where(eq(sessionControlBindings.sessionId, "f-child")),
		).toHaveLength(0);
	});

	test("ordinary session-metadata writes cannot alter the immutable creation identity", async () => {
		const { action, input } = await seedRunningForkRequest();
		await finalizeOpenCodeFork(input);
		// a metadata writer touches the child session's metadata (display-only)
		await getDb()
			.update(sessions)
			.set({ metadata: { forkOf: "tampered", origin: "agentpulse_launch" } })
			.where(eq(sessions.sessionId, "f-child"));
		const [request] = await getDb()
			.select()
			.from(opencodeForkRequests)
			.where(eq(opencodeForkRequests.actionId, action.id));
		const identity = request.identity as { result?: { status: string } };
		expect(identity.result?.status).toBe("succeeded");
		expect((await inspectOpenCodeProvenance("f-child"))?.bindingValid).toBe(true);
	});
});
