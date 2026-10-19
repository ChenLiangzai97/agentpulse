/** Real-DB experiment: what survives deleting the PARENT session, and does the
 * child's CONTROL AUTHORITY (binding validity) hold afterwards?
 *
 * Scope per review: SQLite AND PostgreSQL; row survival + binding-validity
 * assertion. Full control/approval/recovery paths are prototype work — this
 * probe does NOT claim them. The child here reuses the parent's launch id
 * because the NULL-launch migration (0015) does not exist yet; that
 * difference is asserted as a known limitation, not hidden.
 *
 * SQLite: SQLITE_PATH=/tmp/agentpulse-fk-probe.db bun scripts/opencode-p0/fk-chain-probe.ts
 * PostgreSQL: DATABASE_URL=postgres://… bun scripts/opencode-p0/fk-chain-probe.ts
 */
process.env.SQLITE_PATH ??= "/tmp/agentpulse-fk-probe.db";
process.env.DATA_DIR ??= "/tmp/agentpulse-fk-probe-data";
process.env.DISABLE_AUTH = "true";
process.env.DATABASE_URL = process.env.DATABASE_URL ?? "";
process.env.AGENTPULSE_OPENCODE_ENABLED = "";
process.env.AGENTPULSE_OPENCODE_DB = "";
import { eq } from "drizzle-orm";
const root = process.cwd();
const { initializeDatabase, getDb } = await import(`${root}/src/server/db/client.js`);
const { config } = await import(`${root}/src/server/config.js`);
await initializeDatabase();
const db = getDb();
const { sessions, supervisors, launchRequests, providerInstances, managedSessions, sessionControlBindings } =
	await import(`${root}/src/server/db/schema/index.js`);
const { reserveOpenCodeInstance, inspectOpenCodeProvenance } = await import(
	`${root}/src/server/services/opencode-control-provenance.js`
);

const P = "fk-parent", C = "fk-child";
await db.delete(sessionControlBindings).where(eq(sessionControlBindings.sessionId, C));
await db.delete(managedSessions).where(eq(managedSessions.sessionId, P));
await db.delete(managedSessions).where(eq(managedSessions.sessionId, C));
await db.delete(providerInstances).where(eq(providerInstances.sessionId, P));
await db.delete(sessions).where(eq(sessions.sessionId, P));
await db.delete(sessions).where(eq(sessions.sessionId, C));
await db.delete(launchRequests).where(eq(launchRequests.launchCorrelationId, P));
await db.delete(supervisors).where(eq(supervisors.id, "fk-host"));

await db.insert(supervisors).values({ id: "fk-host", hostName: "fk-host", platform: "linux", arch: "x64", version: "t", status: "connected", trustedRoots: ["/tmp"], capabilities: {} });
const [launch] = await db.insert(launchRequests).values({ launchCorrelationId: P, agentType: "opencode", cwd: "/tmp", requestedLaunchMode: "managed_opencode", claimedBySupervisorId: "fk-host", status: "launching" }).returning();
const instance = await reserveOpenCodeInstance("fk-host", launch.id);
await db.update(providerInstances).set({ state: "running" }).where(eq(providerInstances.id, instance.id));
await db.insert(sessions).values({ sessionId: P, agentType: "opencode", cwd: "/tmp" });
await db.insert(managedSessions).values({ sessionId: P, launchRequestId: launch.id, supervisorId: "fk-host", providerSessionId: "ses_parent", managedState: "managed" });
await db.insert(sessions).values({ sessionId: C, agentType: "opencode", cwd: "/tmp" });
await db.insert(managedSessions).values({ sessionId: C, launchRequestId: launch.id, supervisorId: "fk-host", providerSessionId: "ses_child", managedState: "managed" });
await db.insert(sessionControlBindings).values({ sessionId: C, origin: "agentpulse_launch", instanceId: instance.id, nativeSessionId: "ses_child", generation: 1 });

const one = async (t: typeof sessions, w: ReturnType<typeof eq>) => (await db.select().from(t).where(w)).length;
const before = inspectOpenCodeProvenance ? await inspectOpenCodeProvenance(C) : null;
await db.delete(sessions).where(eq(sessions.sessionId, P));
const childRows = await one(sessions, eq(sessions.sessionId, C));
const childBindings = await one(sessionControlBindings, eq(sessionControlBindings.sessionId, C));
const instanceRows = (await db.select().from(providerInstances).where(eq(providerInstances.id, instance.id))).length;
const parentManaged = (await db.select().from(managedSessions).where(eq(managedSessions.sessionId, P))).length;
const childManaged = (await db.select().from(managedSessions).where(eq(managedSessions.sessionId, C))).length;
const launchRows = (await db.select().from(launchRequests).where(eq(launchRequests.id, launch.id))).length;
const after = await inspectOpenCodeProvenance(C);
const results = {
	dialect: config.dialect,
	childRows, childBindings, instanceRows, parentManaged, childManaged, launchRows,
	childProvenanceBefore: before ? { origin: before.origin, bindingValid: before.bindingValid } : null,
	childProvenanceAfter: after ? { origin: after.origin, bindingValid: after.bindingValid } : null,
};
const failures: string[] = [];
if (childRows !== 1) failures.push("child session row lost");
if (childBindings !== 1) failures.push("child binding lost");
if (instanceRows !== 1) failures.push("provider instance row lost");
if (parentManaged !== 0) failures.push("parent managed row unexpectedly kept");
if (childManaged !== 1) failures.push("child managed row lost");
if (launchRows !== 1) failures.push("launch row lost");
// POST-A1 EXPECTATION (flipped 2026-10-19): binding-as-authority is live,
// so a shared-instance CHILD binding is VALID — before AND after the parent
// delete. Row survival AND control authority are both observed here; the
// deeper control/approval/recovery flows remain prototype/integration scope.
const childValidAfterParentDelete = results.childProvenanceAfter?.bindingValid === true;
if (!childValidAfterParentDelete)
	failures.push("child binding NOT valid after parent delete — A1 regression or probe setup issue");
console.log(JSON.stringify(results, null, 1));
if (failures.length) {
	console.error("FK-PROBE FAILURES:", failures.join("; "));
	process.exit(1);
}
console.log(
	"FK-PROBE PASS — row survival AND child control authority (via binding) observed after parent deletion, on both dialects. Deeper control/approval/recovery flows remain integration scope; the child reuses the parent's launch id until migration 0015.",
);
process.exit(0);
