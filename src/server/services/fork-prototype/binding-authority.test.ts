/** Real-DB verification: child binding authority survives parent deletion
 * under binding-as-authority, while the CURRENT guard rejects it (A1 evidence). */
import "../../db/__test_db.js";
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { getDb, initializeDatabase } from "../../db/client.js";
import {
	launchRequests,
	managedSessions,
	providerInstances,
	sessionControlBindings,
	sessions,
	supervisors,
} from "../../db/schema/index.js";
import {
	assertSessionControlOrigin,
	inspectOpenCodeProvenance,
	reserveOpenCodeInstance,
} from "../opencode-control-provenance.js";
import { bindingAuthorityForSession } from "./binding-authority.js";

beforeAll(() => initializeDatabase());
beforeEach(async () => {
	for (const t of [
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
			id: "ba-host",
			hostName: "ba",
			platform: "linux",
			arch: "x64",
			version: "t",
			status: "connected",
			trustedRoots: ["/tmp"],
			capabilities: {},
		});
});

async function seedParentAndChild() {
	const [launch] = await getDb()
		.insert(launchRequests)
		.values({
			launchCorrelationId: "ba-parent",
			agentType: "opencode",
			cwd: "/tmp",
			requestedLaunchMode: "managed_opencode",
			claimedBySupervisorId: "ba-host",
			status: "launching",
		})
		.returning();
	const instance = await reserveOpenCodeInstance("ba-host", launch.id);
	await getDb()
		.update(providerInstances)
		.set({ state: "running" })
		.where(eq(providerInstances.id, instance.id));
	await getDb()
		.insert(sessions)
		.values({ sessionId: "ba-parent", agentType: "opencode", cwd: "/tmp" });
	await getDb().insert(managedSessions).values({
		sessionId: "ba-parent",
		launchRequestId: launch.id,
		supervisorId: "ba-host",
		providerSessionId: "ses_p",
		managedState: "managed",
	});
	await getDb()
		.insert(sessions)
		.values({ sessionId: "ba-child", agentType: "opencode", cwd: "/tmp" });
	await getDb().insert(managedSessions).values({
		sessionId: "ba-child",
		launchRequestId: launch.id,
		supervisorId: "ba-host",
		providerSessionId: "ses_c",
		managedState: "managed",
	});
	await getDb().insert(sessionControlBindings).values({
		sessionId: "ba-child",
		origin: "agentpulse_launch",
		instanceId: instance.id,
		nativeSessionId: "ses_c",
		generation: 1,
	});
	return { instanceId: instance.id };
}

describe("binding-as-authority (isolated prototype, real DB)", () => {
	test("child path CLOSED until the 0015 fork ledger — resolution is a lookup, not authorization", async () => {
		await seedParentAndChild();
		// The resolution helper still resolves (lookup only)…
		const resolved = await bindingAuthorityForSession("ba-child");
		expect(resolved.ok).toBe(true);
		// …but the REAL provenance check rejects the child until the ledger
		// ships: no binding-only shortcut.
		expect((await inspectOpenCodeProvenance("ba-child"))?.bindingValid).toBe(false);
		await getDb().delete(sessions).where(eq(sessions.sessionId, "ba-parent"));
		expect((await inspectOpenCodeProvenance("ba-child"))?.bindingValid).toBe(false);
	});

	test("authority checks generation and instance liveness (recovery semantics)", async () => {
		const { instanceId } = await seedParentAndChild();
		await getDb()
			.update(providerInstances)
			.set({ generation: 2 })
			.where(eq(providerInstances.id, instanceId));
		const stale = await bindingAuthorityForSession("ba-child");
		expect(stale.ok).toBe(false);
		if (!stale.ok) expect(stale.reason).toBe("generation_mismatch");
		await getDb()
			.update(providerInstances)
			.set({ generation: 1, state: "stopped" })
			.where(eq(providerInstances.id, instanceId));
		const stopped = await bindingAuthorityForSession("ba-child");
		expect(stopped.ok).toBe(false);
		if (!stopped.ok) expect(stopped.reason).toBe("instance_not_live");
	});
});

describe("A1 main-path authorization regression (real assertSessionControlOrigin paths)", () => {
	beforeEach(async () => {
		await getDb().delete(providerInstances);
	});

	test("a shared-instance CHILD is rejected by the REAL assertion until the fork ledger lands", async () => {
		await seedParentAndChild();
		const adminActor = { label: "user", userId: null, role: "admin", mode: "solo" } as const;
		await expect(assertSessionControlOrigin("ba-child", adminActor)).rejects.toThrow(
			"provider_binding_invalid",
		);
		// parent deletion changes nothing for the closed child path
		await getDb().delete(sessions).where(eq(sessions.sessionId, "ba-parent"));
		await expect(assertSessionControlOrigin("ba-child", adminActor)).rejects.toThrow(
			"provider_binding_invalid",
		);
	});

	test("generation bump invalidates the child through the real path (instance stop semantics)", async () => {
		const { instanceId } = await seedParentAndChild();
		await getDb()
			.update(providerInstances)
			.set({ generation: 2 })
			.where(eq(providerInstances.id, instanceId));
		expect((await inspectOpenCodeProvenance("ba-child"))?.bindingValid).toBe(false);
		const adminActor = { label: "user", userId: null, role: "admin", mode: "solo" } as const;
		await expect(assertSessionControlOrigin("ba-child", adminActor)).rejects.toThrow(
			"provider_binding_invalid",
		);
	});

	test("external / BotMux / legacy sessions remain permanently observe-only (unchanged by A1)", async () => {
		await getDb()
			.insert(sessions)
			.values({ sessionId: "a1-external", agentType: "opencode", cwd: "/tmp" });
		await getDb()
			.insert(sessionControlBindings)
			.values({ sessionId: "a1-external", origin: "external_observer" });
		await getDb()
			.insert(sessions)
			.values({ sessionId: "a1-legacy", agentType: "opencode", cwd: "/tmp" });
		const adminActor = { label: "user", userId: null, role: "admin", mode: "solo" } as const;
		await expect(assertSessionControlOrigin("a1-external", adminActor)).rejects.toThrow(
			"session_observe_only",
		);
		// no binding row at all → legacy_unknown origin, observe-only
		const provenance = await inspectOpenCodeProvenance("a1-legacy");
		expect(provenance?.origin).toBe("legacy_unknown");
		expect(provenance?.bindingValid).toBe(false);
	});

	test("fake metadata does NOT promote an external session (no metadata authority)", async () => {
		await getDb()
			.insert(sessions)
			.values({
				sessionId: "a1-fake",
				agentType: "opencode",
				cwd: "/tmp",
				metadata: { origin: "agentpulse_launch", controlCapabilities: { send: true } },
			});
		await getDb()
			.insert(sessionControlBindings)
			.values({ sessionId: "a1-fake", origin: "external_observer" });
		expect((await inspectOpenCodeProvenance("a1-fake"))?.bindingValid).toBe(false);
		const adminActor = { label: "user", userId: null, role: "admin", mode: "solo" } as const;
		await expect(assertSessionControlOrigin("a1-fake", adminActor)).rejects.toThrow(
			"session_observe_only",
		);
	});
});

describe("A1/A3 shared trusted-fork-child validation", () => {
	const adminActor = { label: "user", userId: null, role: "admin", mode: "solo" } as const;

	test("a FULLY trusted child (ledger+request+instance/native/generation) passes the REAL assertion", async () => {
		const { instanceId } = await seedParentAndChild();
		const { controlActions, opencodeForkRequests, opencodeForks } = await import(
			"../../db/schema/index.js"
		);
		const [action] = await getDb()
			.insert(controlActions)
			.values({
				sessionId: "ba-child",
				actionType: "opencode_fork",
				requestedBy: "user",
				status: "succeeded",
			})
			.returning();
		await getDb()
			.insert(opencodeForkRequests)
			.values({ actionId: action.id, requestHash: "h", parentSnapshot: { pinned: true } });
		await getDb().insert(opencodeForks).values({
			childSessionId: "ba-child",
			parentSessionId: "ba-parent",
			requestActionId: action.id,
			providerInstanceId: instanceId,
			nativeSessionId: "ses_c",
			generation: 1,
		});
		expect((await inspectOpenCodeProvenance("ba-child"))?.bindingValid).toBe(true);
		await expect(assertSessionControlOrigin("ba-child", adminActor)).resolves.toBeUndefined();
		// parent deletion keeps the child authorized (instance/launch association survives)
		await getDb().delete(sessions).where(eq(sessions.sessionId, "ba-parent"));
		expect((await inspectOpenCodeProvenance("ba-child"))?.bindingValid).toBe(true);
	});
});
