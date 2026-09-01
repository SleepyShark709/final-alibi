CREATE TABLE `agent_threads` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`character_id` text NOT NULL,
	`graph_name` text NOT NULL,
	`checkpoint_thread_id` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`state_json` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `game_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_threads_session_character_graph_unique` ON `agent_threads` (`session_id`,`character_id`,`graph_name`);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_threads_checkpoint_unique` ON `agent_threads` (`checkpoint_thread_id`);--> statement-breakpoint
CREATE TABLE `anonymous_players` (
	`id` text PRIMARY KEY NOT NULL,
	`access_token_hash` text NOT NULL,
	`created_at` text NOT NULL,
	`last_seen_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `anonymous_players_access_token_hash_unique` ON `anonymous_players` (`access_token_hash`);--> statement-breakpoint
CREATE TABLE `case_artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`schema_version` integer NOT NULL,
	`source` text NOT NULL,
	`status` text NOT NULL,
	`seed` text NOT NULL,
	`content_hash` text NOT NULL,
	`artifact_json` text NOT NULL,
	`generation_metadata_json` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `case_artifacts_seed_hash_unique` ON `case_artifacts` (`seed`,`content_hash`);--> statement-breakpoint
CREATE INDEX `case_artifacts_status_idx` ON `case_artifacts` (`status`);--> statement-breakpoint
CREATE TABLE `game_commands` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`player_id` text NOT NULL,
	`command_id` text NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`base_revision` integer NOT NULL,
	`committed_revision` integer,
	`request_json` text NOT NULL,
	`result_json` text,
	`error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `game_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`player_id`) REFERENCES `anonymous_players`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `game_commands_session_command_unique` ON `game_commands` (`session_id`,`command_id`);--> statement-breakpoint
CREATE INDEX `game_commands_status_updated_idx` ON `game_commands` (`status`,`updated_at`);--> statement-breakpoint
CREATE TABLE `game_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`command_id` text NOT NULL,
	`type` text NOT NULL,
	`summary` text NOT NULL,
	`payload_json` text NOT NULL,
	`occurred_at` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `game_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `game_events_session_sequence_unique` ON `game_events` (`session_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `game_events_session_command_idx` ON `game_events` (`session_id`,`command_id`);--> statement-breakpoint
CREATE TABLE `game_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`player_id` text NOT NULL,
	`case_id` text NOT NULL,
	`status` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`state_json` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`closed_at` text,
	FOREIGN KEY (`player_id`) REFERENCES `anonymous_players`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`case_id`) REFERENCES `case_artifacts`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `game_sessions_player_updated_idx` ON `game_sessions` (`player_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `game_sessions_case_idx` ON `game_sessions` (`case_id`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`player_id` text,
	`type` text NOT NULL,
	`status` text NOT NULL,
	`payload_json` text NOT NULL,
	`result_json` text,
	`error` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 3 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`started_at` text,
	`finished_at` text,
	FOREIGN KEY (`player_id`) REFERENCES `anonymous_players`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `jobs_status_created_idx` ON `jobs` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `model_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text,
	`case_id` text,
	`command_id` text,
	`graph_name` text NOT NULL,
	`node_name` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`prompt_hash` text NOT NULL,
	`status` text NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`cached_input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`estimated_cost_micros_cny` integer DEFAULT 0 NOT NULL,
	`request_json` text NOT NULL,
	`response_json` text,
	`error` text,
	`created_at` text NOT NULL,
	`finished_at` text,
	FOREIGN KEY (`session_id`) REFERENCES `game_sessions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`case_id`) REFERENCES `case_artifacts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `model_runs_session_created_idx` ON `model_runs` (`session_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `model_runs_case_created_idx` ON `model_runs` (`case_id`,`created_at`);