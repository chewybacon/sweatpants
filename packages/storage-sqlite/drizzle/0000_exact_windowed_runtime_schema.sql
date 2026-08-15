CREATE TABLE `sp_conversation_checkpoints` (
	`checkpoint_id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`cause_key` text NOT NULL,
	`cause_json` text NOT NULL,
	`content_hash` text NOT NULL,
	`lineage_id` text NOT NULL,
	`archive_head_segment_id` text,
	`archive_frontier_ordinal` integer NOT NULL,
	`next_public_position` integer NOT NULL,
	`payload_json` text NOT NULL,
	`encoded_bytes` integer NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "sp_checkpoint_archive_frontier" CHECK("sp_conversation_checkpoints"."archive_frontier_ordinal" >= 0),
	CONSTRAINT "sp_checkpoint_next_public_position" CHECK("sp_conversation_checkpoints"."next_public_position" >= 0),
	CONSTRAINT "sp_checkpoint_encoded_bytes" CHECK("sp_conversation_checkpoints"."encoded_bytes" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sp_checkpoint_conversation_cause` ON `sp_conversation_checkpoints` (`conversation_id`,`cause_key`);--> statement-breakpoint
CREATE INDEX `sp_checkpoint_conversation_created` ON `sp_conversation_checkpoints` (`conversation_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `sp_conversation_command_receipts` (
	`conversation_id` text NOT NULL,
	`command_id` text NOT NULL,
	`command_digest` text NOT NULL,
	`participant_id` text NOT NULL,
	`accepted_at` integer NOT NULL,
	`retain_until` integer NOT NULL,
	`admitted_revision` integer NOT NULL,
	`resulting_revision` integer NOT NULL,
	`logical_turn_id` text,
	`execution_id` text,
	PRIMARY KEY(`conversation_id`, `command_id`),
	CONSTRAINT "sp_receipt_admitted_revision" CHECK("sp_conversation_command_receipts"."admitted_revision" >= 0),
	CONSTRAINT "sp_receipt_resulting_revision" CHECK("sp_conversation_command_receipts"."resulting_revision" > "sp_conversation_command_receipts"."admitted_revision")
);
--> statement-breakpoint
CREATE INDEX `sp_receipt_retain_until` ON `sp_conversation_command_receipts` (`retain_until`);--> statement-breakpoint
CREATE TABLE `sp_conversation_heads` (
	`conversation_id` text PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL,
	`owner_epoch` integer NOT NULL,
	`owner_route_json` text,
	`state` text NOT NULL,
	`checkpoint_id` text,
	`terminal_segment_id` text,
	`active_logical_turn_id` text,
	`active_execution_id` text,
	`latest_completed_execution_id` text,
	`active_segment_json` text,
	`active_command_json` text,
	`deleted_at` integer,
	`updated_at` integer NOT NULL,
	CONSTRAINT "sp_heads_revision" CHECK("sp_conversation_heads"."revision" >= 0),
	CONSTRAINT "sp_heads_owner_epoch" CHECK("sp_conversation_heads"."owner_epoch" >= 0),
	CONSTRAINT "sp_heads_state" CHECK("sp_conversation_heads"."state" IN ('idle', 'running', 'parked', 'recovering', 'deleted')),
	CONSTRAINT "sp_heads_deleted_state" CHECK(("sp_conversation_heads"."state" = 'deleted') = ("sp_conversation_heads"."deleted_at" IS NOT NULL)),
	CONSTRAINT "sp_heads_deleted_tombstone" CHECK("sp_conversation_heads"."state" <> 'deleted' OR (
        "sp_conversation_heads"."checkpoint_id" IS NULL AND "sp_conversation_heads"."terminal_segment_id" IS NULL AND
        "sp_conversation_heads"."active_logical_turn_id" IS NULL AND "sp_conversation_heads"."active_execution_id" IS NULL AND
        "sp_conversation_heads"."latest_completed_execution_id" IS NULL AND "sp_conversation_heads"."active_segment_json" IS NULL AND
        "sp_conversation_heads"."active_command_json" IS NULL AND "sp_conversation_heads"."owner_route_json" IS NULL
      ))
);
--> statement-breakpoint
CREATE TABLE `sp_conversation_public_root_index` (
	`conversation_id` text NOT NULL,
	`position` integer NOT NULL,
	`root_id` text NOT NULL,
	`segment_id` text NOT NULL,
	`segment_root_index` integer NOT NULL,
	`archive_ordinal` integer NOT NULL,
	`content_hash` text NOT NULL,
	`encoded_bytes` integer NOT NULL,
	PRIMARY KEY(`conversation_id`, `position`),
	CONSTRAINT "sp_public_root_position" CHECK("sp_conversation_public_root_index"."position" >= 0),
	CONSTRAINT "sp_public_root_segment_index" CHECK("sp_conversation_public_root_index"."segment_root_index" >= 0),
	CONSTRAINT "sp_public_root_archive_ordinal_check" CHECK("sp_conversation_public_root_index"."archive_ordinal" >= 0),
	CONSTRAINT "sp_public_root_bytes" CHECK("sp_conversation_public_root_index"."encoded_bytes" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sp_public_root_identity` ON `sp_conversation_public_root_index` (`conversation_id`,`root_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `sp_public_root_archive_ordinal` ON `sp_conversation_public_root_index` (`conversation_id`,`archive_ordinal`);--> statement-breakpoint
CREATE INDEX `sp_public_root_segment` ON `sp_conversation_public_root_index` (`segment_id`,`segment_root_index`);--> statement-breakpoint
CREATE TABLE `sp_conversation_public_segments` (
	`segment_id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`previous_segment_id` text,
	`min_position` integer NOT NULL,
	`max_position` integer NOT NULL,
	`roots_json` text NOT NULL,
	`content_hash` text NOT NULL,
	`encoded_bytes` integer NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "sp_public_segment_min_position" CHECK("sp_conversation_public_segments"."min_position" >= 0),
	CONSTRAINT "sp_public_segment_positions" CHECK("sp_conversation_public_segments"."max_position" >= "sp_conversation_public_segments"."min_position"),
	CONSTRAINT "sp_public_segment_bytes" CHECK("sp_conversation_public_segments"."encoded_bytes" >= 0)
);
--> statement-breakpoint
CREATE INDEX `sp_public_segment_conversation_position` ON `sp_conversation_public_segments` (`conversation_id`,`min_position`,`max_position`);--> statement-breakpoint
CREATE TABLE `sp_conversation_terminal_segments` (
	`segment_id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`logical_turn_id` text NOT NULL,
	`execution_id` text NOT NULL,
	`publication_key` text NOT NULL,
	`previous_segment_id` text,
	`first_position` integer NOT NULL,
	`last_position` integer NOT NULL,
	`entries_json` text NOT NULL,
	`content_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "sp_terminal_segment_first_position" CHECK("sp_conversation_terminal_segments"."first_position" >= 0),
	CONSTRAINT "sp_terminal_segment_positions" CHECK("sp_conversation_terminal_segments"."last_position" >= "sp_conversation_terminal_segments"."first_position")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sp_terminal_segment_publication` ON `sp_conversation_terminal_segments` (`conversation_id`,`publication_key`);--> statement-breakpoint
CREATE INDEX `sp_terminal_segment_conversation_position` ON `sp_conversation_terminal_segments` (`conversation_id`,`first_position`,`last_position`);--> statement-breakpoint
CREATE TABLE `sp_execution_control` (
	`execution_id` text PRIMARY KEY NOT NULL,
	`control_revision` integer NOT NULL,
	`owner_fence` integer NOT NULL,
	`status` text NOT NULL,
	`root_task_id` text NOT NULL,
	`stop_generation` integer NOT NULL,
	`requested_disposition` text,
	`control_json` text NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "sp_execution_control_status" CHECK("sp_execution_control"."status" IN ('active', 'parked', 'cancelling', 'terminal')),
	CONSTRAINT "sp_execution_control_disposition" CHECK("sp_execution_control"."requested_disposition" IS NULL OR "sp_execution_control"."requested_disposition" IN ('cancelled', 'superseded')),
	CONSTRAINT "sp_execution_control_revision" CHECK("sp_execution_control"."control_revision" >= 0),
	CONSTRAINT "sp_execution_control_owner_fence" CHECK("sp_execution_control"."owner_fence" >= 0),
	CONSTRAINT "sp_execution_control_stop_generation" CHECK("sp_execution_control"."stop_generation" >= 0)
);
--> statement-breakpoint
CREATE TABLE `sp_execution_journal_segments` (
	`segment_id` text PRIMARY KEY NOT NULL,
	`execution_id` text NOT NULL,
	`task_id` text NOT NULL,
	`previous_segment_id` text,
	`first_sequence` integer NOT NULL,
	`last_sequence` integer NOT NULL,
	`entries_json` text NOT NULL,
	`content_hash` text NOT NULL,
	`encoded_bytes` integer NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "sp_journal_segment_first_sequence" CHECK("sp_execution_journal_segments"."first_sequence" >= 0),
	CONSTRAINT "sp_journal_segment_positions" CHECK("sp_execution_journal_segments"."last_sequence" >= "sp_execution_journal_segments"."first_sequence"),
	CONSTRAINT "sp_journal_segment_bytes" CHECK("sp_execution_journal_segments"."encoded_bytes" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sp_journal_task_range` ON `sp_execution_journal_segments` (`execution_id`,`task_id`,`first_sequence`,`last_sequence`);--> statement-breakpoint
CREATE INDEX `sp_journal_task_sequence` ON `sp_execution_journal_segments` (`execution_id`,`task_id`,`first_sequence`);--> statement-breakpoint
CREATE TABLE `sp_execution_objects` (
	`object_id` text PRIMARY KEY NOT NULL,
	`lifetime_scope` text NOT NULL,
	`scope_owner_id` text NOT NULL,
	`object_kind` text NOT NULL,
	`content_hash` text NOT NULL,
	`byte_length` integer NOT NULL,
	`json_body` text,
	`blob_body` blob,
	`created_at` integer NOT NULL,
	CONSTRAINT "sp_execution_object_scope" CHECK("sp_execution_objects"."lifetime_scope" IN ('execution', 'conversation')),
	CONSTRAINT "sp_execution_object_bytes" CHECK("sp_execution_objects"."byte_length" >= 0),
	CONSTRAINT "sp_execution_object_one_body" CHECK(("sp_execution_objects"."json_body" IS NULL) <> ("sp_execution_objects"."blob_body" IS NULL))
);
--> statement-breakpoint
CREATE INDEX `sp_execution_object_scope_index` ON `sp_execution_objects` (`lifetime_scope`,`scope_owner_id`,`object_kind`);--> statement-breakpoint
CREATE INDEX `sp_execution_object_created` ON `sp_execution_objects` (`created_at`);--> statement-breakpoint
CREATE TABLE `sp_execution_replay_segments` (
	`segment_id` text PRIMARY KEY NOT NULL,
	`execution_id` text NOT NULL,
	`task_id` text NOT NULL,
	`previous_segment_id` text,
	`first_sequence` integer NOT NULL,
	`last_sequence` integer NOT NULL,
	`entries_json` text NOT NULL,
	`content_hash` text NOT NULL,
	`encoded_bytes` integer NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "sp_replay_segment_first_sequence" CHECK("sp_execution_replay_segments"."first_sequence" >= 0),
	CONSTRAINT "sp_replay_segment_positions" CHECK("sp_execution_replay_segments"."last_sequence" >= "sp_execution_replay_segments"."first_sequence"),
	CONSTRAINT "sp_replay_segment_bytes" CHECK("sp_execution_replay_segments"."encoded_bytes" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sp_replay_task_range` ON `sp_execution_replay_segments` (`execution_id`,`task_id`,`first_sequence`,`last_sequence`);--> statement-breakpoint
CREATE INDEX `sp_replay_task_sequence` ON `sp_execution_replay_segments` (`execution_id`,`task_id`,`first_sequence`);