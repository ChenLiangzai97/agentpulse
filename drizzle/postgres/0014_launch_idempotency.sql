ALTER TABLE "launch_requests" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "launch_requests" ADD COLUMN "idempotency_owner" text;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_launch_idempotency" ON "launch_requests" ("idempotency_owner","idempotency_key");
