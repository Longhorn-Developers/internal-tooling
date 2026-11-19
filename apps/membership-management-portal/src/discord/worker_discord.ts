import { verticalNames } from '../db/schema'
import type { Vertical } from '../db/schema'
import type { Team, User } from '../db/access'
import { Service, ServiceError, execRoles } from '../service'
import type { ExecRole, FixServiceResult, FailedChange, NeededChange, ServiceResult } from '../service'

// What the Discord service reads from the worker's env (the rest of the env is the base class's).
export interface DiscordEnv {
    DISCORD_TOKEN: string // wrangler secret put DISCORD_TOKEN
    GUILD_ID: string // wrangler.toml [vars]
    TEAM_CATEGORY_ID?: string // optional: Discord category new team channels are created under
}

const SERVICE = 'discord'
const FIX_BATCH_SIZE = 20 // autoFix does at most this many changes per call and defers the rest

// ============================================================
// Role naming
// Roles are found by name (case-insensitive) so the DB doesn't have to store role ids.
//
// NOTE TO MALCOLM/MILES: change these if you want a different naming convention.
// The defaults [hopefully] match the roles already in the server ("Leads", "Technical Leads", ...).
// Exec roles use the ExecRole string itself as the Discord role name ("SWE Director", ...).
// ============================================================

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

// The vertical each exec role also leads (they get "Leads" and "<Vertical> Leads").
const execLeadVertical: Partial<Record<ExecRole, Vertical>> = {
    'Product Director': 'product',
    'SWE Director': 'tech',
    'UX Design Director': 'design',
}

const roleNames = {
    team: (team: string) => team.slice(0, 100),
    // "<Vertical> Leads" / "<Vertical> Fellows"
    verticalRank: (vertical: Vertical, isLead: boolean) =>
        `${verticalLabels[vertical]} ${isLead ? 'Leads' : 'Fellows'}`.slice(0, 100),
    teamVertical: (team: string, vertical: Vertical) => `${team} ${verticalLabels[vertical]}`.slice(0, 100),
}

// Who gets which roles, from users.status. ASSUMPTION: adjust to match how statuses are used.
//   'active'            -> should have Members
//   'inactive' / 'alum' -> should have none of the roles this service manages
//   anything else       -> Members is left alone; team roles still follow team_users
const ENDED_STATUSES = ['inactive', 'alum']

// ============================================================
// Low-level Discord REST helpers (failures throw ServiceError)
// ============================================================

const API = 'https://discord.com/api/v10'
const UNKNOWN_CHANNEL = 'DISCORD_10003'
const UNKNOWN_ROLE = 'DISCORD_10011'
const UNKNOWN_MEMBER = 'DISCORD_10007' // user isn't in the server

const isCode = (e: unknown, code: string) => e instanceof ServiceError && e.code === code
const roleMissing = (name: string) => new ServiceError(SERVICE, 'ROLE_MISSING', false, `Role "${name}" does not exist`)

async function discord<T = void>(
    env: DiscordEnv,
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

    let res: Response
    try {
        res = await fetch(`${API}${path}`, {
            method,
            headers,
            body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        })
    } catch (e) {
        throw new ServiceError(SERVICE, 'DISCORD_NETWORK', true, e instanceof Error ? e.message : String(e))
    }

    if (!res.ok) {
        if (res.status === 429 && retry) {
            const { retry_after } = (await res.json()) as { retry_after: number }
            await new Promise((r) => setTimeout(r, Math.ceil(retry_after * 1000)))
            return discord<T>(env, method, path, opts, false)
        }

        const err = (await res.json().catch(() => ({}))) as { code?: number; message?: string }
        throw new ServiceError(
            SERVICE,
            err.code !== undefined ? `DISCORD_${err.code}` : `DISCORD_HTTP_${res.status}`,
            res.status === 429 || res.status >= 500, // retrying can work without changing anything
            err.message ?? `Discord returned ${res.status}`,
        )
    }

    if (res.status === 204) return undefined as T
    return (await res.json()) as T
}

// These return false if the user isn't in the server (nothing to do), true otherwise.
export const addRole = async (env: DiscordEnv, discordId: string, roleId: string, reason?: string) =>
    ignoreUnknownMember(() =>
        discord(env, 'PUT', `/guilds/${env.GUILD_ID}/members/${discordId}/roles/${roleId}`, { reason }),
    )

export const removeRole = async (env: DiscordEnv, discordId: string, roleId: string, reason?: string) =>
    ignoreUnknownMember(() =>
        discord(env, 'DELETE', `/guilds/${env.GUILD_ID}/members/${discordId}/roles/${roleId}`, { reason }),
    )

export const kickMember = async (env: DiscordEnv, discordId: string, reason?: string) =>
    ignoreUnknownMember(() => discord(env, 'DELETE', `/guilds/${env.GUILD_ID}/members/${discordId}`, { reason }))

async function ignoreUnknownMember(fn: () => Promise<unknown>): Promise<boolean> {
    try {
        await fn()
        return true
    } catch (e) {
        if (isCode(e, UNKNOWN_MEMBER)) return false
        throw e
    }
}

/** The ids of the roles a member currently has, or null if they aren't in the server. */
export async function getMemberRoleIds(env: DiscordEnv, discordId: string): Promise<Set<string> | null> {
    try {
        const member = await discord<{ roles: string[] }>(env, 'GET', `/guilds/${env.GUILD_ID}/members/${discordId}`)
        return new Set(member.roles)
    } catch (e) {
        if (isCode(e, UNKNOWN_MEMBER)) return null
        throw e
    }
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

async function loadRoleBook(env: DiscordEnv): Promise<RoleBook> {
    const book = new RoleBook()
    for (const role of await discord<DiscordRole[]>(env, 'GET', `/guilds/${env.GUILD_ID}/roles`)) book.add(role)
    return book
}

/**
 * Creates a role (no permissions). Never assigns it to anyone.
 * createChannel: also create the role's private team channel. Only createTeam passes true.
 */
async function createRole(env: DiscordEnv, book: RoleBook, name: string, createChannel = false): Promise<DiscordRole> {
    const role = await discord<DiscordRole>(env, 'POST', `/guilds/${env.GUILD_ID}/roles`, {
        body: { name, permissions: '0', mentionable: false },
        reason: 'Created by the team service',
    })
    book.add(role)
    if (createChannel) await createTeamChannel(env, role)
    return role
}

async function deleteRole(env: DiscordEnv, role: DiscordRole) {
    try {
        await discord(env, 'DELETE', `/guilds/${env.GUILD_ID}/roles/${role.id}`, { reason: 'Team deleted' })
    } catch (e) {
        if (!isCode(e, UNKNOWN_ROLE)) throw e
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

const listChannels = (env: DiscordEnv) => discord<DiscordChannel[]>(env, 'GET', `/guilds/${env.GUILD_ID}/channels`)

// type 0 = text channel
const channelFor = (channels: DiscordChannel[], teamRole: string) =>
    channels.find((c) => c.type === 0 && c.name === slugify(teamRole))

/** Creates a text channel only the team's role can see. Does nothing if it already exists. */
async function createTeamChannel(env: DiscordEnv, teamRole: DiscordRole): Promise<DiscordChannel> {
    const existing = channelFor(await listChannels(env), teamRole.name)
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

async function deleteChannel(env: DiscordEnv, channel: DiscordChannel) {
    try {
        await discord(env, 'DELETE', `/channels/${channel.id}`, { reason: 'Team deleted' })
    } catch (e) {
        if (!isCode(e, UNKNOWN_CHANNEL)) throw e
    }
}

// ============================================================
// Building NeededChanges and ServiceResults
// ============================================================

function change(
    kind: string,
    target: string,
    reason: string,
    o: { teamId?: string; userId?: string; fixable?: boolean; blocking?: boolean } = {},
): NeededChange {
    return {
        service: SERVICE,
        kind,
        target,
        reason,
        teamId: o.teamId,
        userId: o.userId,
        fixable: o.fixable ?? true,
        blocking: o.blocking ?? false,
    }
}

const createRoleChange = (name: string, teamId?: string) =>
    change('create_role', name, `Role "${name}" doesn't exist`, { teamId, blocking: true })

const notInGuild = (userId: string | undefined, discordId: string) =>
    change('user_not_in_guild', discordId, `Discord account ${discordId} hasn't joined the server`, {
        userId,
        fixable: false, // the person has to join
        blocking: true,
    })

const noDiscordId = (userId: string) =>
    change('user_missing_discord_id', userId, `User ${userId} has no Discord id in D1`, {
        userId,
        fixable: false, // someone has to fix D1
        blocking: true,
    })

/** The action ran (or had nothing to do). */
const ok = (changes: NeededChange[] = []): ServiceResult => ({ changes, failed: false })
/** The action did not run: something it needs is missing, and nothing was changed. */
const blocked = (changes: NeededChange[]): ServiceResult => ({ changes, failed: true })

function dedupe(changes: NeededChange[]): NeededChange[] {
    const seen = new Set<string>()
    return changes.filter((c) => {
        const key = [c.kind, norm(c.target), c.userId ?? '', c.teamId ?? ''].join('|')
        if (seen.has(key)) return false
        seen.add(key)
        return true
    })
}

// ============================================================
// Working out which roles someone should have
// ============================================================

type TeamLike = { id: string; name: string }
type UserLike = { id: string; discordId?: string | null; status?: string | null; isExec?: boolean | null }
type Row = { teamId: string; vertical: Vertical; isLead: boolean }
type Wanted = Array<[name: string, shouldHave: boolean]>

/** D1 assignments grouped by user id. */
function groupRows(assignments: Array<Row & { userId: string }>): Map<string, Row[]> {
    const byUser = new Map<string, Row[]>()
    for (const { userId, teamId, vertical, isLead } of assignments) {
        byUser.set(userId, [...(byUser.get(userId) ?? []), { teamId, vertical, isLead }])
    }
    return byUser
}

const hasEnded = (user: UserLike) => ENDED_STATUSES.includes(user.status ?? '')

/**
 * The user's stored assignments with one change applied on top. This makes the result the
 * same whether the DB was updated before or after the service was called.
 */
const withAssignment = (rows: Row[], row: Row): Row[] => [
    ...rows.filter((r) => !(r.teamId === row.teamId && r.vertical === row.vertical)),
    row,
]

/** Roles unique to one team: the team role, plus one per vertical. */
const teamRoleNames = (team: TeamLike) => [
    roleNames.team(team.name),
    ...verticalNames.map((v) => roleNames.teamVertical(team.name, v)),
]

/** Roles shared by all teams: Leads, Fellows, and "<Vertical> Leads/Fellows". */
const rankRoleNames = () => [
    LEAD_ROLE,
    FELLOW_ROLE,
    ...verticalNames.flatMap((v) => [roleNames.verticalRank(v, true), roleNames.verticalRank(v, false)]),
]

/** Every role this service manages. Used to tell "ours" from roles it must never touch. */
const managedNames = (allTeams: TeamLike[]) =>
    new Set(
        [MEMBER_ROLE, EXEC_BOARD_ROLE, ...execRoles, ...rankRoleNames(), ...allTeams.flatMap(teamRoleNames)].map(norm),
    )

/**
 * Lead roles that exec roles the member holds in Discord imply (e.g. SWE Director -> Leads +
 * Technical Leads). Syncing team assignments must not strip these.
 */
function execKeep(book: RoleBook, held: Set<string>, except?: ExecRole): Set<string> {
    const keep = new Set<string>()
    for (const e of execRoles) {
        const vertical = execLeadVertical[e]
        const role = book.find(e)
        if (e === except || !vertical || !role || !held.has(role.id)) continue
        keep.add(norm(LEAD_ROLE))
        keep.add(norm(roleNames.verticalRank(vertical, true)))
    }
    return keep
}

/** "<Team>" if they're on the team; "<Team> <Vertical>" for each vertical they're assigned to on it. */
function teamRoleEntries(team: TeamLike, rows: Row[]): Wanted {
    const onTeam = rows.filter((r) => r.teamId === team.id)
    return [
        [roleNames.team(team.name), onTeam.length > 0],
        ...verticalNames.map((v): [string, boolean] => [
            roleNames.teamVertical(team.name, v),
            onTeam.some((r) => r.vertical === v),
        ]),
    ]
}

/**
 * "Leads" / "Fellows" if any assignment (on any team) is lead / not lead, and
 * "<Vertical> Leads/Fellows" if any assignment in that vertical is lead / not lead.
 * `rows` must be ALL of the user's assignments, so roles shared with their other teams are kept.
 */
function rankEntries(rows: Row[], kept: (name: string) => boolean): Wanted {
    const wanted: Wanted = [
        [LEAD_ROLE, rows.some((r) => r.isLead) || kept(LEAD_ROLE)],
        [FELLOW_ROLE, rows.some((r) => !r.isLead)],
    ]
    for (const v of verticalNames) {
        const leadName = roleNames.verticalRank(v, true)
        wanted.push([leadName, rows.some((r) => r.vertical === v && r.isLead) || kept(leadName)])
        wanted.push([roleNames.verticalRank(v, false), rows.some((r) => r.vertical === v && !r.isLead)])
    }
    return wanted
}

/** Everything one team can affect for one user. */
const teamScopeWanted = (team: TeamLike, rows: Row[], keep: Set<string>): Wanted => [
    ...teamRoleEntries(team, rows),
    ...rankEntries(rows, (name) => keep.has(norm(name))),
]

/** Everything this service manages for one user, with whether they should have it. For the syncs. */
function fullWanted(user: UserLike, rows: Row[], allTeams: TeamLike[], keep: Set<string>): Wanted {
    const ended = hasEnded(user)
    const live = ended ? [] : rows
    const wanted: Wanted = []

    if (ended) wanted.push([MEMBER_ROLE, false])
    else if (user.status === 'active') wanted.push([MEMBER_ROLE, true])

    for (const team of allTeams) wanted.push(...teamRoleEntries(team, live))
    wanted.push(...rankEntries(live, (name) => !ended && keep.has(norm(name))))

    // Which exec role someone holds isn't stored in D1, so for execs only the shared role is checked
    if (user.isExec && !ended) wanted.push([EXEC_BOARD_ROLE, true])
    else wanted.push([EXEC_BOARD_ROLE, false], ...execRoles.map((e): [string, boolean] => [e, false]))

    return wanted
}

const wantedNames = (wanted: Wanted) => wanted.filter(([, shouldHave]) => shouldHave).map(([name]) => name)

/** The roles in `names` that don't exist in the server yet, as (blocking) changes to make. */
const missingRoleChanges = (book: RoleBook, names: string[], teamId?: string): NeededChange[] =>
    dedupe(names.filter((n) => !book.find(n)).map((n) => createRoleChange(n, teamId)))

/** Where a member's roles differ from `wanted`, as changes. Missing roles come with the change that creates them. */
function diffChanges(
    book: RoleBook,
    held: Set<string>,
    wanted: Wanted,
    ctx: { userId: string; teamId?: string },
): NeededChange[] {
    const out: NeededChange[] = []
    for (const [name, shouldHave] of wanted) {
        const role = book.find(name)
        if (shouldHave) {
            if (!role) out.push(createRoleChange(name, ctx.teamId))
            if (!role || !held.has(role.id)) {
                out.push(change('add_role', name, `Should have role "${name}"`, ctx))
            }
        } else if (role && held.has(role.id)) {
            out.push(change('remove_role', name, `Should not have role "${name}"`, ctx))
        }
    }
    return out
}

/** Roles and channel for one team, as changes to make. */
function teamEntityChanges(book: RoleBook, channels: DiscordChannel[], team: TeamLike): NeededChange[] {
    const changes = missingRoleChanges(book, teamRoleNames(team), team.id)
    const teamRole = roleNames.team(team.name)
    if (!channelFor(channels, teamRole)) {
        changes.push(change('create_team_channel', teamRole, `Channel for "${teamRole}" doesn't exist`, { teamId: team.id }))
    }
    return changes
}

// ============================================================
// The service
// ============================================================

type Reach = { discordId: string; held: Set<string> }
const isProblem = (r: Reach | NeededChange): r is NeededChange => 'kind' in r

export class DiscordService extends Service {
    readonly name = SERVICE

    // The base class types env as Cloudflare.Env, which only has the Discord vars once they're in your
    // generated types. This says "env also has them" so this.env can be passed to the helpers above.
    declare protected readonly env: Cloudflare.Env & DiscordEnv

    // ---------- D1 reads (through this.db; this class never writes) ----------

    /** All of one user's assignments, across every team (shared roles like Leads depend on all of them). */
    private async getRows(userId: string): Promise<Row[]> {
        return (await this.db.getState()).assignments.filter((a) => a.userId === userId)
    }

    private getTeams(): Promise<Team[]> {
        return this.db.listTeams()
    }

    // ---------- Reaching a member ----------

    /** Finds the member in the server, or says why they can't be reached. */
    private async reach(user: UserLike): Promise<Reach | NeededChange> {
        if (!user.discordId) return noDiscordId(user.id)
        const held = await getMemberRoleIds(this.env, user.discordId)
        if (!held) return notInGuild(user.id, user.discordId)
        return { discordId: user.discordId, held }
    }

    // ---------- Applying a wanted list to one member ----------

    /** Gives the member every role marked true. Roles must already exist (never creates them). */
    private async grant(book: RoleBook, discordId: string, held: Set<string>, wanted: Wanted, reason: string) {
        for (const [name, shouldHave] of wanted) {
            if (!shouldHave) continue
            const role = book.find(name)
            if (!role) throw roleMissing(name)
            if (held.has(role.id)) continue
            if (!(await addRole(this.env, discordId, role.id, reason))) {
                throw new ServiceError(SERVICE, 'USER_NOT_IN_GUILD', false, `${discordId} left the server`)
            }
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

    // ---------- Users and teams ----------

    async addUserToTeam(user: User, team: Team, vertical: Vertical, isLead: boolean): Promise<ServiceResult> {
        const rows = withAssignment(await this.getRows(user.id), { teamId: team.id, vertical, isLead })

        // Checks first. Nothing is changed until all of them pass (no partial configs).
        const book = await loadRoleBook(this.env)
        const reach = await this.reach(user)
        const wanted = teamScopeWanted(team, rows, execKeep(book, isProblem(reach) ? new Set() : reach.held))
        const missing = missingRoleChanges(book, wantedNames(wanted), team.id)
        if (isProblem(reach)) return blocked([reach, ...missing])
        if (missing.length) return blocked(missing)

        const reason = `Added to ${team.name} / ${vertical}`
        // Grants first so a lead <-> fellow swap never leaves someone without a role if it fails halfway
        await this.grant(book, reach.discordId, reach.held, wanted, reason)
        await this.revoke(book, reach.discordId, reach.held, wanted, reason)
        return ok()
    }

    async removeUserFromTeam(user: User, team: Team): Promise<ServiceResult> {
        const reach = await this.reach(user)
        if (isProblem(reach)) return ok() // can't be in the server's roles, so nothing to remove

        const book = await loadRoleBook(this.env)
        // Same whether or not the DB rows for this team are already gone
        const rows = (await this.getRows(user.id)).filter((r) => r.teamId !== team.id)
        const wanted = teamScopeWanted(team, rows, execKeep(book, reach.held))
        await this.revoke(book, reach.discordId, reach.held, wanted, `Removed from ${team.name}`)
        return ok()
    }

    // ---------- Onboarding / deactivation ----------

    // Only `discord` (the user's Discord id) is used here. name/email/github are for other services.
    async onboardUser(_name: string, _email: string, _github: string | undefined, discord: string): Promise<ServiceResult> {
        const book = await loadRoleBook(this.env)
        const held = await getMemberRoleIds(this.env, discord)
        const missing = missingRoleChanges(book, [MEMBER_ROLE])
        if (!held) return blocked([notInGuild(undefined, discord), ...missing])
        if (missing.length) return blocked(missing)

        await this.grant(book, discord, held, [[MEMBER_ROLE, true]], 'Onboarded')
        return ok()
    }

    async deactivateUser(user: User): Promise<ServiceResult> {
        const reach = await this.reach(user)
        if (isProblem(reach)) return ok()

        const book = await loadRoleBook(this.env)
        // Checked against every team, so it doesn't matter whether the user's team_users rows still exist
        const managed = managedNames(await this.getTeams())
        for (const roleId of [...reach.held]) {
            const name = book.nameOf(roleId)
            if (name && managed.has(norm(name))) await removeRole(this.env, reach.discordId, roleId, 'Deactivated')
        }
        return ok()
    }

    async updateUser(before: User, after: User): Promise<ServiceResult> {
        if (before.discordId === after.discordId) return ok() // nothing Discord cares about changed
        if (!before.discordId) return ok() // had no account to move from; syncUser will report what's missing

        const oldHeld = await getMemberRoleIds(this.env, before.discordId)
        if (!oldHeld) return ok() // old account is gone; syncUser will report what the new one is missing

        const book = await loadRoleBook(this.env)
        const managed = managedNames(await this.getTeams())
        const toMove = [...oldHeld].filter((id) => {
            const name = book.nameOf(id)
            return !!name && managed.has(norm(name))
        })

        if (after.discordId) {
            const newHeld = await getMemberRoleIds(this.env, after.discordId)
            if (!newHeld) return blocked([notInGuild(after.id, after.discordId)]) // nothing changed
            for (const roleId of toMove) {
                if (newHeld.has(roleId)) continue
                if (!(await addRole(this.env, after.discordId, roleId, 'Discord account changed'))) {
                    throw new ServiceError(SERVICE, 'USER_NOT_IN_GUILD', false, `${after.discordId} left the server`)
                }
            }
        }
        for (const roleId of toMove) await removeRole(this.env, before.discordId, roleId, 'Discord account changed')
        return ok()
    }

    // ---------- Exec ----------

    async makeExec(user: User, execRole: ExecRole): Promise<ServiceResult> {
        const book = await loadRoleBook(this.env)
        const reach = await this.reach(user)

        const wanted: Wanted = [
            [EXEC_BOARD_ROLE, true],
            [execRole, true],
        ]
        const vertical = execLeadVertical[execRole]
        if (vertical) wanted.push([LEAD_ROLE, true], [roleNames.verticalRank(vertical, true), true])

        const missing = missingRoleChanges(book, wantedNames(wanted))
        if (isProblem(reach)) return blocked([reach, ...missing])
        if (missing.length) return blocked(missing)

        await this.grant(book, reach.discordId, reach.held, wanted, `Made ${execRole}`)
        return ok()
    }

    async removeExec(user: User, execRole: ExecRole): Promise<ServiceResult> {
        const reach = await this.reach(user)
        if (isProblem(reach)) return ok()

        const book = await loadRoleBook(this.env)
        const rows = await this.getRows(user.id)

        // Keep anything still justified by another exec role, or by their team assignments
        const keep = execKeep(book, reach.held, execRole)
        const stillExec = execRoles.some((e) => {
            const role = book.find(e)
            return e !== execRole && !!role && reach.held.has(role.id)
        })
        const wanted: Wanted = [
            [execRole, false],
            [EXEC_BOARD_ROLE, stillExec],
        ]
        const v = execLeadVertical[execRole]
        if (v) {
            const leadName = roleNames.verticalRank(v, true)
            wanted.push([LEAD_ROLE, rows.some((r) => r.isLead) || keep.has(norm(LEAD_ROLE))])
            wanted.push([leadName, rows.some((r) => r.vertical === v && r.isLead) || keep.has(norm(leadName))])
        }
        await this.revoke(book, reach.discordId, reach.held, wanted, `No longer ${execRole}`)
        return ok()
    }

    // ---------- Teams ----------

    async createTeam(team: Team): Promise<ServiceResult> {
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
        return ok()
    }

    async deleteTeam(team: Team): Promise<ServiceResult> {
        const book = await loadRoleBook(this.env)

        // Deleting a role also takes it off everyone who had it
        for (const name of teamRoleNames(team)) {
            const role = book.find(name)
            if (!role) continue
            await deleteRole(this.env, role)
            book.remove(role)
        }
        const channel = channelFor(await listChannels(this.env), roleNames.team(team.name))
        if (channel) await deleteChannel(this.env, channel)
        return ok()
    }

    // ---------- Syncs: report only, change nothing ----------

    /** The team's roles and channel, plus whether each of its D1 members has the right roles for it. */
    async syncTeam(team: Team): Promise<ServiceResult> {
        const book = await loadRoleBook(this.env)
        const changes = teamEntityChanges(book, await listChannels(this.env), team)

        const state = await this.db.getState()
        const rowsByUser = groupRows(state.assignments)
        const onTeam = new Set(state.assignments.filter((a) => a.teamId === team.id).map((a) => a.userId))

        for (const user of state.users.filter((u) => onTeam.has(u.id))) {
            const rows = rowsByUser.get(user.id) ?? []
            const reach = await this.reach(user)
            if (isProblem(reach)) {
                if (!hasEnded(user)) changes.push({ ...reach, blocking: false })
                continue
            }
            const wanted = teamScopeWanted(team, rows, execKeep(book, reach.held))
            changes.push(...diffChanges(book, reach.held, wanted, { userId: user.id, teamId: team.id }))
        }
        return ok(dedupe(changes))
    }

    /** One user's roles across every team, plus Members and exec roles. Also finds roles they shouldn't have. */
    async syncUser(user: User): Promise<ServiceResult> {
        const [book, rows, allTeams] = await Promise.all([loadRoleBook(this.env), this.getRows(user.id), this.getTeams()])
        return ok(dedupe(await this.userChanges(user, rows, allTeams, book)))
    }

    /** Every team's entities, the shared roles, and every D1 user's roles. */
    async syncService(): Promise<ServiceResult> {
        const [book, channels, state] = await Promise.all([
            loadRoleBook(this.env),
            listChannels(this.env),
            this.db.getState(),
        ])
        const rowsByUser = groupRows(state.assignments)

        const changes = missingRoleChanges(book, [MEMBER_ROLE, EXEC_BOARD_ROLE, ...execRoles, ...rankRoleNames()])
        for (const team of state.teams) changes.push(...teamEntityChanges(book, channels, team))
        for (const user of state.users) {
            changes.push(...(await this.userChanges(user, rowsByUser.get(user.id) ?? [], state.teams, book)))
        }
        return ok(dedupe(changes))
    }

    private async userChanges(user: UserLike, rows: Row[], allTeams: TeamLike[], book: RoleBook): Promise<NeededChange[]> {
        const reach = await this.reach(user)
        if (isProblem(reach)) return hasEnded(user) ? [] : [{ ...reach, blocking: false }]

        const keep = user.isExec && !hasEnded(user) ? execKeep(book, reach.held) : new Set<string>()
        return diffChanges(book, reach.held, fullWanted(user, rows, allTeams, keep), { userId: user.id })
    }

    // ---------- Fixing ----------

    /**
     * Makes the changes this service reported that it can make, in a safe order (roles, then channels,
     * then memberships). At most FIX_BATCH_SIZE per call; the rest come back in `changes` to resubmit.
     * Re-running is safe: everything here is idempotent.
     */
    async autoFix(changes: NeededChange[]): Promise<FixServiceResult> {
        const order = new Map([
            ['create_role', 0],
            ['create_team_channel', 1],
            ['add_role', 2],
            ['remove_role', 3],
        ])

        const rejected: NeededChange[] = []
        const queue: NeededChange[] = []
        for (const c of changes) {
            if (c.service === SERVICE && c.fixable && order.has(c.kind)) queue.push(c)
            else rejected.push(c) // needs a person, or isn't ours / a kind we know
        }
        queue.sort((a, b) => order.get(a.kind)! - order.get(b.kind)!)

        const batch = queue.slice(0, FIX_BATCH_SIZE)
        const deferred = queue.slice(FIX_BATCH_SIZE)
        const book = await loadRoleBook(this.env)

        const failedChanges: FailedChange[] = []
        for (const c of batch) {
            try {
                await this.fix(c, book)
            } catch (e) {
                failedChanges.push({ change: c, error: e instanceof Error ? e : new Error(String(e)) })
            }
        }
        return { changes: deferred, failed: failedChanges.length > 0, failedChanges, rejected }
    }

    private async fix(c: NeededChange, book: RoleBook): Promise<void> {
        switch (c.kind) {
            case 'create_role':
                if (!book.find(c.target)) await createRole(this.env, book, c.target) // no channel: only createTeam makes one
                return

            case 'create_team_channel': {
                const role = book.find(c.target)
                if (!role) throw roleMissing(c.target)
                await createTeamChannel(this.env, role)
                return
            }

            case 'add_role':
            case 'remove_role': {
                if (!c.userId) throw new Error(`Change for role "${c.target}" has no userId`)
                const user = await this.db.getUser(c.userId) // throws RecordNotFoundError if they're gone
                if (!user.discordId) throw new Error(`User ${c.userId} has no Discord id in D1`)
                const role = book.find(c.target)
                if (!role) throw roleMissing(c.target)

                if (c.kind === 'remove_role') {
                    await removeRole(this.env, user.discordId, role.id, c.reason)
                } else if (!(await addRole(this.env, user.discordId, role.id, c.reason))) {
                    throw new ServiceError(SERVICE, 'USER_NOT_IN_GUILD', false, `${user.discordId} hasn't joined the server`)
                }
                return
            }

            default:
                throw new Error(`Unsupported change kind "${c.kind}"`)
        }
    }
}

/*
    todo:
    - write tests in a separate .ts file
*/

// also make a prototype shell script that will add/remove people to the db/server(?)