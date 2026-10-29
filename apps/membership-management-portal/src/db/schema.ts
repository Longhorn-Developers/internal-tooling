import { sql } from 'drizzle-orm'
import { check, index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const statusNames = ['applicant', 'active', 'inactive', 'alum'] as const
export type Status = (typeof statusNames)[number]

export const verticalNames = ['product', 'tech', 'design'] as const
export type Vertical = (typeof verticalNames)[number]

// SQLite has no enum type, so enum columns also get a CHECK constraint.
const inList = (values: readonly string[]) =>
    sql.raw(values.map((value) => `'${value}'`).join(', '))

export const teams = sqliteTable('teams', {
    id: text('id').primaryKey().notNull(),
    name: text('name').notNull(),
    githubTeamSlug: text('github_team_slug').unique(), // null until the GitHub team is created.
})

export const users = sqliteTable(
    'users',
    {
        id: text('id').primaryKey().notNull(),
        name: text('name').notNull(),
        email: text('email').notNull(),
        githubId: text('github_id').notNull(),
        discordId: text('discord_id').notNull(),
        status: text('status', { enum: statusNames }).notNull().default('applicant'),
        isExec: integer('is_exec', { mode: 'boolean' }).notNull().default(false),
        dateJoined: text('date_joined'), // YYYY-MM-DD; null when not yet known.
        dateLeft: text('date_left'), // YYYY-MM-DD; null when the user has not left.
    },
    (table) => [check('valid_status', sql`${table.status} IN (${inList(statusNames)})`)],
)

// One assignment per user, team, and vertical; users can belong to many teams.
// isLead is outside the primary key, so a user is either a lead or not per vertical.
export const teamUsers = sqliteTable(
    'team_users',
    {
        teamId: text('team_id')
            .notNull()
            .references(() => teams.id),
        userId: text('user_id')
            .notNull()
            .references(() => users.id),
        vertical: text('vertical', { enum: verticalNames }).notNull(),
        isLead: integer('is_lead', { mode: 'boolean' }).notNull().default(false),
    },
    (table) => [
        primaryKey({ columns: [table.teamId, table.userId, table.vertical] }),
        index('team_users_user_id_idx').on(table.userId),
        check('valid_vertical', sql`${table.vertical} IN (${inList(verticalNames)})`),
    ],
)

// Source of truth for which org repositories belong to which team; GitHub is synced to match.
// repoName is the primary key, so each repository belongs to at most one team.
export const teamRepos = sqliteTable(
    'team_repos',
    {
        repoName: text('repo_name').primaryKey().notNull(), // name within the org, e.g. "portal-web"
        teamId: text('team_id')
            .notNull()
            .references(() => teams.id),
    },
    (table) => [index('team_repos_team_id_idx').on(table.teamId)],
)
