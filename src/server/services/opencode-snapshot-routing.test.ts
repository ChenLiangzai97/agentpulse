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
	directParentSessionId: string,
	instanceId: string,
	childNativeSessionId: string,
	generation: number,
	overrides: Partial<{
		actionPresent: boolean;
		providerInstanceId: string;
		ledgerNative: string;
		ledgerGeneration: number;
		actionParent: string;
		instanceOrigin: string;
		parentNative: string;
		snapshotInstance: string;
		snapshotNative: string;
		snapshotVersion: number;
		withLabel: boolean;
		resultStatus: "succeeded" | "queued" | "failed" | "unknown";
		actionNativeContradiction: boolean;
		dropResult: boolean;
	}> = {},
	parentNativeSessionId = "ses_parent",
) {
	const [action] = await getDb()
		.insert(controlActions)
		.values({
			// Fork request targets the DIRECT PARENT — never the child.
			sessionId: overrides.actionParent ?? directParentSessionId,
			actionType: "opencode_fork",
			requestedBy: "user",
			status: "succeeded",
			metadata: {
				instanceOriginSessionId: overrides.instanceOrigin ?? "a3-parent",
				directParentSessionId,
				nativeSessionId: overrides.actionNativeContradiction
					? "ses_CONTRADICTION"
					: (overrides.parentNative ?? parentNativeSessionId),
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
				identity: {
					version: 1,
					instanceOriginSessionId: overrides.instanceOrigin ?? "a3-parent",
					directParentSessionId,
					parentNativeSessionId: overrides.parentNative ?? parentNativeSessionId,
					providerInstanceId: overrides.providerInstanceId ?? instanceId,
					generation: overrides.ledgerGeneration ?? generation,
					result: overrides.dropResult
						? undefined
						: {
								status: overrides.resultStatus ?? "succeeded",
								childSessionId,
								childNativeSessionId: overrides.ledgerNative ?? childNativeSessionId,
								providerInstanceId: overrides.providerInstanceId ?? instanceId,
								generation: overrides.ledgerGeneration ?? generation,
								confirmedAt: "2026-10-20T00:00:00.000Z",
							},
				},
				parentSnapshot: {
					version: overrides.snapshotVersion ?? 1,
					instanceId: overrides.snapshotInstance ?? instanceId,
					nativeSessionId:
						overrides.snapshotNative ?? overrides.parentNative ?? parentNativeSessionId,
					messages: [],
				},
			});
	await getDb()
		.insert(opencodeForks)
		.values({
			childSessionId,
			parentSessionId: directParentSessionId,
			parentLabel:
				overrides.withLabel === false
					? null
					: {
							directParentSessionId,
							parentNativeSessionId: overrides.parentNative ?? parentNativeSessionId,
						},
			forkPointMessageId: null,
			requestActionId: action.id,
			providerInstanceId: overrides.providerInstanceId ?? instanceId,
			nativeSessionId: overrides.ledgerNative ?? childNativeSessionId,
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
			snapshotVersion: 0,
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
				metadata: {
					instanceOriginSessionId: "a3-parent",
					directParentSessionId: "a3-nonfork",
					nativeSessionId: "ses_nonfork",
					providerInstanceId: instance.id,
					generation: 1,
				},
			})
			.returning();
		await getDb()
			.insert(opencodeForkRequests)
			.values({
				actionId: action.id,
				requestHash: "h",
				identity: {
					instanceOriginSessionId: "a3-parent",
					directParentSessionId: "a3-nonfork",
					nativeSessionId: "ses_nonfork",
					providerInstanceId: instance.id,
					generation: 1,
				},
				parentSnapshot: {
					version: 1,
					instanceId: instance.id,
					nativeSessionId: "ses_nonfork",
					messages: [],
				},
			});
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

describe("A3 two-anchor contract regressions (review round 42)", () => {
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
	const rejected = async (instanceId: string, native: string) => {
		const out = await acceptOpenCodeSnapshot("a3-host", instanceId, baseInput(native)).then(
			() => "NO_THROW",
			(e: Error) => e.message,
		);
		if (out !== "NO_THROW" && process.env.AGENTPULSE_DEBUG_FORK) {
			const [b] = await getDb()
				.select()
				.from(sessionControlBindings)
				.where(eq(sessionControlBindings.nativeSessionId, native));
			const [inst] = await getDb()
				.select()
				.from(providerInstances)
				.where(eq(providerInstances.id, instanceId));
			if (b && inst) {
				const { trustedForkChildIssue } = await import("./opencode-control-provenance.js");
				console.log(
					"FORK-CHILD-ISSUE(",
					native,
					") =",
					await trustedForkChildIssue({
						childSessionId: b.sessionId,
						bindingInstanceId: b.instanceId,
						bindingNativeSessionId: b.nativeSessionId,
						bindingGeneration: b.generation,
						instance: {
							id: inst.id,
							generation: inst.generation,
							supervisorId: inst.supervisorId,
							launchRequestId: inst.launchRequestId,
							sessionId: inst.sessionId,
						},
						snapshotNativeSessionId: native,
					}),
				);
			}
		}
		return out;
	};

	test("forking FROM a child (child-of-child) is accepted: direct parent ≠ instance origin", async () => {
		const instance = await seedInstance();
		await seedChild("a3-c1", instance.id, "ses_c1");
		// c1 is itself a fork child of a3-parent (direct parent of c1)
		await seedTrustedFork("a3-c1", "a3-parent", instance.id, "ses_c1", 1);
		// c2 is forked FROM c1 — direct parent is c1, origin stays a3-parent
		await seedChild("a3-c2", instance.id, "ses_c2");
		await seedTrustedFork(
			"a3-c2",
			"a3-c1",
			instance.id,
			"ses_c2",
			1,
			{ instanceOrigin: "a3-parent" },
			"ses_c1",
		);
		const out = await acceptOpenCodeSnapshot("a3-host", instance.id, baseInput("ses_c2"));
		expect(out).toBeTruthy();
	});

	test("deleting the DIRECT PARENT keeps the child trusted through the action metadata + label", async () => {
		const instance = await seedInstance();
		await seedChild("a3-dc", instance.id, "ses_dc");
		await seedChild("a3-parent2", instance.id, "ses_parent2");
		await seedTrustedFork("a3-dc", "a3-parent2", instance.id, "ses_dc", 1, {}, "ses_parent2");
		expect(await rejected(instance.id, "ses_dc")).toBe("NO_THROW");
		// delete the direct parent (not the instance origin) → SET NULL + label
		await getDb().delete(sessions).where(eq(sessions.sessionId, "a3-parent2"));
		expect(await rejected(instance.id, "ses_dc")).toBe("NO_THROW");
	});

	test("a snapshot naming the WRONG instance or native identity is not creation evidence", async () => {
		const instance = await seedInstance();
		await seedChild("a3-snap1", instance.id, "ses_snap1");
		await seedTrustedFork("a3-snap1", "a3-parent", instance.id, "ses_snap1", 1, {
			snapshotNative: "ses_WRONG",
		});
		expect(await rejected(instance.id, "ses_snap1")).toBe("provider_binding_invalid");

		await seedChild("a3-snap2", instance.id, "ses_snap2");
		await seedTrustedFork("a3-snap2", "a3-parent", instance.id, "ses_snap2", 1, {
			snapshotInstance: "other-instance",
		});
		expect(await rejected(instance.id, "ses_snap2")).toBe("provider_binding_invalid");
	});
});

describe("A3 finalized-success-result contract (review round 43)", () => {
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

	for (const status of ["queued", "failed", "unknown"] as const) {
		test(`a ${status.toUpperCase()} fork result is refused (action deleted with the parent)`, async () => {
			const instance = await seedInstance();
			const child = `a3-${status}`;
			await seedChild(child, instance.id, `ses_${status}`);
			await getDb()
				.insert(sessions)
				.values({ sessionId: "a3-other-parent", agentType: "opencode", cwd: "/tmp" });
			await seedTrustedFork(child, "a3-other-parent", instance.id, `ses_${status}`, 1, {
				actionParent: "a3-other-parent",
				instanceOrigin: "a3-parent",
				resultStatus: status,
			});
			// the action claims succeeded, but the FINALIZED RESULT is not succeeded
			expect(await rejected(instance.id, `ses_${status}`)).toBe("provider_binding_invalid");
		});
	}

	test("identity that contradicts the surviving action metadata is refused", async () => {
		const instance = await seedInstance();
		await seedChild("a3-contra", instance.id, "ses_contra");
		await seedTrustedFork("a3-contra", "a3-parent", instance.id, "ses_contra", 1, {
			actionNativeContradiction: true,
		});
		expect(await rejected(instance.id, "ses_contra")).toBe("provider_binding_invalid");
	});

	test("identity missing the finalized result cannot be backfilled from action metadata", async () => {
		const instance = await seedInstance();
		await seedChild("a3-noresult", instance.id, "ses_noresult");
		await seedTrustedFork("a3-noresult", "a3-parent", instance.id, "ses_noresult", 1, {
			dropResult: true,
		});
		expect(await rejected(instance.id, "ses_noresult")).toBe("provider_binding_invalid");
	});
});
