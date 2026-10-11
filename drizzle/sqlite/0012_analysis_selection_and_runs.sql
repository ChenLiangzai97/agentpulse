CREATE TABLE IF NOT EXISTS `ai_analysis_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`requested_by` text NOT NULL,
	`time_from` text,
	`time_to` text,
	`scope_sessions` text NOT NULL,
	`lease_owner` text,
	`lease_expires_at` text,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`last_error_code` text,
	`started_at` text,
	`completed_at` text,
	`prompt_version` text,
	`provider_kind` text,
	`provider_model` text,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cost_cents` integer DEFAULT 0 NOT NULL,
	`excluded_session_ids` text,
	`coverage` text,
	`report` text,
	`provenance` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_ai_analysis_runs_status_lease` ON `ai_analysis_runs` (`status`,`lease_expires_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_ai_analysis_runs_created` ON `ai_analysis_runs` (`created_at`);--> statement-breakpoint
ALTER TABLE `sessions` ADD `analysis_selected` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `analysis_selected_at` text;