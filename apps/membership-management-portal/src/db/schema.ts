import { sqliteTable, text, primaryKey, check } from 'drizzle-orm/sqlite-core';
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

export const positions = [
  'product fellow',
  'developer fellow',
  'product lead',
  'developer lead',
  'design lead',
  'design fellow',
] as const;

export type Position = (typeof positions)[number];
// adds support for user being in multiple teams with different positions
export const teamMemberships = sqliteTable(
  'team_memberships',
  {
    userId: text('user_id').notNull().references(() => users.id),
    teamId: text('team_id').notNull().references(() => teams.id),
    position: text('position', { enum: positions }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.userId, table.teamId, table.position],
    }),
    check(
      'valid_team_position',
      sql`${table.position} IN (
        'product fellow', 'developer fellow',
        'product lead', 'developer lead',
        'design lead', 'design fellow'
      )`,
    ),
  ],
);
