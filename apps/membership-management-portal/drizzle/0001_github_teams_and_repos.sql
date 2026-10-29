CREATE TABLE `team_repos` (
	`repo_name` text PRIMARY KEY NOT NULL,
	`team_id` text NOT NULL,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `team_repos_team_id_idx` ON `team_repos` (`team_id`);--> statement-breakpoint
ALTER TABLE `teams` ADD `github_team_slug` text;--> statement-breakpoint
CREATE UNIQUE INDEX `teams_github_team_slug_unique` ON `teams` (`github_team_slug`);