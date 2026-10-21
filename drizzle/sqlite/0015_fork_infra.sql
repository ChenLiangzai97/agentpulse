CREATE TABLE `opencode_forks` (
	`child_session_id` text PRIMARY KEY NOT NULL,
	`parent_session_id` text,
	`parent_label_json` text,
	`fork_point_message_id` text,
	`request_action_id` text,
	`provider_instance_id` text,
	`native_session_id` text,
	`generation` integer,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`child_session_id`) REFERENCES `sessions`(`session_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_session_id`) REFERENCES `sessions`(`session_id`) ON UPDATE no action ON DELETE set null
);--> statement-breakpoint
CREATE INDEX `idx_opencode_forks_parent` ON `opencode_forks` (`parent_session_id`);--> statement-breakpoint
CREATE TABLE `opencode_fork_requests` (
	`action_id` text PRIMARY KEY NOT NULL,
	`request_hash` text NOT NULL,
	`parent_snapshot_json` text,
	`child_map_json` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`action_id`) REFERENCES `control_actions`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_fork_action_idem` ON `control_actions` (COALESCE(`requested_by_user_id`,''),`idempotency_key`) WHERE `action_type` = 'opencode_fork' AND `idempotency_key` IS NOT NULL;
