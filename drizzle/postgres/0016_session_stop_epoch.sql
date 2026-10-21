ALTER TABLE "session_control_bindings" ADD COLUMN IF NOT EXISTS "stop_state" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "session_control_bindings" ADD COLUMN IF NOT EXISTS "stop_epoch" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Repair the historical pre-release 0015 shape (columns/FKs added later).
ALTER TABLE "opencode_forks" ADD COLUMN IF NOT EXISTS "provider_instance_id" text;--> statement-breakpoint
ALTER TABLE "opencode_forks" ADD COLUMN IF NOT EXISTS "native_session_id" text;--> statement-breakpoint
ALTER TABLE "opencode_forks" ADD COLUMN IF NOT EXISTS "generation" integer;--> statement-breakpoint
ALTER TABLE "opencode_fork_requests" ADD COLUMN IF NOT EXISTS "identity_json" text;--> statement-breakpoint
ALTER TABLE "provider_instances" ADD COLUMN IF NOT EXISTS "source_instance_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_fork_action_idem" ON "control_actions" (COALESCE("requested_by_user_id",''),"idempotency_key") WHERE "action_type" = 'opencode_fork' AND "idempotency_key" IS NOT NULL;
--> statement-breakpoint
-- Historical pre-release 0015 databases carry no FKs on opencode_forks.
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
