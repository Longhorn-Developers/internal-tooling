import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import { users } from '../db/schema'

export interface Env {
    DB: D1Database
    DISCORD_TOKEN: string // wrangler secret put DISCORD_TOKEN
    GUILD_ID: string // wrangler.toml [vars]
}

// ============================================================
// Low-level Discord REST helpers
// ============================================================

const API = 'https://discord.com/api/v10'
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

async function discord(
    env: Env,
    method: string,
    path: string,
    retry = true,
    body?: any,
): Promise<void> {
    const headers: Record<string, string> = {
        Authorization: `Bot ${env.DISCORD_TOKEN}`,
    }

    const res = await fetch(`${API}${path}`, { method, headers })
    if (!res.ok) {
        if (res.status === 429 && retry) {
            const { retry_after } = (await res.json()) as { retry_after: number }
            await new Promise((r) => setTimeout(r, Math.ceil(retry_after * 1000)))
            return discord(env, method, path, false, body)
        }

        const err = (await res.json().catch(() => ({}))) as { code?: number; message?: string }

        throw new DiscordError(
            res.status,
            err.code,
            err.message ?? `Discord returned ${res.status}`,
        )
    }
}

export const addRole = async (env: Env, discordId: string, roleId: string) => {
    discord(env, 'PUT', `/guilds/${env.GUILD_ID}/members/${discordId}/roles/${roleId}`)
}

export const removeRole = async (env: Env, discordId: string, roleId: string) => {
    discord(env, 'DELETE', `/guilds/${env.GUILD_ID}/members/${discordId}/roles/${roleId}`)
}

export const kickMember = async (env: Env, discordId: string) => {
    discord(env, 'DELETE', `/guilds/${env.GUILD_ID}/members/${discordId}`)
}

async function getDiscordId(env: Env, userId: string) {
    const [user] = await drizzle(env.DB).select().from(users).where(eq(users.id, userId))
    if (!user) {
        throw new Error(`User ${userId} not found`)
    }
    return user.discordId
}

/* 
  Todo:
    - Access roles without using id/without having to store the role's id in the db
    - Allow users to be in multiple teams
      - Create user to team table?
    - Add the job field for the user
      - Allow users to have multiple jobs in the team
        - Create user to job table?
      - Add job/team intersection role functionality
    - Have a way to create a role if the job/role intersection doesn't exist in the discord
*/
