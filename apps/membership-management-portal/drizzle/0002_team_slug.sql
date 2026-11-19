-- Hand-edited. D1 ignores PRAGMA foreign_keys=OFF, so drizzle's usual "rebuild teams" fails whenever
-- team_users has rows (dropping teams orphans them). Instead: set team_users aside without its
-- foreign keys, rebuild teams while nothing references it, then restore team_users exactly as it was.
CREATE TABLE `__team_users_backup` AS SELECT * FROM `team_users`;--> statement-breakpoint
DROP TABLE `team_users`;--> statement-breakpoint
CREATE TABLE `__new_teams` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`team_slug` text NOT NULL,
	CONSTRAINT "valid_team_slug" CHECK(length("__new_teams"."team_slug") BETWEEN 1 AND 100 AND "__new_teams"."team_slug" NOT GLOB '*[^a-z0-9-]*' AND "__new_teams"."team_slug" NOT GLOB '*-leads')
);
--> statement-breakpoint
INSERT INTO `__new_teams`("id", "name", "team_slug") SELECT "id", "name", "github_slug" FROM `teams`;--> statement-breakpoint
DROP TABLE `teams`;--> statement-breakpoint
ALTER TABLE `__new_teams` RENAME TO `teams`;--> statement-breakpoint
CREATE UNIQUE INDEX `teams_team_slug_unique` ON `teams` (`team_slug`);--> statement-breakpoint
CREATE TABLE `team_users` (
	`team_id` text NOT NULL,
	`user_id` text NOT NULL,
	`vertical` text NOT NULL,
	`is_lead` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`team_id`, `user_id`, `vertical`),
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "valid_vertical" CHECK("team_users"."vertical" IN ('product', 'tech', 'design'))
);
--> statement-breakpoint
INSERT INTO `team_users`("team_id", "user_id", "vertical", "is_lead") SELECT "team_id", "user_id", "vertical", "is_lead" FROM `__team_users_backup`;--> statement-breakpoint
DROP TABLE `__team_users_backup`;--> statement-breakpoint
CREATE INDEX `team_users_user_id_idx` ON `team_users` (`user_id`);
