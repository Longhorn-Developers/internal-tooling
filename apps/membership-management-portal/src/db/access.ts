import { and, eq, ne } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { teamUsers, users } from './schema'
import type { Vertical } from './schema'

export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert
export type TeamUser = typeof teamUsers.$inferSelect

export type VerticalAssignment = {
    vertical: Vertical
    isLead: boolean
}

export type TeamMember = {
    user: User
    verticals: VerticalAssignment[]
}

/** Returns null when the user does not exist. */
export async function getUserById(database: D1Database, userId: string): Promise<User | null> {
    const user = await drizzle(database).select().from(users).where(eq(users.id, userId)).get()

    return user ?? null
}

/** Creates a user; duplicate IDs and invalid statuses reject the promise. */
export async function createUser(database: D1Database, data: NewUser): Promise<User> {
    const user = await drizzle(database).insert(users).values(data).returning().get()

    if (!user) {
        throw new Error(`User ${data.id} was not created`)
    }

    return user
}

/**
 * Lists users with explicit vertical assignments, grouping each user's verticals.
 * Returns [] for a team with no assignments or a team that does not exist.
 */
export async function getTeamMembers(database: D1Database, teamId: string): Promise<TeamMember[]> {
    const assignments = await drizzle(database)
        .select({
            user: users,
            vertical: teamUsers.vertical,
            isLead: teamUsers.isLead,
        })
        .from(teamUsers)
        .innerJoin(users, eq(teamUsers.userId, users.id))
        .where(eq(teamUsers.teamId, teamId))
        .orderBy(users.name, users.id, teamUsers.vertical)
        .all()

    const members = new Map<string, TeamMember>()
    for (const { user, vertical, isLead } of assignments) {
        const member = members.get(user.id)
        if (member) {
            member.verticals.push({ vertical, isLead })
        } else {
            members.set(user.id, { user, verticals: [{ vertical, isLead }] })
        }
    }

    return [...members.values()]
}

/**
 * Assigns a vertical, or updates isLead on an existing assignment.
 * Returns true if a row was inserted or changed, or false if it already matched.
 * Missing users/teams and invalid verticals reject the promise.
 */
export async function assignVertical(
    database: D1Database,
    userId: string,
    teamId: string,
    vertical: Vertical,
    isLead = false,
): Promise<boolean> {
    const assignment = await drizzle(database)
        .insert(teamUsers)
        .values({ userId, teamId, vertical, isLead })
        .onConflictDoUpdate({
            target: [teamUsers.teamId, teamUsers.userId, teamUsers.vertical],
            set: { isLead },
            setWhere: ne(teamUsers.isLead, isLead),
        })
        .returning({ userId: teamUsers.userId })
        .get()

    return assignment !== undefined
}

/** Returns true if the assignment was removed, or false if it did not exist. */
export async function removeVertical(
    database: D1Database,
    userId: string,
    teamId: string,
    vertical: Vertical,
): Promise<boolean> {
    const assignment = await drizzle(database)
        .delete(teamUsers)
        .where(
            and(
                eq(teamUsers.userId, userId),
                eq(teamUsers.teamId, teamId),
                eq(teamUsers.vertical, vertical),
            ),
        )
        .returning({ userId: teamUsers.userId })
        .get()

    return assignment !== undefined
}
