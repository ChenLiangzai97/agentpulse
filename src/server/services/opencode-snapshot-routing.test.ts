/** A3 snapshot-routing regressions: nativeSessionId decides the target session;
 *  unbound native sessions are rejected; ledger-less child bindings rejected;
 *  parent binding still routes; parent-failure shapes never leak in. */
import "../db/__test_db.js";
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { getDb, initializeDatabase } from "../db/client.js";
import {
	launchRequests,
	managedSessions,
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
	await getDb()
		.insert(managedSessions)
		.values({
			sessionId: "a3-parent",
			launchRequestId: launch.id,
			supervisorId: "a3-host",
			providerSessionId: "ses_parent",
			managedState: "managed",
		});
	await bindCreatedOpenCodeSession("a3-host", instance.id, "ses_parent", 1);
	return instance;
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
		await getDb()
			.insert(sessionControlBindings)
			.values({
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
		await getDb()
			.insert(sessionControlBindings)
			.values({
				sessionId: "a3-child",
				origin: "agentpulse_launch",
				instanceId: instance.id,
				nativeSessionId: "ses_child",
				generation: 1,
			});
		await getDb()
			.insert(opencodeForks)
			.values({
				childSessionId: "a3-child",
				parentSessionId: "a3-parent",
				forkPointMessageId: null,
				requestActionId: null,
			});
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
		await getDb()
			.insert(sessionControlBindings)
			.values({
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
