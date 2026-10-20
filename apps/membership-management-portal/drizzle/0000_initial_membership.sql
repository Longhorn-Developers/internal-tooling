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
CREATE INDEX `team_users_user_id_idx` ON `team_users` (`user_id`);--> statement-breakpoint
CREATE TABLE `teams` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`github_id` text NOT NULL,
	`discord_id` text NOT NULL,
	`status` text DEFAULT 'applicant' NOT NULL,
	`is_exec` integer DEFAULT false NOT NULL,
	`date_joined` text,
	`date_left` text,
	CONSTRAINT "valid_status" CHECK("users"."status" IN ('applicant', 'active', 'inactive', 'alum'))
);
