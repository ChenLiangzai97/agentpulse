CREATE TABLE "provider_interactions" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"instance_id" text NOT NULL,
	"generation" integer NOT NULL,
	"native_request_id" text NOT NULL,
	"kind" text NOT NULL,
	"payload" json NOT NULL,
	"revision" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"action_id" text,
	"answered_by" text,
	"created_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"expires_at" text NOT NULL,
	"updated_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
ALTER TABLE "provider_interactions" ADD CONSTRAINT "provider_interactions_session_id_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_interactions" ADD CONSTRAINT "provider_interactions_instance_id_provider_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."provider_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_provider_interaction_request" ON "provider_interactions" USING btree ("instance_id","generation","kind","native_request_id");