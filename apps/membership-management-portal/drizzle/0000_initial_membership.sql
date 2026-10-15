CREATE TABLE `statuses` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `statuses_name_unique` ON `statuses` (`name`);--> statement-breakpoint
CREATE TABLE `team_users` (
	`team_id` text NOT NULL,
	`user_id` text NOT NULL,
	`vertical_id` text NOT NULL,
	PRIMARY KEY(`team_id`, `user_id`, `vertical_id`),
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`vertical_id`) REFERENCES `verticals`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `team_users_user_id_idx` ON `team_users` (`user_id`);--> statement-breakpoint
CREATE INDEX `team_users_vertical_id_idx` ON `team_users` (`vertical_id`);--> statement-breakpoint
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
	`status_id` text DEFAULT 'applicant' NOT NULL,
	`is_exec` integer DEFAULT false NOT NULL,
	`date_joined` text,
	`date_left` text,
	FOREIGN KEY (`status_id`) REFERENCES `statuses`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `verticals` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	CONSTRAINT "valid_vertical_name" CHECK("verticals"."name" IN (
        'product fellow', 'developer fellow',
        'product lead', 'developer lead',
        'design lead', 'design fellow'
      ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `verticals_name_unique` ON `verticals` (`name`);
--> statement-breakpoint
-- Initial reference data required by the access helpers.
INSERT INTO statuses (id, name)
VALUES ('applicant', 'Applicant')
ON CONFLICT(id) DO NOTHING;
--> statement-breakpoint
INSERT INTO verticals (id, name) VALUES
  ('product-fellow', 'product fellow'),
  ('developer-fellow', 'developer fellow'),
  ('product-lead', 'product lead'),
  ('developer-lead', 'developer lead'),
  ('design-lead', 'design lead'),
  ('design-fellow', 'design fellow')
ON CONFLICT(id) DO NOTHING;
