import {
	index as pgIndex,
	integer as pgInteger,
	pgTable,
	text as pgText,
} from "drizzle-orm/pg-core";
import { integer, index as sqliteIndex, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { jsonColumn, tsColumn } from "../factory.js";

export const opencodeForksSqlite = sqliteTable(
	"opencode_forks",
	{
		childSessionId: text("child_session_id").primaryKey(),
		parentSessionId: text("parent_session_id"),
		parentLabel: jsonColumn<Record<string, unknown>>("sqlite", "parent_label_json"),
		forkPointMessageId: text("fork_point_message_id"),
		requestActionId: text("request_action_id"),
		/** Trusted creation binding: the exact instance/native identity/generation. */
		providerInstanceId: text("provider_instance_id"),
		nativeSessionId: text("native_session_id"),
		generation: integer("generation"),
		createdAt: tsColumn("sqlite", "created_at"),
	},
	(t) => [sqliteIndex("idx_opencode_forks_parent").on(t.parentSessionId)],
);

export const opencodeForksPg = pgTable(
	"opencode_forks",
	{
		childSessionId: pgText("child_session_id").primaryKey(),
		parentSessionId: pgText("parent_session_id"),
		parentLabel: jsonColumn<Record<string, unknown>>("postgres", "parent_label_json"),
		forkPointMessageId: pgText("fork_point_message_id"),
		requestActionId: pgText("request_action_id"),
		providerInstanceId: pgText("provider_instance_id"),
		nativeSessionId: pgText("native_session_id"),
		generation: pgInteger("generation"),
		createdAt: tsColumn("postgres", "created_at"),
	},
	(t) => [pgIndex("idx_opencode_forks_parent").on(t.parentSessionId)],
);

export const opencodeForkRequestsSqlite = sqliteTable("opencode_fork_requests", {
	actionId: text("action_id").primaryKey(),
	requestHash: text("request_hash").notNull(),
	parentSnapshot: jsonColumn<Record<string, unknown> | null>("sqlite", "parent_snapshot_json"),
	childMap: jsonColumn<Record<string, unknown> | null>("sqlite", "child_map_json"),
	createdAt: tsColumn("sqlite", "created_at"),
});

export const opencodeForkRequestsPg = pgTable("opencode_fork_requests", {
	actionId: pgText("action_id").primaryKey(),
	requestHash: pgText("request_hash").notNull(),
	parentSnapshot: jsonColumn<Record<string, unknown> | null>("postgres", "parent_snapshot_json"),
	childMap: jsonColumn<Record<string, unknown> | null>("postgres", "child_map_json"),
	createdAt: tsColumn("postgres", "created_at"),
});
