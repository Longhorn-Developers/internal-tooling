import { sql } from 'drizzle-orm';
import { check, index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const teams = sqliteTable('teams', {
  id: text('id').primaryKey().notNull(),
  name: text('name').notNull(),
});

export const statuses = sqliteTable('statuses', {
  id: text('id').primaryKey().notNull(),
  name: text('name').notNull().unique(),
});

export const users = sqliteTable('users', {
  id: text('id').primaryKey().notNull(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  githubId: text('github_id').notNull(),
  discordId: text('discord_id').notNull(),
  statusId: text('status_id')
    .notNull()
    .default('applicant')
    .references(() => statuses.id),
  isExec: integer('is_exec', { mode: 'boolean' }).notNull().default(false),
  dateJoined: text('date_joined'), // YYYY-MM-DD; null when not yet known.
  dateLeft: text('date_left'), // YYYY-MM-DD; null when the user has not left.
});

export const verticalNames = [
  'product fellow',
  'developer fellow',
  'product lead',
  'developer lead',
  'design lead',
  'design fellow',
] as const;

export type Vertical = (typeof verticalNames)[number];

export const verticals = sqliteTable(
  'verticals',
  {
    id: text('id').primaryKey().notNull(),
    name: text('name', { enum: verticalNames }).notNull().unique(),
  },
  (table) => [
    check(
      'valid_vertical_name',
      sql`${table.name} IN (
        'product fellow', 'developer fellow',
        'product lead', 'developer lead',
        'design lead', 'design fellow'
      )`,
    ),
  ],
);

// One assignment per user, team, and vertical; users can belong to many teams.
export const teamUsers = sqliteTable(
  'team_users',
  {
    teamId: text('team_id').notNull().references(() => teams.id),
    userId: text('user_id').notNull().references(() => users.id),
    verticalId: text('vertical_id').notNull().references(() => verticals.id),
  },
  (table) => [
    primaryKey({ columns: [table.teamId, table.userId, table.verticalId] }),
    index('team_users_user_id_idx').on(table.userId),
    index('team_users_vertical_id_idx').on(table.verticalId),
  ],
);
