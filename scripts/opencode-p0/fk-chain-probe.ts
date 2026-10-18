/** Real-DB experiment: what actually cascades when the PARENT session is deleted. */
process.env.SQLITE_PATH = "/tmp/agentpulse-fk-probe.db";
process.env.DATA_DIR = "/tmp/agentpulse-fk-probe-data";
process.env.DISABLE_AUTH = "true";
process.env.DATABASE_URL = "";
process.env.AGENTPULSE_OPENCODE_ENABLED = "";
import { eq } from "drizzle-orm";
const { initializeDatabase, getDb } = await import("/home/ch/project/work_station/agentpulse/src/server/db/client.js");
await initializeDatabase();
const db = getDb();
const { sessions, supervisors, launchRequests, providerInstances, managedSessions, sessionControlBindings, events } =
	await import("/home/ch/project/work_station/agentpulse/src/server/db/schema/index.js");
const { reserveOpenCodeInstance } = await import("/home/ch/project/work_station/agentpulse/src/server/services/opencode-control-provenance.js");

await db.insert(supervisors).values({ id: "fk-host", hostName: "fk-host", platform: "linux", arch: "x64", version: "t", status: "connected", trustedRoots: ["/tmp"], capabilities: {} });
const [launch] = await db.insert(launchRequests).values({ launchCorrelationId: "fk-parent", agentType: "opencode", cwd: "/tmp", requestedLaunchMode: "managed_opencode", claimedBySupervisorId: "fk-host", status: "launching" }).returning();
const instance = await reserveOpenCodeInstance("fk-host", launch.id);
await db.insert(sessions).values({ sessionId: "fk-parent", agentType: "opencode", cwd: "/tmp" });
await db.insert(managedSessions).values({ sessionId: "fk-parent", launchRequestId: launch.id, supervisorId: "fk-host", providerSessionId: "ses_parent", managedState: "managed" });
// child per design v2: own session row + binding to the SAME instance + own managed row (launch NULL needs migration; use parent's launch for the experiment)
await db.insert(sessions).values({ sessionId: "fk-child", agentType: "opencode", cwd: "/tmp" });
await db.insert(managedSessions).values({ sessionId: "fk-child", launchRequestId: launch.id, supervisorId: "fk-host", providerSessionId: "ses_child", managedState: "managed" });
await db.insert(sessionControlBindings).values({ sessionId: "fk-child", origin: "agentpulse_launch", instanceId: instance.id, nativeSessionId: "ses_child", generation: 1 });

const count = async (table: typeof sessions, where: ReturnType<typeof eq>) => (await db.select().from(table).where(where)).length;
console.log("before delete: parent", await count(sessions, eq(sessions.sessionId, "fk-parent")), "| child", await count(sessions, eq(sessions.sessionId, "fk-child")));
await db.delete(sessions).where(eq(sessions.sessionId, "fk-parent"));
console.log("after parent delete:");
console.log("  child session row:", await count(sessions, eq(sessions.sessionId, "fk-child")));
console.log("  child binding:", await count(sessionControlBindings, eq(sessionControlBindings.sessionId, "fk-child")));
console.log("  provider instance:", (await db.select().from(providerInstances).where(eq(providerInstances.id, instance.id))).length);
console.log("  parent managed row:", (await db.select().from(managedSessions).where(eq(managedSessions.sessionId, "fk-parent"))).length);
console.log("  child managed row:", (await db.select().from(managedSessions).where(eq(managedSessions.sessionId, "fk-child"))).length);
console.log("  launch request:", (await db.select().from(launchRequests).where(eq(launchRequests.id, launch.id))).length);
process.exit(0);
