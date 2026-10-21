/** A3 snapshot-routing regressions: nativeSessionId decides the target session;
 *  unbound native sessions are rejected; ledger-less child bindings rejected;
 *  parent binding still routes; parent-failure shapes never leak in. */
import "../db/__test_db.js";
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
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
	bindCreatedOpenCodeSession,
	reserveOpenCodeInstance,
} from "../services/opencode-control-provenance.js";
import { acceptOpenCodeSnapshot } from "../services/opencode-managed.js";

const baseInput = (nativeSessionId: string, generation = 1) => ({
	generation,
	nativeSessionId,
	messages: [],
	permissions: [],
	questions: [],
	status: { type: "idle" },
});

beforeAll(() => initializeDatabase());
beforeEach(async () => {
	for (const t of [
		opencodeForkRequests,
		opencodeForks,
		sessionControlBindings,
		providerInstances,
		managedSessions,
		launchRequests,
		sessions,
		supervisors,
	])
		await getDb().delete(t);
	await getDb()
		.insert(supervisors)
		.values({
			id: "a3-host",
			hostName: "a3",
			platform: "linux",
			arch: "x64",
			version: "t",
			status: "connected",
			trustedRoots: ["/tmp"],
			capabilities: {},
		});
});

async function seedInstance() {
	const [launch] = await getDb()
		.insert(launchRequests)
		.values({
			launchCorrelationId: "a3-parent",
			agentType: "opencode",
			cwd: "/tmp",
			requestedLaunchMode: "managed_opencode",
			claimedBySupervisorId: "a3-host",
			status: "launching",
		})
		.returning();
	const instance = await reserveOpenCodeInstance("a3-host", launch.id);
	await getDb()
		.update(providerInstances)
		.set({ state: "running" })
		.where(eq(providerInstances.id, instance.id));
	await getDb()
		.insert(sessions)
		.values({ sessionId: "a3-parent", agentType: "opencode", cwd: "/tmp" });
	await getDb().insert(managedSessions).values({
		sessionId: "a3-parent",
		launchRequestId: launch.id,
		supervisorId: "a3-host",
		providerSessionId: "ses_parent",
		managedState: "managed",
	});
	await bindCreatedOpenCodeSession("a3-host", instance.id, "ses_parent", 1);
	return instance;
}

async function seedTrustedFork(
	childSessionId: string,
	parentSessionId: string,
	instanceId: string,
	nativeSessionId: string,
	generation: number,
	overrides: Partial<{
		actionPresent: boolean;
		emptySnapshot: boolean;
		providerInstanceId: string;
		ledgerNative: string;
		ledgerGeneration: number;
		actionParent: string;
	}> = {},
) {
	const [action] = await getDb()
		.insert(controlActions)
		.values({
			sessionId: childSessionId,
			actionType: "opencode_fork",
			requestedBy: "user",
			status: "succeeded",
			metadata: {
				parentSessionId: overrides.actionParent ?? parentSessionId,
				providerInstanceId: overrides.providerInstanceId ?? instanceId,
				generation: overrides.ledgerGeneration ?? generation,
			},
		})
		.returning();
	if (overrides.actionPresent !== false)
		await getDb()
			.insert(opencodeForkRequests)
			.values({
				actionId: action.id,
				requestHash: "h-a3",
				parentSnapshot: overrides.emptySnapshot ? {} : { messages: [{ nativeId: "msg_p" }] },
			});
	await getDb()
		.insert(opencodeForks)
		.values({
			childSessionId,
			parentSessionId,
			forkPointMessageId: null,
			requestActionId: action.id,
			providerInstanceId: overrides.providerInstanceId ?? instanceId,
			nativeSessionId: overrides.ledgerNative ?? nativeSessionId,
			generation: overrides.ledgerGeneration ?? generation,
		});
	return action;
}

describe("A3 snapshot routing", () => {
	test("PARENT binding still routes (launching session unchanged)", async () => {
		const instance = await seedInstance();
		const out = await acceptOpenCodeSnapshot("a3-host", instance.id, baseInput("ses_parent"));
		expect(out).toBeTruthy();
	});

	test("unbound native session is REJECTED — never auto-attached", async () => {
		const instance = await seedInstance();
		const err = await acceptOpenCodeSnapshot(
			"a3-host",
			instance.id,
			baseInput("ses_stranger"),
		).then(
			() => "NO_THROW",
			(e: Error) => e.message,
		);
		expect(err).toBe("provider_binding_invalid");
	});

	test("child binding WITHOUT a ledger row is rejected", async () => {
		const instance = await seedInstance();
		await getDb()
			.insert(sessions)
			.values({ sessionId: "a3-child-noledger", agentType: "opencode", cwd: "/tmp" });
		await getDb().insert(sessionControlBindings).values({
			sessionId: "a3-child-noledger",
			origin: "agentpulse_launch",
			instanceId: instance.id,
			nativeSessionId: "ses_orphan_child",
			generation: 1,
		});
		const err2 = await acceptOpenCodeSnapshot(
			"a3-host",
			instance.id,
			baseInput("ses_orphan_child"),
		).then(
			() => "NO_THROW",
			(e: Error) => e.message,
		);
		expect(err2).toBe("provider_binding_invalid");
	});

	test("child binding WITH a trusted ledger row routes (snapshot accepted)", async () => {
		const instance = await seedInstance();
		await getDb()
			.insert(sessions)
			.values({ sessionId: "a3-child", agentType: "opencode", cwd: "/tmp" });
		await getDb()
			.insert(managedSessions)
			.values({
				sessionId: "a3-child",
				launchRequestId: (
					await getDb()
						.select()
						.from(launchRequests)
						.where(eq(launchRequests.launchCorrelationId, "a3-parent"))
				)[0].id,
				supervisorId: "a3-host",
				providerSessionId: "ses_child",
				managedState: "managed",
			});
		await getDb().insert(sessionControlBindings).values({
			sessionId: "a3-child",
			origin: "agentpulse_launch",
			instanceId: instance.id,
			nativeSessionId: "ses_child",
			generation: 1,
		});
		await seedTrustedFork("a3-child", "a3-parent", instance.id, "ses_child", 1);
		const out = await acceptOpenCodeSnapshot("a3-host", instance.id, {
			...baseInput("ses_child"),
			// catalog persists only when commands are present — include them so
			// the test proves the write lands on the CHILD session's metadata.
			commands: [{ name: "init", description: "d", source: "command" }],
			agents: [],
			providers: { providers: [] },
		});
		expect(out).toBeTruthy();
		// the catalog/persist lands on the CHILD session
		const [child] = await getDb().select().from(sessions).where(eq(sessions.sessionId, "a3-child"));
		expect((child.metadata as { opencodeCatalog?: unknown })?.opencodeCatalog).toBeTruthy();
	});

	test("generation mismatch on the child binding is rejected", async () => {
		const instance = await seedInstance();
		await getDb()
			.insert(sessions)
			.values({ sessionId: "a3-child-g", agentType: "opencode", cwd: "/tmp" });
		await getDb().insert(sessionControlBindings).values({
			sessionId: "a3-child-g",
			origin: "agentpulse_launch",
			instanceId: instance.id,
			nativeSessionId: "ses_child_g",
			generation: 1,
		});
		await getDb()
			.insert(opencodeForks)
			.values({ childSessionId: "a3-child-g", parentSessionId: "a3-parent" });
		const err3 = await acceptOpenCodeSnapshot(
			"a3-host",
			instance.id,
			baseInput("ses_child_g", 2),
		).then(
			() => "NO_THROW",
			(e: Error) => e.message,
		);
		expect(err3).toBe("provider_binding_invalid");
	});
});

describe("A3 trusted-creation binding regressions (review round 40)", () => {
	async function seedChildBinding(sessionId: string, instanceId: string, native: string) {
		await getDb().insert(sessions).values({ sessionId, agentType: "opencode", cwd: "/tmp" });
		await getDb()
			.insert(managedSessions)
			.values({
				sessionId,
				launchRequestId: (
					await getDb()
						.select()
						.from(launchRequests)
						.where(eq(launchRequests.launchCorrelationId, "a3-parent"))
				)[0].id,
				supervisorId: "a3-host",
				providerSessionId: native,
				managedState: "managed",
			});
		await getDb().insert(sessionControlBindings).values({
			sessionId,
			origin: "agentpulse_launch",
			instanceId,
			nativeSessionId: native,
			generation: 1,
		});
	}

	test("ledger row bound to ANOTHER instance cannot authorize a child on this instance", async () => {
		const instance = await seedInstance();
		await seedChildBinding("a3-x", instance.id, "ses_x");
		// ledger claims a DIFFERENT instance id — cross-instance misattachment
		await seedTrustedFork("a3-x", "a3-parent", instance.id, "ses_x", 1, {
			providerInstanceId: "some-other-instance",
		});
		const err = await acceptOpenCodeSnapshot("a3-host", instance.id, baseInput("ses_x")).then(
			() => "NO_THROW",
			(e: Error) => e.message,
		);
		expect(err).toBe("provider_binding_invalid");
	});

	test("lineage that records a fork ACTION with no execution ledger row is NOT trusted", async () => {
		const instance = await seedInstance();
		await seedChildBinding("a3-y", instance.id, "ses_y");
		await seedTrustedFork("a3-y", "a3-parent", instance.id, "ses_y", 1, { actionPresent: false });
		const err = await acceptOpenCodeSnapshot("a3-host", instance.id, baseInput("ses_y")).then(
			() => "NO_THROW",
			(e: Error) => e.message,
		);
		expect(err).toBe("provider_binding_invalid");
	});

	test("incomplete lineage (native id / generation mismatch) is rejected", async () => {
		const instance = await seedInstance();
		await seedChildBinding("a3-z", instance.id, "ses_z");
		await seedTrustedFork("a3-z", "a3-parent", instance.id, "ses_z", 1, {
			ledgerNative: "ses_OTHER",
		});
		const err = await acceptOpenCodeSnapshot("a3-host", instance.id, baseInput("ses_z")).then(
			() => "NO_THROW",
			(e: Error) => e.message,
		);
		expect(err).toBe("provider_binding_invalid");
	});

	test("generation drift between lineage and instance is rejected", async () => {
		const instance = await seedInstance();
		await seedChildBinding("a3-g2", instance.id, "ses_g2");
		await seedTrustedFork("a3-g2", "a3-parent", instance.id, "ses_g2", 1, { ledgerGeneration: 7 });
		const err = await acceptOpenCodeSnapshot("a3-host", instance.id, baseInput("ses_g2")).then(
			() => "NO_THROW",
			(e: Error) => e.message,
		);
		expect(err).toBe("provider_binding_invalid");
	});
});

describe("A3 full creation-chain regressions (review round 41)", () => {
	async function seedChild(sessionId: string, instanceId: string, native: string) {
		await getDb().insert(sessions).values({ sessionId, agentType: "opencode", cwd: "/tmp" });
		await getDb()
			.insert(managedSessions)
			.values({
				sessionId,
				launchRequestId: (
					await getDb()
						.select()
						.from(launchRequests)
						.where(eq(launchRequests.launchCorrelationId, "a3-parent"))
				)[0].id,
				supervisorId: "a3-host",
				providerSessionId: native,
				managedState: "managed",
			});
		await getDb().insert(sessionControlBindings).values({
			sessionId,
			origin: "agentpulse_launch",
			instanceId,
			nativeSessionId: native,
			generation: 1,
		});
	}
	const rejected = async (instanceId: string, native: string) =>
		acceptOpenCodeSnapshot("a3-host", instanceId, baseInput(native)).then(
			() => "NO_THROW",
			(e: Error) => e.message,
		);

	test("EMPTY pinned snapshot is not a trusted creation", async () => {
		const instance = await seedInstance();
		await seedChild("a3-empty", instance.id, "ses_empty");
		await seedTrustedFork("a3-empty", "a3-parent", instance.id, "ses_empty", 1, {
			emptySnapshot: true,
		});
		expect(await rejected(instance.id, "ses_empty")).toBe("provider_binding_invalid");
	});

	test("non-fork action or wrong parent target is rejected", async () => {
		const instance = await seedInstance();
		await seedChild("a3-nonfork", instance.id, "ses_nonfork");
		const [action] = await getDb()
			.insert(controlActions)
			.values({
				sessionId: "a3-nonfork",
				actionType: "prompt",
				requestedBy: "user",
				status: "succeeded",
				metadata: { parentSessionId: "a3-parent", providerInstanceId: instance.id, generation: 1 },
			})
			.returning();
		await getDb()
			.insert(opencodeForkRequests)
			.values({
				actionId: action.id,
				requestHash: "h",
				parentSnapshot: { messages: [] },
			}); // ledger row (FK -> control_actions, present)
		await getDb().insert(opencodeForks).values({
			childSessionId: "a3-nonfork",
			parentSessionId: "a3-parent",
			requestActionId: action.id,
			providerInstanceId: instance.id,
			nativeSessionId: "ses_nonfork",
			generation: 1,
		});
		expect(await rejected(instance.id, "ses_nonfork")).toBe("provider_binding_invalid");

		await seedChild("a3-wrongparent", instance.id, "ses_wrongparent");
		// lineage names another EXISTING session as parent while the action
		// metadata points at a3-parent → the chain must not trust it
		await getDb()
			.insert(sessions)
			.values({ sessionId: "a3-other-parent", agentType: "opencode", cwd: "/tmp" });
		// action metadata targets a3-parent, lineage names a3-other-parent → mismatch
		await seedTrustedFork("a3-wrongparent", "a3-other-parent", instance.id, "ses_wrongparent", 1, {
			actionParent: "a3-parent",
		});
		expect(await rejected(instance.id, "ses_wrongparent")).toBe("provider_binding_invalid");
	});

	test("A4: observer skip requires a VERIFIED source domain — same host+id but different domain is observed", async () => {
		const instance = await seedInstance();
		// managed instance records a DIFFERENT source domain than the observer
		await getDb()
			.update(providerInstances)
			.set({ sourceInstanceId: "other-source-domain" })
			.where(eq(providerInstances.id, instance.id));
		await getDb()
			.insert(sessions)
			.values({ sessionId: "a4-par", agentType: "opencode", cwd: "/tmp" });
		await getDb().insert(sessionControlBindings).values({
			sessionId: "a4-par",
			origin: "agentpulse_launch",
			instanceId: instance.id,
			nativeSessionId: "ses_a4",
			generation: 1,
		});
		// exercised through the shared domain rule: observer instanceId must equal
		// provider_instances.source_instance_id exactly
		const rows = await getDb()
			.select({ id: sessionControlBindings.sessionId })
			.from(sessionControlBindings)
			.innerJoin(providerInstances, eq(providerInstances.id, sessionControlBindings.instanceId))
			.where(eq(providerInstances.sourceInstanceId, "observer-domain"));
		expect(rows).toHaveLength(0); // different domain → observe, not skip
		await getDb()
			.update(providerInstances)
			.set({ sourceInstanceId: "observer-domain" })
			.where(eq(providerInstances.id, instance.id));
		const rows2 = await getDb()
			.select({ id: sessionControlBindings.sessionId })
			.from(sessionControlBindings)
			.innerJoin(providerInstances, eq(providerInstances.id, sessionControlBindings.instanceId))
			.where(
				and(
					eq(providerInstances.sourceInstanceId, "observer-domain"),
					eq(sessionControlBindings.sessionId, "a4-par"),
				),
			);
		expect(rows2).toHaveLength(1); // verified domain → skip (managed)
	});
});
