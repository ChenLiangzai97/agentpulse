/** Server-owned provenance. Hook/session metadata is never an authority input. */
import { sql } from "drizzle-orm";
import {
	check as pgCheck,
	integer as pgInteger,
	pgTable,
	text as pgText,
	uniqueIndex as pgUniqueIndex,
} from "drizzle-orm/pg-core";
import { check, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { tsColumn } from "../factory.js";
import { launchRequestsPg, launchRequestsSqlite } from "./launch-requests.js";
import { sessionsPg, sessionsSqlite } from "./sessions.js";
import { supervisorsPg, supervisorsSqlite } from "./supervisors.js";

export const providerInstancesSqlite = sqliteTable(
	"provider_instances",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		agentType: text("agent_type").notNull(),
		supervisorId: text("supervisor_id")
			.notNull()
			.references(() => supervisorsSqlite.id, { onDelete: "cascade" }),
		launchRequestId: text("launch_request_id")
			.notNull()
			.unique()
			.references(() => launchRequestsSqlite.id, { onDelete: "cascade" }),
		sessionId: text("session_id").notNull().unique(),
		cwd: text("cwd").notNull(),
		generation: integer("generation").notNull().default(1),
		state: text("state").notNull().default("reserved"),
		protocolVersion: text("protocol_version"),
		createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
	},
	(t) => ({ generationCheck: check("provider_instances_generation", sql`${t.generation} > 0`) }),
);

export const providerInstancesPg = pgTable(
	"provider_instances",
	{
		id: pgText("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		agentType: pgText("agent_type").notNull(),
		supervisorId: pgText("supervisor_id")
			.notNull()
			.references(() => supervisorsPg.id, { onDelete: "cascade" }),
		launchRequestId: pgText("launch_request_id")
			.notNull()
			.unique()
			.references(() => launchRequestsPg.id, { onDelete: "cascade" }),
		sessionId: pgText("session_id").notNull().unique(),
		cwd: pgText("cwd").notNull(),
		generation: pgInteger("generation").notNull().default(1),
		state: pgText("state").notNull().default("reserved"),
		protocolVersion: pgText("protocol_version"),
		createdAt: tsColumn("postgres", "created_at"),
	},
	(t) => ({ generationCheck: pgCheck("provider_instances_generation", sql`${t.generation} > 0`) }),
);

export const sessionControlBindingsSqlite = sqliteTable(
	"session_control_bindings",
	{
		sessionId: text("session_id")
			.primaryKey()
			.references(() => sessionsSqlite.sessionId, { onDelete: "cascade" }),
		origin: text("origin").notNull(),
		instanceId: text("instance_id").references(() => providerInstancesSqlite.id, {
			onDelete: "cascade",
		}),
		nativeSessionId: text("native_session_id"),
		generation: integer("generation"),
		createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
	},
	(t) => ({
		nativeIdentity: uniqueIndex("uq_control_binding_native").on(t.instanceId, t.nativeSessionId),
		originCheck: check(
			"control_binding_origin",
			sql`${t.origin} IN ('agentpulse_launch', 'external_observer', 'legacy_unknown')`,
		),
		bindingCheck: check(
			"control_binding_fields",
			sql`(${t.origin} = 'agentpulse_launch' AND ${t.instanceId} IS NOT NULL AND ${t.nativeSessionId} IS NOT NULL AND ${t.generation} IS NOT NULL AND ${t.generation} > 0) OR (${t.origin} <> 'agentpulse_launch' AND ${t.instanceId} IS NULL AND ${t.nativeSessionId} IS NULL AND ${t.generation} IS NULL)`,
		),
	}),
);

export const sessionControlBindingsPg = pgTable(
	"session_control_bindings",
	{
		sessionId: pgText("session_id")
			.primaryKey()
			.references(() => sessionsPg.sessionId, { onDelete: "cascade" }),
		origin: pgText("origin").notNull(),
		instanceId: pgText("instance_id").references(() => providerInstancesPg.id, {
			onDelete: "cascade",
		}),
		nativeSessionId: pgText("native_session_id"),
		generation: pgInteger("generation"),
		createdAt: tsColumn("postgres", "created_at"),
	},
	(t) => ({
		nativeIdentity: pgUniqueIndex("uq_control_binding_native").on(t.instanceId, t.nativeSessionId),
		originCheck: pgCheck(
			"control_binding_origin",
			sql`${t.origin} IN ('agentpulse_launch', 'external_observer', 'legacy_unknown')`,
		),
		bindingCheck: pgCheck(
			"control_binding_fields",
			sql`(${t.origin} = 'agentpulse_launch' AND ${t.instanceId} IS NOT NULL AND ${t.nativeSessionId} IS NOT NULL AND ${t.generation} IS NOT NULL AND ${t.generation} > 0) OR (${t.origin} <> 'agentpulse_launch' AND ${t.instanceId} IS NULL AND ${t.nativeSessionId} IS NULL AND ${t.generation} IS NULL)`,
		),
	}),
);
