ALTER TABLE `session_control_bindings` ADD `stop_state` text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE `session_control_bindings` ADD `stop_epoch` integer DEFAULT 0 NOT NULL;
