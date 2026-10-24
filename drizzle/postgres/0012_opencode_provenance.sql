CREATE TABLE "provider_instances" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_type" text NOT NULL,
	"supervisor_id" text NOT NULL,
	"launch_request_id" text NOT NULL,
	"session_id" text NOT NULL,
	"cwd" text NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"state" text DEFAULT 'reserved' NOT NULL,
	"protocol_version" text,
	"created_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "provider_instances_launch_request_id_unique" UNIQUE("launch_request_id"),
	CONSTRAINT "provider_instances_session_id_unique" UNIQUE("session_id"),
	CONSTRAINT "provider_instances_generation" CHECK ("provider_instances"."generation" > 0)
);
--> statement-breakpoint
CREATE TABLE "session_control_bindings" (
	"session_id" text PRIMARY KEY NOT NULL,
	"origin" text NOT NULL,
	"instance_id" text,
	"native_session_id" text,
	"generation" integer,
	"created_at" text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "control_binding_origin" CHECK ("session_control_bindings"."origin" IN ('agentpulse_launch', 'external_observer', 'legacy_unknown')),
	CONSTRAINT "control_binding_fields" CHECK (("session_control_bindings"."origin" = 'agentpulse_launch' AND "session_control_bindings"."instance_id" IS NOT NULL AND "session_control_bindings"."native_session_id" IS NOT NULL AND "session_control_bindings"."generation" IS NOT NULL AND "session_control_bindings"."generation" > 0) OR ("session_control_bindings"."origin" <> 'agentpulse_launch' AND "session_control_bindings"."instance_id" IS NULL AND "session_control_bindings"."native_session_id" IS NULL AND "session_control_bindings"."generation" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "provider_instances" ADD CONSTRAINT "provider_instances_supervisor_id_supervisors_id_fk" FOREIGN KEY ("supervisor_id") REFERENCES "public"."supervisors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_instances" ADD CONSTRAINT "provider_instances_launch_request_id_launch_requests_id_fk" FOREIGN KEY ("launch_request_id") REFERENCES "public"."launch_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_control_bindings" ADD CONSTRAINT "session_control_bindings_session_id_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_control_bindings" ADD CONSTRAINT "session_control_bindings_instance_id_provider_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."provider_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_control_binding_native" ON "session_control_bindings" USING btree ("instance_id","native_session_id");
--> statement-breakpoint
INSERT INTO session_control_bindings (session_id, origin) SELECT session_id, 'legacy_unknown' FROM sessions WHERE agent_type = 'opencode' ON CONFLICT (session_id) DO NOTHING;
