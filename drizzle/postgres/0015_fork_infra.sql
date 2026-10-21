CREATE TABLE IF NOT EXISTS "opencode_forks" (
	"child_session_id" text PRIMARY KEY NOT NULL,
	"parent_session_id" text,
	"parent_label_json" text,
	"fork_point_message_id" text,
	"request_action_id" text,
	"provider_instance_id" text,
	"native_session_id" text,
	"generation" integer,
	"created_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "opencode_forks_child_session_id_sessions_session_id_fk" FOREIGN KEY ("child_session_id") REFERENCES "sessions"("session_id") ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "opencode_forks_parent_session_id_sessions_session_id_fk" FOREIGN KEY ("parent_session_id") REFERENCES "sessions"("session_id") ON UPDATE no action ON DELETE set null
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_opencode_forks_parent" ON "opencode_forks" ("parent_session_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "opencode_fork_requests" (
	"action_id" text PRIMARY KEY NOT NULL,
	"request_hash" text NOT NULL,
	"identity_json" text,
	"parent_snapshot_json" text,
	"child_map_json" text,
	"created_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_fork_action_idem" ON "control_actions" (COALESCE("requested_by_user_id",''),"idempotency_key") WHERE "action_type" = 'opencode_fork' AND "idempotency_key" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_instances" ADD COLUMN IF NOT EXISTS "source_instance_id" text;--> statement-breakpoint
-- Historical pre-release 0015 databases have no FKs on opencode_forks: add them
-- idempotently (a fresh table already carries them inline).
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'opencode_forks_child_session_id_sessions_session_id_fk'
	) THEN
		ALTER TABLE "opencode_forks"
			ADD CONSTRAINT "opencode_forks_child_session_id_sessions_session_id_fk"
			FOREIGN KEY ("child_session_id") REFERENCES "sessions"("session_id") ON DELETE cascade;
	END IF;
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'opencode_forks_parent_session_id_sessions_session_id_fk'
	) THEN
		ALTER TABLE "opencode_forks"
			ADD CONSTRAINT "opencode_forks_parent_session_id_sessions_session_id_fk"
			FOREIGN KEY ("parent_session_id") REFERENCES "sessions"("session_id") ON DELETE set null;
	END IF;
END $$;
