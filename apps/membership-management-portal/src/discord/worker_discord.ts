import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import { teams, teamUsers, users } from '../db/schema'
import type { Vertical } from '../db/schema'
 
export interface Env {
    DB: D1Database
    DISCORD_TOKEN: string // wrangler secret put DISCORD_TOKEN
    GUILD_ID: string // wrangler.toml [vars]
}
 
// Role naming
// Roles are found by name (case-insensitive) so the DB doesn't have to store role ids.
// If a role with the name doesn't exist yet, it gets created.
//
// NOTE TO MALCOLM/MILES: change these if you want a different naming convention.
// The defaults [hopefully] match the roles already in the server ("Leads", "Technical Leads", ...).
 
const LEAD_ROLE = 'Leads' // everyone who leads at least one vertical
const FELLOW_ROLE = 'Fellows' // everyone who is a fellow in at least one vertical
 
// How each vertical is written in role names. Record<Vertical, ...> makes TypeScript
// complain if a vertical is added to the schema without adding a label here.
const verticalLabels: Record<Vertical, string> = {
    product: 'Product',
    tech: 'Technical',
    design: 'Design',
}
 
const roleNames = {
    team: (team: string) => team.slice(0, 100),
    // "<Vertical> Leads" / "<Vertical> Fellows"
    verticalRank: (vertical: Vertical, isLead: boolean) =>
        `${verticalLabels[vertical]} ${isLead ? 'Leads' : 'Fellows'}`.slice(0, 100),
    teamVertical: (team: string, vertical: Vertical) => `${team} ${verticalLabels[vertical]}`.slice(0, 100),
}
 
// ============================================================
// Low-level Discord REST helpers
// ============================================================
 
const API = 'https://discord.com/api/v10'
const UNKNOWN_ROLE = 10011
const UNKNOWN_MEMBER = 10007 // user isn't in the server
 
export class DiscordError extends Error {
    constructor(
        public status: number,
        public code: number | undefined,
        message: string,
    ) {
        super(message)
    }
}
 
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
 
// Returns false if the user isn't in the server (nothing to do), true otherwise.
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
 
async function getDiscordId(env: Env, userId: string) {
    // lowk useless rn, will likely have to be exported
    const [user] = await drizzle(env.DB).select().from(users).where(eq(users.id, userId))
    if (!user) {
        throw new Error(`User ${userId} not found`)
    }
    return user.discordId
}
 
// ============================================================
// Role lookup by name (with create-if-missing)
// ============================================================
 
interface DiscordRole {
    id: string
    name: string
    managed: boolean
}
 
const ROLE_CACHE_TTL_MS = 60_000
let roleCache: { at: number; byName: Map<string, DiscordRole> } | null = null
// If two requests both need a role that doesn't exist yet, the second one waits on the
// first one's in-progress "create" instead of creating a duplicate. Same-isolate only.
const inflightCreates = new Map<string, Promise<DiscordRole>>()
 
const norm = (name: string) => name.trim().toLowerCase()
 
async function loadRoles(env: Env): Promise<Map<string, DiscordRole>> {
    if (roleCache && Date.now() - roleCache.at < ROLE_CACHE_TTL_MS) return roleCache.byName
 
    const roles = await discord<DiscordRole[]>(env, 'GET', `/guilds/${env.GUILD_ID}/roles`)
    const byName = new Map<string, DiscordRole>()
    for (const role of roles) {
        // Skip bot/integration roles; first match wins if names are duplicated
        if (!role.managed && !byName.has(norm(role.name))) byName.set(norm(role.name), role)
    }
    roleCache = { at: Date.now(), byName }
    return byName
}
 
async function findRole(env: Env, name: string): Promise<DiscordRole | undefined> {
    return (await loadRoles(env)).get(norm(name))
}
 
/** Finds the role with this name, creating it first if it doesn't exist. */
async function ensureRole(env: Env, name: string): Promise<DiscordRole> {
    const existing = await findRole(env, name)
    if (existing) return existing
 
    const key = norm(name)
    let pending = inflightCreates.get(key)
    if (!pending) {
        pending = discord<DiscordRole>(env, 'POST', `/guilds/${env.GUILD_ID}/roles`, {
            body: { name, permissions: '0', mentionable: false },
            reason: 'Auto-created for team/vertical',
        })
            .then((role) => {
                roleCache?.byName.set(key, role)
                return role
            })
            .finally(() => inflightCreates.delete(key))
        inflightCreates.set(key, pending)
    }
    return pending
}
 
/** Alternate for the addRole function that assigns the role via its the input name rather than id
 * Also creates the role if it doesn't exist */
async function assignRoleByName(env: Env, discordId: string, name: string, reason: string): Promise<boolean> {
    for (let attempt = 0; ; attempt++) {
        const role = await ensureRole(env, name)
        try {
            return await addRole(env, discordId, role.id, reason)
        } catch (e) {
            // if cached role was deleted, refresh the cache and try again
            if (e instanceof DiscordError && e.code === UNKNOWN_ROLE && attempt === 0) {
                roleCache = null
                continue
            }
            throw e
        }
    }
}
 
/**
 * Alternate for the removeRole function that removes the role via its the input name rather than id 
 * Same behavior as removeRole basically
 */
async function revokeRoleByName(env: Env, discordId: string, name: string, reason: string): Promise<boolean> {
    const role = await findRole(env, name)
    if (!role) return true
    try {
        return await removeRole(env, discordId, role.id, reason)
    } catch (e) {
        if (e instanceof DiscordError && e.code === UNKNOWN_ROLE) {
            roleCache = null
            return true
        }
        throw e
    }
}
 
// ============================================================
// team_users <-> Discord roles
// ============================================================
 
interface Assignment {
    userId: string
    teamId: string
    vertical: Vertical
}
 

async function loadContext(env: Env, { userId, teamId }: Assignment) {
    const db = drizzle(env.DB)
    const [user, team] = await Promise.all([
        db.select().from(users).where(eq(users.id, userId)).get(),
        db.select().from(teams).where(eq(teams.id, teamId)).get(),
    ])
    if (!user) throw new Error(`User ${userId} not found`)
    if (!team) throw new Error(`Team ${teamId} not found`)
    return { db, user, team }
}
 
/**
 * The one entry point, call it AFTER the team_users row was added, removed, or had its
 * isLead changed, passing only WHICH assignment changed. This module never writes to
 * team_users: it reads the user's current rows, works out which roles they should have,
 * and makes Discord match. Safe to call repeatedly (idempotent).
 *
 * For the affected team + vertical, the user should have:
 *   - team role                 "<Team>"                 if any row of theirs is on that team
 *   - team/vertical role        "<Team> <Vertical>"      if this exact row exists
 *   - "Leads"                   if any row of theirs has isLead
 *   - "Fellows"                 if any row of theirs has !isLead
 *   - "<Vertical> Leads"        if a row in that vertical has isLead
 *   - "<Vertical> Fellows"      if a row in that vertical has !isLead
 * Everything else on that list is removed. Because it's state-based, flipping isLead
 * swaps Leads <-> Fellows automatically, and roles shared with the user's other
 * assignments are kept.
 */
export async function syncAssignment(env: Env, a: Assignment) {
    const { db, user, team } = await loadContext(env, a)
    const rows = await db.select().from(teamUsers).where(eq(teamUsers.userId, a.userId)).all()
 
    const inVertical = rows.filter((r) => r.vertical === a.vertical)
    const wanted: Array<[name: string, shouldHave: boolean]> = [
        [roleNames.team(team.name), rows.some((r) => r.teamId === a.teamId)],
        [roleNames.teamVertical(team.name, a.vertical), inVertical.some((r) => r.teamId === a.teamId)],
        [LEAD_ROLE, rows.some((r) => r.isLead)],
        [FELLOW_ROLE, rows.some((r) => !r.isLead)],
        [roleNames.verticalRank(a.vertical, true), inVertical.some((r) => r.isLead)],
        [roleNames.verticalRank(a.vertical, false), inVertical.some((r) => !r.isLead)],
    ]
    const toGrant = wanted.filter(([, shouldHave]) => shouldHave).map(([name]) => name)
    const toRevoke = wanted.filter(([, shouldHave]) => !shouldHave).map(([name]) => name)
 
    const none = { inGuild: false, granted: [] as string[], revoked: [] as string[] }
    if (!user.discordId) return none
 
    const reason = `Synced ${team.name} / ${a.vertical}`
 
    // Sequential on purpose: keeps us well inside Discord's role rate limits.
    // Grants first so a lead <-> fellow swap never leaves someone without a role if it fails halfway.
    for (const name of toGrant) {
        if (!(await assignRoleByName(env, user.discordId, name, reason))) return none
    }
    for (const name of toRevoke) {
        if (!(await revokeRoleByName(env, user.discordId, name, reason))) return none
    }
    return { inGuild: true, granted: toGrant, revoked: toRevoke }
}
 
/*
    todo:
    - write tests in a separate .ts file
    - implement channels
    - members will have roles now
*/

