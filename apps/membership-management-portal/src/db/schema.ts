import {sql} from 'drizzle-orm'
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

export const statusNames = ['applicant', 'active', 'inactive', 'alum'] as const
export type Status = (typeof statusNames)[number]

export const verticalNames = ['product', 'tech', 'design'] as const
export type Vertical = (typeof verticalNames)[number]

export const execRoles = [
    'President',
    'Product Director',
    'SWE Director',
    'Communications Director',
    'Membership Director',
    'UX Design Director',
] as const
export type ExecRole = (typeof execRoles)[number]

// SQLite has no enum type, so enum columns also get a CHECK constraint.
const sqlInArray = (column: any, allowedValues: readonly string[]) => {
    const quotedValues = allowedValues.map(v => `'${v}'`).join(', ');
    return sql`${column} IN (${sql.raw(quotedValues)})`;
};

export const teams = sqliteTable('teams', {
    id: text('id').primaryKey().notNull(),
    name: text('name').notNull(),
    githubSlug: text('github_slug').notNull().unique(),
}, (table) => [
    check('valid_github_slug', sql`length(${table.githubSlug}) > 0 AND ${table.githubSlug} NOT GLOB '*[^a-z0-9-]*'`),
])

export const users = sqliteTable(
    'users',
    {
        id: text('id').primaryKey().notNull(),
        name: text('name').notNull(),
        email: text('email').notNull(),
        githubId: text('github_id').unique(),
        discordId: text('discord_id').notNull().unique(),
        status: text('status', { enum: statusNames }).notNull().default('active'),
        execRole: text('exec_role', { enum: execRoles }),
        dateJoined: text('date_joined'), // YYYY-MM-DD; null when not yet known.
        dateLeft: text('date_left'), // YYYY-MM-DD; null when the user has not left.
    },
    (table) => [
        check('valid_status', sqlInArray(table.status, statusNames)),
        check('valid_exec_role', sqlInArray(table.execRole, execRoles)),
        check('github_id_lowercase', sql`${table.githubId} = lower(${table.githubId})`),
        uniqueIndex('users_email_unique').on(sql`lower(${table.email})`),
    ],
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
        check('valid_vertical', sqlInArray(table.vertical, verticalNames)),
    ],
)
