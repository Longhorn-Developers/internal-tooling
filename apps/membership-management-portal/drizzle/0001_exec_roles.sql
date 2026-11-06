PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_users` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`github_id` text NOT NULL,
	`discord_id` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`exec_role` text,
	`date_joined` text,
	`date_left` text,
	CONSTRAINT "valid_status" CHECK("__new_users"."status" IN ('applicant', 'active', 'inactive', 'alum')),
	CONSTRAINT "valid_exec_role" CHECK("__new_users"."exec_role" IN ('President', 'Product Director', 'SWE Director', 'Communications Director', 'Membership Director', 'UX Design Director'))
);
--> statement-breakpoint
INSERT INTO `__new_users`("id", "name", "email", "github_id", "discord_id", "status", "exec_role", "date_joined", "date_left") SELECT "id", "name", "email", "github_id", "discord_id", "status", "exec_role", "date_joined", "date_left" FROM `users`;--> statement-breakpoint
DROP TABLE `users`;--> statement-breakpoint
ALTER TABLE `__new_users` RENAME TO `users`;--> statement-breakpoint
PRAGMA foreign_keys=ON;