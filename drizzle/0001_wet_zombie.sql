ALTER TABLE `jobs` ADD `stage` text DEFAULT 'queued' NOT NULL;--> statement-breakpoint
ALTER TABLE `jobs` ADD `progress` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `jobs`
SET
  `stage` = CASE `status`
    WHEN 'running' THEN 'starting'
    WHEN 'succeeded' THEN 'succeeded'
    WHEN 'failed' THEN 'failed'
    WHEN 'cancelled' THEN 'cancelled'
    ELSE 'queued'
  END,
  `progress` = CASE WHEN `status` = 'succeeded' THEN 100 ELSE 0 END;
