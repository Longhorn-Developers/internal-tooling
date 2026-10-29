import { and, eq, ne } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { teamRepos, teams, teamUsers, users } from './schema'
import type { Vertical } from './schema'

export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert
export type Team = typeof teams.$inferSelect
export type TeamUser = typeof teamUsers.$inferSelect
export type TeamRepo = typeof teamRepos.$inferSelect

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

/** Lists every user; used to tell LHD members apart from unknown GitHub accounts. */
export async function listUsers(database: D1Database): Promise<User[]> {
    return drizzle(database).select().from(users).all()
}

/** Returns null when the team does not exist. */
export async function getTeam(database: D1Database, teamId: string): Promise<Team | null> {
    const team = await drizzle(database).select().from(teams).where(eq(teams.id, teamId)).get()

    return team ?? null
}

export async function listTeams(database: D1Database): Promise<Team[]> {
    return drizzle(database).select().from(teams).orderBy(teams.name).all()
}

/** Records the GitHub team created for a team; duplicate slugs reject the promise. */
export async function setGithubTeamSlug(
    database: D1Database,
    teamId: string,
    slug: string,
): Promise<void> {
    await drizzle(database)
        .update(teams)
        .set({ githubTeamSlug: slug })
        .where(eq(teams.id, teamId))
        .run()
}

/**
 * Assigns an org repository to a team, moving it if another team had it.
 * Returns the previous team's ID, or null if the repository was unassigned.
 * A missing team rejects the promise.
 */
export async function assignRepo(
    database: D1Database,
    teamId: string,
    repoName: string,
): Promise<string | null> {
    const db = drizzle(database)
    const previous = await db
        .select({ teamId: teamRepos.teamId })
        .from(teamRepos)
        .where(eq(teamRepos.repoName, repoName))
        .get()

    await db
        .insert(teamRepos)
        .values({ repoName, teamId })
        .onConflictDoUpdate({ target: teamRepos.repoName, set: { teamId } })
        .run()

    return previous && previous.teamId !== teamId ? previous.teamId : null
}

/** Returns the team the repository was removed from, or null if it was unassigned. */
export async function unassignRepo(database: D1Database, repoName: string): Promise<string | null> {
    const removed = await drizzle(database)
        .delete(teamRepos)
        .where(eq(teamRepos.repoName, repoName))
        .returning({ teamId: teamRepos.teamId })
        .get()

    return removed?.teamId ?? null
}

export async function listTeamRepos(database: D1Database, teamId: string): Promise<string[]> {
    const rows = await drizzle(database)
        .select({ repoName: teamRepos.repoName })
        .from(teamRepos)
        .where(eq(teamRepos.teamId, teamId))
        .orderBy(teamRepos.repoName)
        .all()

    return rows.map((row) => row.repoName)
}

export async function listRepoAssignments(database: D1Database): Promise<TeamRepo[]> {
    return drizzle(database).select().from(teamRepos).orderBy(teamRepos.repoName).all()
}
