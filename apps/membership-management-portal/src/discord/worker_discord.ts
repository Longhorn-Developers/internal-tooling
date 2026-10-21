import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import { assignVertical, removeVertical } from '../db/access'
import { teams, teamUsers, users } from '../db/schema'
import type { Vertical } from '../db/schema'
 
export interface Env {
    DB: D1Database
    DISCORD_TOKEN: string // wrangler secret put DISCORD_TOKEN
    GUILD_ID: string // wrangler.toml [vars]
}

// Role naming
// Team/verticals are found by name so the DB doesn't have to store role ids
// 
// NOTE TO MALCOLM/MILES: Change these if you want a different naming convention for team/vertical roles
 
const roleNames = {
    team: (team: string) => team.slice(0, 100),
    vertical: (vertical: string) => vertical.slice(0, 100), // e.g. map 'frontend' -> 'Frontend' here if you like
    teamVertical: (team: string, vertical: string) => `${team} ${vertical}`.slice(0, 100),
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


async function discord<T=void>(
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
            return discord(env, method, path, opts, false)
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

async function ignoreUnknownMember(fn: () => Promise<T>): Promise<boolean> {
    try {
        await fn()
        return true
    } catch (e) {
        if (e instanceof DiscordError && e.code === UNKNOWN_MEMBER) return false
        throw e
    }
}

async function getDiscordId(env: Env, userId: string) {
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
const inflightCreates = new Map<string, Promise<DiscordRole>>() // avoids duplicate creates (claude suggested, unsure as to its implementation)

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

async function hasRole(env: Env, name: string): Promise<DiscordRole> {
    const existing = await findRole(env, name)
    if (existing) return existing
 
    const key = norm(name)
    let pending = inflightCreates.get(key) // also claude-suggested stuff, read up on later
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
        const role = await hasRole(env, name)
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

/** Gives the user: 
 *    - team role
 *    - vertical role
 *    - team/vertical role
 * 
 * creates any that are missing (behavior of addRoleByName)
 */
export async function grantAssignmentRoles(env: Env, a: Assignment) {
    const { user, team } = await loadContext(env, a)
    const names = [
        roleNames.team(team.name),
        roleNames.vertical(a.vertical),
        roleNames.teamVertical(team.name, a.vertical),
    ]
    if (!user.discordId) return { inGuild: false, roles: [] as string[] }
 
    // Sequential on purpose: keeps us well inside Discord's role rate limits
    for (const name of names) {
        const inGuild = await assignRoleByName(env, user.discordId, name, `Assigned ${team.name} / ${a.vertical}`)
        if (!inGuild) return { inGuild: false, roles: [] as string[] }
    }
    return { inGuild: true, roles: names }
}
 
/**
 * Call AFTER the team_users row has been deleted
 * Works from the user's remaining rows:
 *   - team/vertical role: always removed (it belongs to exactly this assignment)
 *   - team role: removed only if the user has no other assignment on that team
 *   - vertical role: removed only if the user has no other assignment in that vertical
 */
export async function revokeAssignmentRoles(env: Env, a: Assignment) {
    const { db, user, team } = await loadContext(env, a)
    const remaining = await db.select().from(teamUsers).where(eq(teamUsers.userId, a.userId)).all()
 
    const names = [roleNames.teamVertical(team.name, a.vertical)]
    if (!remaining.some((r) => r.teamId === a.teamId)) names.push(roleNames.team(team.name))
    if (!remaining.some((r) => r.vertical === a.vertical)) names.push(roleNames.vertical(a.vertical))
 
    if (!user.discordId) return { inGuild: false, roles: [] as string[] }
 
    for (const name of names) {
        const inGuild = await revokeRoleByName(env, user.discordId, name, `Unassigned ${team.name} / ${a.vertical}`)
        if (!inGuild) return { inGuild: false, roles: [] as string[] }
    }
    return { inGuild: true, roles: names }
}


/**
 * Reaction entry point.
 * Call it AFTER the DB change, passing only which assignment changed.
 * It reads the current DB state to decide whether to grant or revoke.
 */
export async function syncAssignment(env: Env, a: Assignment) {
    const row = await drizzle(env.DB)
        .select()
        .from(teamUsers)
        .where(
            and(
                eq(teamUsers.userId, a.userId),
                eq(teamUsers.teamId, a.teamId),
                eq(teamUsers.vertical, a.vertical),
            ),
        )
        .get()

    return row
        ? { action: 'granted' as const, ...(await grantAssignmentRoles(env, a)) }
        : { action: 'revoked' as const, ...(await revokeAssignmentRoles(env, a)) }
}