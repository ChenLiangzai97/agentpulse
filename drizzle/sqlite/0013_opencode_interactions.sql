CREATE TABLE `provider_interactions` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`instance_id` text NOT NULL,
	`generation` integer NOT NULL,
	`native_request_id` text NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`revision` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`action_id` text,
	`answered_by` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`expires_at` text NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`session_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`instance_id`) REFERENCES `provider_instances`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_provider_interaction_request` ON `provider_interactions` (`instance_id`,`generation`,`kind`,`native_request_id`);