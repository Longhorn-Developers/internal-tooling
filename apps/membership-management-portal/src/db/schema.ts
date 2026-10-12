import { sqliteTable, text, integer, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const teams = sqliteTable('teams', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
});

export const statuses = sqliteTable("statuses", {
  id: text("id").primaryKey().notNull(),
  name: text("name").notNull().unique(),
});

export const users = sqliteTable('users', {
    id: text("id").primaryKey().notNull(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    githubId: text("github_id").notNull(),
    discordId: text("discord_id").notNull(),
    teamId: text("team_id").notNull().references(() => teams.id),
    statusId: text("status_id")
      .notNull()
      .default("applicant")
      .references(() => statuses.id),

    role: text("role").notNull().default("member")
});