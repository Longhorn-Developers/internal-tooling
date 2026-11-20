-- Rebuild the leaf table to replace its CHECK constraint and translate existing assignments.
-- Nothing references team_users, so D1 foreign-key enforcement can stay enabled.
CREATE TABLE `__new_team_users` (
	`team_id` text NOT NULL,
	`user_id` text NOT NULL,
	`vertical` text NOT NULL,
	`is_lead` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`team_id`, `user_id`, `vertical`),
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "valid_vertical" CHECK("__new_team_users"."vertical" IN ('product', 'technical', 'design'))
);
--> statement-breakpoint
INSERT INTO `__new_team_users`("team_id", "user_id", "vertical", "is_lead")
SELECT "team_id", "user_id", CASE WHEN "vertical" = 'tech' THEN 'technical' ELSE "vertical" END, "is_lead"
FROM `team_users`;--> statement-breakpoint
DROP TABLE `team_users`;--> statement-breakpoint
ALTER TABLE `__new_team_users` RENAME TO `team_users`;--> statement-breakpoint
CREATE INDEX `team_users_user_id_idx` ON `team_users` (`user_id`);
