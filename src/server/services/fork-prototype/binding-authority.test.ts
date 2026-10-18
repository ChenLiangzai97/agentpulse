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
	await getDb()
		.insert(managedSessions)
		.values({
			sessionId: "ba-parent",
			launchRequestId: launch.id,
			supervisorId: "ba-host",
			providerSessionId: "ses_p",
			managedState: "managed",
		});
	await getDb()
		.insert(sessions)
		.values({ sessionId: "ba-child", agentType: "opencode", cwd: "/tmp" });
	await getDb()
		.insert(managedSessions)
		.values({
			sessionId: "ba-child",
			launchRequestId: launch.id,
			supervisorId: "ba-host",
			providerSessionId: "ses_c",
			managedState: "managed",
		});
	await getDb()
		.insert(sessionControlBindings)
		.values({
			sessionId: "ba-child",
			origin: "agentpulse_launch",
			instanceId: instance.id,
			nativeSessionId: "ses_c",
			generation: 1,
		});
	return { instanceId: instance.id };
}

describe("binding-as-authority (isolated prototype, real DB)", () => {
	test("child authority resolves while the CURRENT guard rejects it — and survives parent deletion", async () => {
		await seedParentAndChild();
		// Current single-session guard: invalid (A1 evidence).
		expect((await inspectOpenCodeProvenance("ba-child"))?.bindingValid).toBe(false);
		// Prototype authority: valid.
		const before = await bindingAuthorityForSession("ba-child");
		expect(before.ok).toBe(true);
		// Delete the parent session — rows + child authority survive.
		await getDb().delete(sessions).where(eq(sessions.sessionId, "ba-parent"));
		const after = await bindingAuthorityForSession("ba-child");
		expect(after.ok).toBe(true);
		if (after.ok) expect(after.authority.nativeSessionId).toBe("ses_c");
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
