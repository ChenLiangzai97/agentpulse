import {
	integer as pgInteger,
	pgTable,
	text as pgText,
	uniqueIndex as pgUniqueIndex,
} from "drizzle-orm/pg-core";
import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { jsonColumn, tsColumn } from "../factory.js";
import { providerInstancesPg, providerInstancesSqlite } from "./provider-control.js";
import { sessionsPg, sessionsSqlite } from "./sessions.js";
export const providerInteractionsSqlite = sqliteTable(
	"provider_interactions",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		sessionId: text("session_id")
			.notNull()
			.references(() => sessionsSqlite.sessionId, { onDelete: "cascade" }),
		instanceId: text("instance_id")
			.notNull()
			.references(() => providerInstancesSqlite.id, { onDelete: "cascade" }),
		generation: integer("generation").notNull(),
		nativeRequestId: text("native_request_id").notNull(),
		kind: text("kind").notNull(),
		payload: jsonColumn<Record<string, unknown>>("sqlite", "payload").notNull(),
		revision: text("revision").notNull(),
		status: text("status").notNull().default("pending"),
		actionId: text("action_id"),
		answeredBy: text("answered_by"),
		createdAt: tsColumn("sqlite", "created_at"),
		expiresAt: text("expires_at").notNull(),
		updatedAt: tsColumn("sqlite", "updated_at"),
	},
	(t) => ({
		identity: uniqueIndex("uq_provider_interaction_request").on(
			t.instanceId,
			t.generation,
			t.kind,
			t.nativeRequestId,
		),
	}),
);
export const providerInteractionsPg = pgTable(
	"provider_interactions",
	{
		id: pgText("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		sessionId: pgText("session_id")
			.notNull()
			.references(() => sessionsPg.sessionId, { onDelete: "cascade" }),
		instanceId: pgText("instance_id")
			.notNull()
			.references(() => providerInstancesPg.id, { onDelete: "cascade" }),
		generation: pgInteger("generation").notNull(),
		nativeRequestId: pgText("native_request_id").notNull(),
		kind: pgText("kind").notNull(),
		payload: jsonColumn<Record<string, unknown>>("postgres", "payload").notNull(),
		revision: pgText("revision").notNull(),
		status: pgText("status").notNull().default("pending"),
		actionId: pgText("action_id"),
		answeredBy: pgText("answered_by"),
		createdAt: tsColumn("postgres", "created_at"),
		expiresAt: pgText("expires_at").notNull(),
		updatedAt: tsColumn("postgres", "updated_at"),
	},
	(t) => ({
		identity: pgUniqueIndex("uq_provider_interaction_request").on(
			t.instanceId,
			t.generation,
			t.kind,
			t.nativeRequestId,
		),
	}),
);
