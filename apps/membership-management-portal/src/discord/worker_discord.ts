import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import { teams, teamUsers, users, verticalNames } from '../db/schema'
import type { Vertical } from '../db/schema'
import { execRoleNames } from './service' // add real service path
import type { ExecRole, NeededChange, Service } from './service' // add real service path

export interface Env {
    DB: D1Database
    DISCORD_TOKEN: string // wrangler secret put DISCORD_TOKEN
    GUILD_ID: string // wrangler.toml [vars]
    TEAM_CATEGORY_ID?: string // optional: Discord category new team channels are created under
}

// Role naming
// Roles are found by name (case-insensitive) so the DB doesn't have to store role ids.
//
// NOTE TO MALCOLM/MILES: change these if you want a different naming convention.
// The defaults [hopefully] match the roles already in the server ("Leads", "Technical Leads", ...).

const MEMBER_ROLE = 'Members' // given on onboarding
const LEAD_ROLE = 'Leads' // everyone who leads at least one vertical
const FELLOW_ROLE = 'Fellows' // everyone who is a fellow in at least one vertical
const EXEC_BOARD_ROLE = 'Executive Board'

// How each vertical is written in role names. Record<Vertical, ...> makes TypeScript
// complain if a vertical is added to the schema without adding a label here.
const verticalLabels: Record<Vertical, string> = {
    product: 'Product',
    tech: 'Technical',
    design: 'Design',
}

// Each exec role's Discord role, plus the vertical they also lead (they get "Leads" and "<Vertical> Leads").
const execRoles: Record<ExecRole, { role: string; leadVertical?: Vertical }> = {
    president: { role: 'President' },
    product_director: { role: 'Product Director', leadVertical: 'product' },
    swe_director: { role: 'SWE Director', leadVertical: 'tech' },
    communications_director: { role: 'Communications Director' },
    membership_director: { role: 'Membership Director' },
    ux_design_director: { role: 'UX Design Director', leadVertical: 'design' },
}

const roleNames = {
    team: (team: string) => team.slice(0, 100),
    // "<Vertical> Leads" / "<Vertical> Fellows"
    verticalRank: (vertical: Vertical, isLead: boolean) =>
        `${verticalLabels[vertical]} ${isLead ? 'Leads' : 'Fellows'}`.slice(0, 100),
    teamVertical: (team: string, vertical: Vertical) => `${team} ${verticalLabels[vertical]}`.slice(0, 100),
}

// ============================================================
// Errors
// ============================================================

/** A role that should exist doesn't (only possible if it was deleted mid-operation). */
export class MissingRoleError extends Error {
    constructor(public roleName: string) {
        super(`Discord role "${roleName}" does not exist`)
    }
}

/** Not fixable by creating things: the person has to join the server first. */
export class UserNotInGuildError extends Error {
    constructor(public discordIds: string[]) {
        super(`Not in the Discord server: ${discordIds.join(', ')}`)
    }
}

export class DiscordError extends Error {
    constructor(
        public status: number,
        public code: number | undefined,
        message: string,
    ) {
        super(message)
    }
}

// ============================================================
// Low-level Discord REST helpers
// ============================================================

const API = 'https://discord.com/api/v10'
const UNKNOWN_CHANNEL = 10003
const UNKNOWN_ROLE = 10011
const UNKNOWN_MEMBER = 10007 // user isn't in the server

async function discord<T = void>(
    env: Env,
    method: string,
    path: string,
    opts: { body?: unknown; reason?: string } = {},
    retry = true,
): Promise<T> {
    const headers: Record<string, string> = {
        Authorization: `Bot ${env.DISCORD_TOKEN}`,
    }
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json'
    if (opts.reason) headers['X-Audit-Log-Reason'] = encodeURIComponent(opts.reason)

    const res = await fetch(`${API}${path}`, {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    })

    if (!res.ok) {
        if (res.status === 429 && retry) {
            const { retry_after } = (await res.json()) as { retry_after: number }
            await new Promise((r) => setTimeout(r, Math.ceil(retry_after * 1000)))
            return discord<T>(env, method, path, opts, false)
        }

        const err = (await res.json().catch(() => ({}))) as { code?: number; message?: string }
        throw new DiscordError(res.status, err.code, err.message ?? `Discord returned ${res.status}`)
    }

    if (res.status === 204) return undefined as T
    return (await res.json()) as T
}

// These return false if the user isn't in the server (nothing to do), true otherwise.
export const addRole = async (env: Env, discordId: string, roleId: string, reason?: string) =>
    ignoreUnknownMember(() =>
        discord(env, 'PUT', `/guilds/${env.GUILD_ID}/members/${discordId}/roles/${roleId}`, { reason }),
    )

export const removeRole = async (env: Env, discordId: string, roleId: string, reason?: string) =>
    ignoreUnknownMember(() =>
        discord(env, 'DELETE', `/guilds/${env.GUILD_ID}/members/${discordId}/roles/${roleId}`, { reason }),
    )

export const kickMember = async (env: Env, discordId: string, reason?: string) =>
    ignoreUnknownMember(() => discord(env, 'DELETE', `/guilds/${env.GUILD_ID}/members/${discordId}`, { reason }))

async function ignoreUnknownMember(fn: () => Promise<unknown>): Promise<boolean> {
    try {
        await fn()
        return true
    } catch (e) {
        if (e instanceof DiscordError && e.code === UNKNOWN_MEMBER) return false
        throw e
    }
}

/** The ids of the roles a member currently has, or null if they aren't in the server. */
export async function getMemberRoleIds(env: Env, discordId: string): Promise<Set<string> | null> {
    try {
        const member = await discord<{ roles: string[] }>(env, 'GET', `/guilds/${env.GUILD_ID}/members/${discordId}`)
        return new Set(member.roles)
    } catch (e) {
        if (e instanceof DiscordError && e.code === UNKNOWN_MEMBER) return null
        throw e
    }
}

export async function getDiscordId(env: Env, userId: string) {
    // lowk useless rn, will likely have to be exported
    const [user] = await drizzle(env.DB).select().from(users).where(eq(users.id, userId))
    if (!user) {
        throw new Error(`User ${userId} not found`)
    }
    return user.discordId
}

// ============================================================
// Roles: looking them up by name (never creates anything) and creating them (never assigns anything)
// ============================================================

interface DiscordRole {
    id: string
    name: string
    managed: boolean
}

const norm = (name: string) => name.trim().toLowerCase()

/**
 * A snapshot of the server's roles, loaded fresh at the start of every operation so a
 * role someone just created by hand is seen immediately (no stale cache between retries).
 */
class RoleBook {
    private byName = new Map<string, DiscordRole>()
    private byId = new Map<string, DiscordRole>()

    add(role: DiscordRole) {
        this.byId.set(role.id, role)
        // Skip bot/integration roles; first match wins if names are duplicated
        if (!role.managed && !this.byName.has(norm(role.name))) this.byName.set(norm(role.name), role)
    }
    remove(role: DiscordRole) {
        this.byId.delete(role.id)
        if (this.byName.get(norm(role.name))?.id === role.id) this.byName.delete(norm(role.name))
    }
    find(name: string): DiscordRole | undefined {
        return this.byName.get(norm(name))
    }
    nameOf(roleId: string): string | undefined {
        return this.byId.get(roleId)?.name
    }
}

async function loadRoleBook(env: Env): Promise<RoleBook> {
    const book = new RoleBook()
    for (const role of await discord<DiscordRole[]>(env, 'GET', `/guilds/${env.GUILD_ID}/roles`)) book.add(role)
    return book
}

/**
 * Creates a role (no permissions). Never assigns it to anyone.
 * createChannel: also create the role's private team channel. Only createTeam passes true.
 */
async function createRole(env: Env, book: RoleBook, name: string, createChannel = false): Promise<DiscordRole> {
    const role = await discord<DiscordRole>(env, 'POST', `/guilds/${env.GUILD_ID}/roles`, {
        body: { name, permissions: '0', mentionable: false },
        reason: 'Created by the team service',
    })
    book.add(role)
    if (createChannel) await createTeamChannel(env, role)
    return role
}

async function deleteRole(env: Env, role: DiscordRole) {
    try {
        await discord(env, 'DELETE', `/guilds/${env.GUILD_ID}/roles/${role.id}`, { reason: 'Team deleted' })
    } catch (e) {
        if (!(e instanceof DiscordError && e.code === UNKNOWN_ROLE)) throw e
    }
}

// ============================================================
// Team channels
// ============================================================

interface DiscordChannel {
    id: string
    name: string
    type: number
}

const VIEW_CHANNEL = 1n << 10n
const SEND_MESSAGES = 1n << 11n
const READ_MESSAGE_HISTORY = 1n << 16n

// Discord lowercases channel names and swaps spaces for dashes
const slugify = (name: string) =>
    name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 100) || 'team'

async function findTeamChannel(env: Env, teamRole: string): Promise<DiscordChannel | undefined> {
    const channels = await discord<DiscordChannel[]>(env, 'GET', `/guilds/${env.GUILD_ID}/channels`)
    const slug = slugify(teamRole)
    return channels.find((c) => c.type === 0 && c.name === slug) // type 0 = text channel
}

/** Creates a text channel only the team's role can see. Does nothing if it already exists. */
async function createTeamChannel(env: Env, teamRole: DiscordRole): Promise<DiscordChannel> {
    const existing = await findTeamChannel(env, teamRole.name)
    if (existing) return existing

    return discord<DiscordChannel>(env, 'POST', `/guilds/${env.GUILD_ID}/channels`, {
        body: {
            name: slugify(teamRole.name),
            type: 0,
            parent_id: env.TEAM_CATEGORY_ID,
            permission_overwrites: [
                // @everyone's role id is the guild id
                { id: env.GUILD_ID, type: 0, allow: '0', deny: VIEW_CHANNEL.toString() },
                {
                    id: teamRole.id,
                    type: 0,
                    allow: (VIEW_CHANNEL | SEND_MESSAGES | READ_MESSAGE_HISTORY).toString(),
                    deny: '0',
                },
            ],
        },
        reason: `Team channel for ${teamRole.name}`,
    })
}

async function deleteChannel(env: Env, channel: DiscordChannel) {
    try {
        await discord(env, 'DELETE', `/channels/${channel.id}`, { reason: 'Team deleted' })
    } catch (e) {
        if (!(e instanceof DiscordError && e.code === UNKNOWN_CHANNEL)) throw e
    }
}

// ============================================================
// Working out which roles someone should have
// ============================================================

type Team = typeof teams.$inferSelect
type Row = Pick<typeof teamUsers.$inferSelect, 'teamId' | 'vertical' | 'isLead'>
type Wanted = Array<[name: string, shouldHave: boolean]>

/**
 * The user's stored assignments with one change applied on top. This makes the result the
 * same whether the DB was updated before or after the service was called.
 */
const withAssignment = (rows: Row[], change: Row): Row[] => [
    ...rows.filter((r) => !(r.teamId === change.teamId && r.vertical === change.vertical)),
    change,
]

/** Roles unique to one team: the team role, plus one per vertical. */
const teamRoleNames = (team: Team) => [
    roleNames.team(team.name),
    ...verticalNames.map((v) => roleNames.teamVertical(team.name, v)),
]

/** Roles shared by all teams: Leads, Fellows, and "<Vertical> Leads/Fellows". */
const rankRoleNames = () => [
    LEAD_ROLE,
    FELLOW_ROLE,
    ...verticalNames.flatMap((v) => [roleNames.verticalRank(v, true), roleNames.verticalRank(v, false)]),
]

/**
 * Lead roles that exec roles the member holds in Discord imply (e.g. SWE Director -> Leads +
 * Technical Leads). Syncing team assignments must not strip these.
 */
function execKeep(book: RoleBook, held: Set<string>, except?: ExecRole): Set<string> {
    const keep = new Set<string>()
    for (const e of execRoleNames) {
        const cfg = execRoles[e]
        const role = book.find(cfg.role)
        if (e === except || !role || !held.has(role.id) || !cfg.leadVertical) continue
        keep.add(norm(LEAD_ROLE))
        keep.add(norm(roleNames.verticalRank(cfg.leadVertical, true)))
    }
    return keep
}

/**
 * Everything one team can affect for one user, with whether they should have it:
 * - "<Team>", if any of their assignments is on that team
 * - "<Team> <Vertical>", for each vertical they're assigned to on that team
 * - "Leads" / "Fellows", if any assignment (any team) is lead / not lead
 * - "<Vertical> Leads/Fellows", if any assignment in that vertical is lead / not lead
 * `rows` must be ALL of the user's assignments, so roles shared with their other teams are kept.
 */
function teamScopeWanted(team: Team, rows: Row[], keep: Set<string>): Wanted {
    const kept = (name: string) => keep.has(norm(name))
    const onTeam = rows.filter((r) => r.teamId === team.id)
    const wanted: Wanted = [[roleNames.team(team.name), onTeam.length > 0]]

    for (const v of verticalNames) {
        wanted.push([roleNames.teamVertical(team.name, v), onTeam.some((r) => r.vertical === v)])
    }

    wanted.push([LEAD_ROLE, rows.some((r) => r.isLead) || kept(LEAD_ROLE)])
    wanted.push([FELLOW_ROLE, rows.some((r) => !r.isLead)])
    for (const v of verticalNames) {
        const leadName = roleNames.verticalRank(v, true)
        wanted.push([leadName, rows.some((r) => r.vertical === v && r.isLead) || kept(leadName)])
        wanted.push([roleNames.verticalRank(v, false), rows.some((r) => r.vertical === v && !r.isLead)])
    }
    return wanted
}

const wantedNames = (wanted: Wanted) => wanted.filter(([, shouldHave]) => shouldHave).map(([name]) => name)

/** The roles in `names` that don't exist in the server yet, as changes to make. */
function missingRoleChanges(book: RoleBook, names: string[]): NeededChange[] {
    const seen = new Set<string>()
    const changes: NeededChange[] = []
    for (const name of names) {
        if (book.find(name) || seen.has(norm(name))) continue
        seen.add(norm(name))
        changes.push({ service: 'discord', kind: 'create_role', name })
    }
    return changes
}

// ============================================================
// The service
// ============================================================

export class DiscordService implements Service {
    constructor(private env: Env) {}

    private get db() {
        return drizzle(this.env.DB)
    }

    // ---------- DB reads (this class never writes to the DB) ----------

    private async getUser(userId: string) {
        const user = await this.db.select().from(users).where(eq(users.id, userId)).get()
        if (!user) throw new Error(`User ${userId} not found`)
        return user
    }

    private async getTeam(teamId: string) {
        const team = await this.db.select().from(teams).where(eq(teams.id, teamId)).get()
        if (!team) throw new Error(`Team ${teamId} not found`)
        return team
    }

    private getRows(userId: string): Promise<Row[]> {
        return this.db.select().from(teamUsers).where(eq(teamUsers.userId, userId)).all()
    }

    // ---------- Applying a wanted list to one member ----------

    /** Gives the member every role marked true. Roles must already exist (never creates them). */
    private async grant(book: RoleBook, discordId: string, held: Set<string>, wanted: Wanted, reason: string) {
        for (const [name, shouldHave] of wanted) {
            if (!shouldHave) continue
            const role = book.find(name)
            if (!role) throw new MissingRoleError(name)
            if (held.has(role.id)) continue
            if (!(await addRole(this.env, discordId, role.id, reason))) throw new UserNotInGuildError([discordId])
            held.add(role.id)
        }
    }

    /** Takes away every role marked false that the member has. Missing roles are skipped. */
    private async revoke(book: RoleBook, discordId: string, held: Set<string>, wanted: Wanted, reason: string) {
        for (const [name, shouldHave] of wanted) {
            if (shouldHave) continue
            const role = book.find(name)
            if (!role || !held.has(role.id)) continue
            await removeRole(this.env, discordId, role.id, reason)
            held.delete(role.id)
        }
    }

    // ---------- Users to teams ----------

    async addUserToTeam(userId: string, teamId: string, vertical: Vertical, isLead: boolean): Promise<NeededChange[]> {
        const [user, team, stored] = await Promise.all([this.getUser(userId), this.getTeam(teamId), this.getRows(userId)])
        if (!user.discordId) throw new Error(`User ${userId} has no Discord id`)
        const rows = withAssignment(stored, { teamId, vertical, isLead })

        // Checks first. Nothing is changed until all of them pass (no partial configs).
        const book = await loadRoleBook(this.env)
        const held = await getMemberRoleIds(this.env, user.discordId)
        if (!held) throw new UserNotInGuildError([user.discordId])
        const wanted = teamScopeWanted(team, rows, execKeep(book, held))
        const needed = missingRoleChanges(book, wantedNames(wanted))
        if (needed.length) return needed

        const reason = `Added to ${team.name} / ${vertical}`
        // Grants first so a lead <-> fellow swap never leaves someone without a role if it fails halfway
        await this.grant(book, user.discordId, held, wanted, reason)
        await this.revoke(book, user.discordId, held, wanted, reason)
        return []
    }

    async removeUserFromTeam(userId: string, teamId: string): Promise<void> {
        const [user, team, stored] = await Promise.all([this.getUser(userId), this.getTeam(teamId), this.getRows(userId)])
        if (!user.discordId) return

        const book = await loadRoleBook(this.env)
        const held = await getMemberRoleIds(this.env, user.discordId)
        if (!held) return // not in the server, so nothing to remove

        // Same whether or not the DB rows for this team are already gone
        const rows = stored.filter((r) => r.teamId !== teamId)
        const wanted = teamScopeWanted(team, rows, execKeep(book, held))
        await this.revoke(book, user.discordId, held, wanted, `Removed from ${team.name}`)
    }

    // ---------- Onboarding / deactivation ----------

    // Only `discord` (the user's Discord id) is used here. name/email/github are for other services.
    async onboardUser(_name: string, _email: string, _github: string, discord: string): Promise<NeededChange[]> {
        const book = await loadRoleBook(this.env)
        const held = await getMemberRoleIds(this.env, discord)
        if (!held) throw new UserNotInGuildError([discord])

        const wanted: Wanted = [[MEMBER_ROLE, true]]
        const needed = missingRoleChanges(book, wantedNames(wanted))
        if (needed.length) return needed

        await this.grant(book, discord, held, wanted, 'Onboarded')
        return []
    }

    async deactivateUser(userId: string): Promise<void> {
        const user = await this.getUser(userId)
        if (!user.discordId) return

        const book = await loadRoleBook(this.env)
        const held = await getMemberRoleIds(this.env, user.discordId)
        if (!held) return

        // Every role this service manages (checked against all teams, so it doesn't matter
        // whether the user's team_users rows still exist)
        const managed = new Set<string>(
            [MEMBER_ROLE, EXEC_BOARD_ROLE, ...rankRoleNames(), ...execRoleNames.map((e) => execRoles[e].role)].map(norm),
        )
        for (const team of await this.db.select().from(teams).all()) {
            for (const name of teamRoleNames(team)) managed.add(norm(name))
        }

        for (const roleId of [...held]) {
            const name = book.nameOf(roleId)
            if (name && managed.has(norm(name))) await removeRole(this.env, user.discordId, roleId, 'Deactivated')
        }
    }

    // ---------- Exec ----------

    async makeExec(userId: string, execRole: ExecRole): Promise<NeededChange[]> {
        const user = await this.getUser(userId)
        if (!user.discordId) throw new Error(`User ${userId} has no Discord id`)
        const cfg = execRoles[execRole]

        const book = await loadRoleBook(this.env)
        const held = await getMemberRoleIds(this.env, user.discordId)
        if (!held) throw new UserNotInGuildError([user.discordId])

        const wanted: Wanted = [
            [EXEC_BOARD_ROLE, true],
            [cfg.role, true],
        ]
        if (cfg.leadVertical) {
            wanted.push([LEAD_ROLE, true], [roleNames.verticalRank(cfg.leadVertical, true), true])
        }
        const needed = missingRoleChanges(book, wantedNames(wanted))
        if (needed.length) return needed

        await this.grant(book, user.discordId, held, wanted, `Made ${cfg.role}`)
        return []
    }

    async removeExec(userId: string, execRole: ExecRole): Promise<void> {
        const [user, rows] = await Promise.all([this.getUser(userId), this.getRows(userId)])
        if (!user.discordId) return
        const cfg = execRoles[execRole]

        const book = await loadRoleBook(this.env)
        const held = await getMemberRoleIds(this.env, user.discordId)
        if (!held) return

        // Keep anything still justified by another exec role, or by their team assignments
        const keep = execKeep(book, held, execRole)
        const stillExec = execRoleNames.some((e) => {
            const role = book.find(execRoles[e].role)
            return e !== execRole && !!role && held.has(role.id)
        })
        const wanted: Wanted = [
            [cfg.role, false],
            [EXEC_BOARD_ROLE, stillExec],
        ]
        if (cfg.leadVertical) {
            const v = cfg.leadVertical
            const leadName = roleNames.verticalRank(v, true)
            wanted.push([LEAD_ROLE, rows.some((r) => r.isLead) || keep.has(norm(LEAD_ROLE))])
            wanted.push([leadName, rows.some((r) => r.vertical === v && r.isLead) || keep.has(norm(leadName))])
        }
        await this.revoke(book, user.discordId, held, wanted, `No longer ${cfg.role}`)
    }

    // ---------- Teams ----------

    async createTeam(teamId: string): Promise<void> {
        const team = await this.getTeam(teamId)
        const book = await loadRoleBook(this.env)

        const [teamRoleName, ...verticalRoleNames] = teamRoleNames(team)
        const teamRole = book.find(teamRoleName)
        if (!teamRole) {
            await createRole(this.env, book, teamRoleName, true) // the one place a channel gets created with the role
        } else {
            await createTeamChannel(this.env, teamRole) // role existed already: just make sure the channel does
        }
        for (const name of verticalRoleNames) {
            if (!book.find(name)) await createRole(this.env, book, name)
        }
    }

    async deleteTeam(teamId: string): Promise<void> {
        // Needs the team's name, so call this before the teams row is deleted
        const team = await this.getTeam(teamId)
        const book = await loadRoleBook(this.env)

        // Deleting a role also takes it off everyone who had it
        for (const name of teamRoleNames(team)) {
            const role = book.find(name)
            if (!role) continue
            await deleteRole(this.env, role)
            book.remove(role)
        }
        const channel = await findTeamChannel(this.env, roleNames.team(team.name))
        if (channel) await deleteChannel(this.env, channel)
    }
}
/*
    todo:
    - write tests in a separate .ts file
    - members will have roles now
*/

// also make a prototype shell script that will add/remove people to the db/server(?)