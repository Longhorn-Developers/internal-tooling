PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_users` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`github_id` text,
	`discord_id` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`exec_role` text,
	`date_joined` text,
	`date_left` text,
	CONSTRAINT "valid_status" CHECK("__new_users"."status" IN ('applicant', 'active', 'inactive', 'alum')),
	CONSTRAINT "valid_exec_role" CHECK("__new_users"."exec_role" IN ('President', 'Product Director', 'SWE Director', 'Communications Director', 'Membership Director', 'UX Design Director')),
	CONSTRAINT "github_id_lowercase" CHECK("__new_users"."github_id" = lower("__new_users"."github_id"))
);
--> statement-breakpoint
INSERT INTO `__new_users`("id", "name", "email", "github_id", "discord_id", "status", "exec_role", "date_joined", "date_left") SELECT "id", "name", "email", "github_id", "discord_id", "status", "exec_role", "date_joined", "date_left" FROM `users`;--> statement-breakpoint
DROP TABLE `users`;--> statement-breakpoint
ALTER TABLE `__new_users` RENAME TO `users`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `users_github_id_unique` ON `users` (`github_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_discord_id_unique` ON `users` (`discord_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (lower("email"));--> statement-breakpoint
ALTER TABLE `teams` ADD `github_slug` text NOT NULL;--> statement-breakpoint
CREATE TABLE `__new_teams` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`github_slug` text NOT NULL,
	CONSTRAINT "valid_github_slug" CHECK(length("__new_teams"."github_slug") > 0 AND "__new_teams"."github_slug" NOT GLOB '*[^a-z0-9-]*')
);
--> statement-breakpoint
INSERT INTO `__new_teams`("id", "name", "github_slug") SELECT "id", "name", "github_slug" FROM `teams`;--> statement-breakpoint
DROP TABLE `teams`;--> statement-breakpoint
ALTER TABLE `__new_teams` RENAME TO `teams`;--> statement-breakpoint
CREATE UNIQUE INDEX `teams_github_slug_unique` ON `teams` (`github_slug`);
