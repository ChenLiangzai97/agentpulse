/**
 * OpenCode session prefs + catalog metadata interleaving (review blockers:
 * server-side session config & switch isolation; concurrent metadata updates).
 *
 * sessions.metadata is written by several independent writers — the snapshot
 * path persists opencodeCatalog, the prefs endpoint persists opencodePrefs,
 * and other features (permissionWait, worklogInclude, ...) touch unrelated
 * keys. Every one of these must be a dialect-native single-key update
 * (json_set / jsonb_set) so no writer clobbers another's keys, and prefs
 * writes stay managed-only: observe-only sessions may read but never steer.
 */
import "../db/__test_db.js";
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { config } from "../config.js";
import { getDb, initializeDatabase } from "../db/client.js";
import {
	launchRequests,
	managedSessions,
	providerInstances,
	sessionControlBindings,
	sessions,
	supervisors,
} from "../db/schema/index.js";
import {
	bindCreatedOpenCodeSession,
	reserveOpenCodeInstance,
} from "./opencode-control-provenance.js";
import {
	acceptOpenCodeSnapshot,
	readOpenCodePrefs,
	writeOpenCodePrefs,
} from "./opencode-managed.js";

const admin = { label: "user", userId: null, role: "admin", mode: "solo" } as const;
const oldDisableAuth = config.disableAuth;

beforeAll(async () => {
	await initializeDatabase();
	config.disableAuth = true;
});
afterAll(() => {
	config.disableAuth = oldDisableAuth;
});
beforeEach(async () => {
	for (const table of [
		sessionControlBindings,
		providerInstances,
		managedSessions,
		launchRequests,
		sessions,
		supervisors,
	])
		await getDb().delete(table);
	await getDb()
		.insert(supervisors)
		.values({
			id: "p1-host",
			hostName: "p1-host",
			platform: "linux",
			arch: "x64",
			version: "test",
			status: "connected",
			trustedRoots: ["/tmp"],
			capabilities: {},
		});
});

async function managedFixture(sessionId = "managed") {
	const [launch] = await getDb()
		.insert(launchRequests)
		.values({
			launchCorrelationId: sessionId,
			agentType: "opencode",
			cwd: "/tmp/p1",
			requestedLaunchMode: "managed_opencode",
			claimedBySupervisorId: "p1-host",
			status: "launching",
		})
		.returning();
	const instance = await reserveOpenCodeInstance("p1-host", launch.id);
	await getDb()
		.update(providerInstances)
		.set({ state: "running" })
		.where(eq(providerInstances.id, instance.id));
	await getDb().insert(sessions).values({ sessionId, agentType: "opencode", cwd: "/tmp/p1" });
	await getDb().insert(managedSessions).values({
		sessionId,
		launchRequestId: launch.id,
		supervisorId: "p1-host",
		providerSessionId: "ses_nativefixture",
		managedState: "managed",
	});
	await bindCreatedOpenCodeSession("p1-host", instance.id, "ses_nativefixture", 1);
	return { launch, instance };
}

async function externalFixture(sessionId = "external") {
	await getDb().insert(sessions).values({ sessionId, agentType: "opencode", cwd: "/tmp/ext" });
	await getDb().insert(sessionControlBindings).values({ sessionId, origin: "external_observer" });
}

async function metadataOf(sessionId: string): Promise<Record<string, unknown>> {
	const [row] = await getDb().select().from(sessions).where(eq(sessions.sessionId, sessionId));
	return (row?.metadata ?? {}) as Record<string, unknown>;
}

function snapshotWithCommands(commands: unknown[]) {
	return {
		generation: 1,
		nativeSessionId: "ses_nativefixture",
		messages: [],
		permissions: [],
		questions: [],
		status: { type: "idle" },
		commands,
		agents: [{ name: "build", description: "d", mode: "primary" }],
		providers: { providers: [{ id: "p1", name: "P", models: { m1: {}, m2: {} } }] },
	};
}

test("prefs default to null and persist per session on managed origins", async () => {
	await managedFixture();
	expect(await readOpenCodePrefs("managed")).toEqual({ model: null, agent: null });
	const written = await writeOpenCodePrefs("managed", { model: "m1", agent: "build" }, admin);
	expect(written).toEqual({ model: "m1", agent: "build" });
	expect(await readOpenCodePrefs("managed")).toEqual({ model: "m1", agent: "build" });
	// A partial update leaves the untouched field alone.
	await writeOpenCodePrefs("managed", { agent: null }, admin);
	expect(await readOpenCodePrefs("managed")).toEqual({ model: "m1", agent: null });
});

test("observe-only sessions can read prefs but never write them", async () => {
	await externalFixture();
	expect(await readOpenCodePrefs("external")).toEqual({ model: null, agent: null });
	await expect(writeOpenCodePrefs("external", { model: "m1" }, admin)).rejects.toThrow(
		"session_observe_only",
	);
	expect(await readOpenCodePrefs("external")).toEqual({ model: null, agent: null });
});

test("prefs write is a single-key update: unrelated metadata keys survive", async () => {
	await managedFixture();
	await getDb()
		.update(sessions)
		.set({ metadata: { worklogInclude: false, pinnedBy: "ui", opencodeCatalog: { stale: true } } })
		.where(eq(sessions.sessionId, "managed"));
	await writeOpenCodePrefs("managed", { model: "m2" }, admin);
	const metadata = await metadataOf("managed");
	expect(metadata.worklogInclude).toBe(false);
	expect(metadata.pinnedBy).toBe("ui");
	// Even a same-object sibling (catalog) is preserved — only opencodePrefs is touched.
	expect(metadata.opencodeCatalog).toEqual({ stale: true });
	expect(metadata.opencodePrefs).toEqual({ model: "m2", agent: null });
});

test("snapshot catalog update never clobbers prefs or unrelated keys (interleaving regression)", async () => {
	const { instance } = await managedFixture();
	await getDb()
		.update(sessions)
		.set({ metadata: { worklogInclude: false, opencodePrefs: { model: "m1", agent: "build" } } })
		.where(eq(sessions.sessionId, "managed"));
	await acceptOpenCodeSnapshot(
		"p1-host",
		instance.id,
		snapshotWithCommands([
			{ name: "init", description: "d", source: "command", template: "x" },
			{ name: "skill-x", description: "s", source: "skill" },
		]),
	);
	const metadata = await metadataOf("managed");
	// Catalog replaced atomically…
	const catalog = metadata.opencodeCatalog as {
		commands: { name: string }[];
		agents: unknown[];
		providers: unknown[];
	};
	expect(catalog.commands).toHaveLength(1);
	expect(catalog.commands[0].name).toBe("init");
	// …while the concurrent-writer keys survive intact.
	expect(metadata.worklogInclude).toBe(false);
	expect(metadata.opencodePrefs).toEqual({ model: "m1", agent: "build" });
});

test("snapshot catalog and prefs writes interleave without losing each other", async () => {
	const { instance } = await managedFixture();
	await acceptOpenCodeSnapshot(
		"p1-host",
		instance.id,
		snapshotWithCommands([{ name: "init", description: "d", source: "command" }]),
	);
	await writeOpenCodePrefs("managed", { model: "m9", agent: "plan" }, admin);
	await acceptOpenCodeSnapshot(
		"p1-host",
		instance.id,
		snapshotWithCommands([{ name: "init", description: "d2", source: "command" }]),
	);
	const metadata = await metadataOf("managed");
	expect((metadata.opencodePrefs as { model: string }).model).toBe("m9");
	const catalog = metadata.opencodeCatalog as { commands: { description: string }[] };
	expect(catalog.commands[0].description).toBe("d2");
});
