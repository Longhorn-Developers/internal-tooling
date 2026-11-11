import { and, eq, inArray, ne } from 'drizzle-orm'
import { drizzle, DrizzleD1Database } from 'drizzle-orm/d1'
import { teams, teamUsers, users } from './schema'
import type { Vertical } from './schema'

export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert
export type Team = typeof teams.$inferSelect
export type NewTeam = typeof teams.$inferInsert
export type TeamUser = typeof teamUsers.$inferSelect

export type VerticalAssignment = {
    vertical: Vertical
    isLead: boolean
}

export type TeamMember = {
    user: User
    verticals: VerticalAssignment[]
}

export type TechAssignment = { user: User; teamId: string; isLead: boolean }

/** Everything the database holds; a UI derives rosters and per-user team lists by joining these. */
export type MembershipState = { users: User[]; teams: Team[]; assignments: TeamUser[] }

export function today() {
    return new Date().toISOString().slice(0, 10)
}

export const githubSlugOf = (name: string) =>
    name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')

// A team's leads are the members of its GitHub child team with this slug.
export const leadsSlugOf = (slug: string) => `${slug}-leads`

/** Whether a team can't take this slug: empty, ending in the reserved "-leads", or colliding with a group (or a group colliding with its subteam). */
export const slugUnavailable = (slug: string, groupSlugs: string[]) =>
    !slug ||
    slug.endsWith('-leads') ||
    groupSlugs.some((group) => group === slug || group === leadsSlugOf(slug))

function normalizeUser<T extends Partial<NewUser>>(data: T): T {
    return {
        ...data,
        ...(data.email !== undefined && { email: data.email.trim().toLowerCase() }),
        ...(data.githubId !== undefined && {
            githubId: data.githubId?.trim().toLowerCase() || null,
        }),
        ...(data.discordId !== undefined && { discordId: data.discordId.trim().toLowerCase() }),
    }
}

export class RecordNotFoundError extends Error {
    selectionCriteria
    constructor(selectionCriteria: object) {
        super(`Record not found: ${JSON.stringify(selectionCriteria)}`)
        this.selectionCriteria = selectionCriteria
    }
}
export class InsertRecordError extends Error {
    constructor(public readonly insertionData: object) {
        super(`Failed to insert record: ${JSON.stringify(insertionData)}`)
    }
}
export class UpdateRecordError extends Error {
    constructor(
        public readonly selectionCriteria: object,
        public readonly updateData: object,
    ) {
        super(
            `Failed to update record ${JSON.stringify(selectionCriteria)}: ${JSON.stringify(updateData)}`,
        )
    }
}

export class MembershipDatabase {
    private readonly db: DrizzleD1Database
    constructor(database: D1Database) {
        this.db = drizzle(database)
    }

    async getUser(userId: string): Promise<User> {
        const user = await this.db.select().from(users).where(eq(users.id, userId)).get()
        if (!user) throw new RecordNotFoundError({ userId })

        return user
    }

    // if retroactively creating a current user, can include `dateJoined` to override `today()`
    // never allowed to specify `id`; always set randomly
    async createUser(data: Omit<NewUser, 'id' | 'dateLeft'>): Promise<User> {
        const newUser: NewUser = {
            id: crypto.randomUUID(),
            dateJoined: today(),
            ...normalizeUser(data),
        }

        const user = await this.db.insert(users).values(newUser).returning().get()
        if (!user) throw new InsertRecordError(newUser)

        return user
    }

    async updateUser(userId: string, data: Partial<Omit<NewUser, 'id'>>): Promise<User> {
        const user = await this.db
            .update(users)
            .set(normalizeUser(data))
            .where(and(eq(users.id, userId), eq(users.status, 'active')))
            .returning()
            .get()

        if (!user) throw new UpdateRecordError({ userId }, data)

        return user
    }

    async deactivateUser(userId: string): Promise<User> {
        const activeUser = and(eq(users.id, userId), eq(users.status, 'active'))
        const data = { status: 'inactive' as const, dateLeft: today() }
        const [, updated] = await this.db.batch([
            this.db
                .delete(teamUsers)
                .where(
                    inArray(
                        teamUsers.userId,
                        this.db.select({ id: users.id }).from(users).where(activeUser),
                    ),
                ),
            this.db.update(users).set(data).where(activeUser).returning(),
        ])
        if (!updated[0]) throw new UpdateRecordError({ userId }, data)
        return updated[0]
    }

    async getTeamMembers(teamId: string): Promise<TeamMember[]> {
        const assignments = await this.db
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

    /** Every tech assignment of an active user, across all teams. */
    async listTechAssignments(): Promise<TechAssignment[]> {
        return this.db
            .select({ user: users, teamId: teamUsers.teamId, isLead: teamUsers.isLead })
            .from(teamUsers)
            .innerJoin(users, eq(teamUsers.userId, users.id))
            .where(and(eq(teamUsers.vertical, 'tech'), eq(users.status, 'active')))
            .all()
    }

    /**
     * Assigns a vertical, or updates isLead on an existing assignment.
     * Returns true if a row was inserted or changed, or false if it already matched.
     * Missing users/teams and invalid verticals reject the promise.
     */
    async assignVertical(
        userId: string,
        teamId: string,
        vertical: Vertical,
        isLead = false,
    ): Promise<void> {
        await this.db
            .insert(teamUsers)
            .values({ userId, teamId, vertical, isLead })
            .onConflictDoUpdate({
                target: [teamUsers.teamId, teamUsers.userId, teamUsers.vertical],
                set: { isLead },
                setWhere: ne(teamUsers.isLead, isLead),
            })
    }

    async removeVertical(userId: string, teamId: string, vertical: Vertical): Promise<void> {
        await this.db
            .delete(teamUsers)
            .where(
                and(
                    eq(teamUsers.userId, userId),
                    eq(teamUsers.teamId, teamId),
                    eq(teamUsers.vertical, vertical),
                ),
            )
    }

    // more optimized than removing each vertical
    async removeUserFromTeam(userId: string, teamId: string): Promise<void> {
        await this.db
            .delete(teamUsers)
            .where(and(eq(teamUsers.userId, userId), eq(teamUsers.teamId, teamId)))
    }

    async removeUserFromAllTeams(userId: string): Promise<void> {
        await this.db.delete(teamUsers).where(eq(teamUsers.userId, userId))
    }

    async listUsers(): Promise<User[]> {
        return this.db.select().from(users).all()
    }

    /** Every user, team and assignment, read in one batch so they are consistent with each other. */
    async getState(): Promise<MembershipState> {
        const [allUsers, allTeams, assignments] = await this.db.batch([
            this.db.select().from(users).orderBy(users.name, users.id),
            this.db.select().from(teams).orderBy(teams.name),
            this.db.select().from(teamUsers),
        ])

        return { users: allUsers, teams: allTeams, assignments }
    }

    async getTeam(teamId: string): Promise<Team> {
        const team = await this.db.select().from(teams).where(eq(teams.id, teamId)).get()
        if (!team) throw new RecordNotFoundError({ teamId })

        return team
    }

    async listTeams(): Promise<Team[]> {
        return this.db.select().from(teams).orderBy(teams.name).all()
    }

    async createTeam(data: Omit<NewTeam, 'id' | 'githubSlug'>): Promise<Team> {
        const teamData = {
            id: crypto.randomUUID(),
            ...data,
            githubSlug: githubSlugOf(data.name),
        }

        const team = await this.db.insert(teams).values(teamData).returning().get()
        if (!team) throw new InsertRecordError(teamData)

        return team
    }

    // returns the old team
    async deleteTeam(teamId: string): Promise<Team> {
        const [, team] = await this.db.batch([
            this.db.delete(teamUsers).where(eq(teamUsers.teamId, teamId)),
            this.db.delete(teams).where(eq(teams.id, teamId)).returning(),
        ])

        return team[0]
    }
}
