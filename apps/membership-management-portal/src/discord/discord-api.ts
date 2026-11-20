import { DiscordAPIError, HTTPError, REST } from '@discordjs/rest'
import {
    ChannelType,
    PermissionFlagsBits,
    RESTJSONErrorCodes,
    Routes,
    ThreadAutoArchiveDuration,
} from 'discord-api-types/v10'
import type {
    APIApplication,
    APIGuild,
    APIGuildChannel,
    APIGuildMember,
    APIGuildOnboarding,
    APIMessage,
    APIRole,
    APIThreadChannel,
    APIThreadList,
    APIThreadMember,
    RESTPostAPIGuildChannelJSONBody,
    RESTPostAPIChannelMessageJSONBody,
    RESTGetAPIChannelThreadsArchivedPrivateResult,
    RESTPutAPIGuildOnboardingJSONBody,
} from 'discord-api-types/v10'
import { ServiceError } from '../service'
import Env = Cloudflare.Env

export const SERVICE = 'discord'

/**
 * Every permission the bot uses, and why. The bot is installed with exactly these
 * (see `installUrl`); `DiscordService` checks it still has all of them before it changes anything.
 */
export const DISCORD_PERMISSIONS_REQUIRED =
    PermissionFlagsBits.ManageRoles | // create team/shared roles, assign and remove them
    PermissionFlagsBits.ManageChannels | // create the category and team channels, move and delete them
    PermissionFlagsBits.ManageGuild | // edit onboarding ("which projects do you want to follow?")
    PermissionFlagsBits.ManageThreads | // see, unarchive and add/remove members of the private leads threads
    PermissionFlagsBits.CreatePrivateThreads | // create the leads threads
    PermissionFlagsBits.ViewChannel | // see the channels it manages
    PermissionFlagsBits.ReadMessageHistory | // list archived threads
    PermissionFlagsBits.SendMessages | // welcome messages
    PermissionFlagsBits.SendMessagesInThreads | // add members to a thread
    PermissionFlagsBits.EmbedLinks // welcome embeds

export const installUrl = (env: Pick<Env, 'DISCORD_APP_ID'>) =>
    `https://discord.com/oauth2/authorize?client_id=${env.DISCORD_APP_ID}` +
    `&permissions=${DISCORD_PERMISSIONS_REQUIRED}&integration_type=0&scope=bot`

/** Names of the permissions in `mask`, for error messages. */
export const permissionNames = (mask: bigint) =>
    Object.entries(PermissionFlagsBits)
        .filter(([, bit]) => (mask & bit) !== 0n)
        .map(([name]) => name)

export type Channel = APIGuildChannel
export type Thread = APIThreadChannel
export type Role = APIRole
export type Member = APIGuildMember & { user: NonNullable<APIGuildMember['user']> }

const isCode = (e: unknown, code: RESTJSONErrorCodes) =>
    e instanceof ServiceError && e.code === `DISCORD_${code}`

/**
 * Typed wrapper over `@discordjs/rest`: one method per thing the service needs, nothing about teams
 * or roles. Requests are stateless (the bot token is sent on each one; there's no login or session),
 * so there's no auth to cache. Failures throw ServiceError.
 */
export class DiscordApi {
    private tokenRejected = false
    private readonly rest: REST

    // One per RPC, like the service that owns it. REST retries 429s and 5xxs and queues around rate
    // limits on its own; the sweep intervals are off so it starts no background timers.
    constructor(private readonly env: Env) {
        this.rest = new REST({
            version: '10',
            userAgentAppendix: 'lhd-membership-worker',
            hashSweepInterval: 0,
            handlerSweepInterval: 0,
        }).setToken(env.DISCORD_TOKEN)
    }

    get guildId() {
        return this.env.DISCORD_GUILD_ID
    }

    /** The bot's user id; for a bot, the application id and the user id are the same. */
    get botId() {
        return this.env.DISCORD_APP_ID
    }

    /** One request, with anything it throws turned into a ServiceError. */
    private async request<T = void>(
        method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
        route: `/${string}`,
        { body, reason, query }: { body?: unknown; reason?: string; query?: Record<string, string> } = {},
    ): Promise<T> {
        // Repeated 401s count against the IP's invalid-request limit, so stop after the first
        if (this.tokenRejected) {
            throw new ServiceError(
                SERVICE,
                'DISCORD_UNAUTHORIZED',
                false,
                'The bot token was rejected',
            )
        }
        try {
            const result = await this.rest[method.toLowerCase() as Lowercase<typeof method>](
                route,
                {
                    body,
                    reason,
                    query: query ? new URLSearchParams(query) : undefined,
                },
            )
            return result as T
        } catch (e) {
            if (e instanceof DiscordAPIError) {
                if (e.status === 401) this.tokenRejected = true
                throw new ServiceError(
                    SERVICE,
                    e.code ? `DISCORD_${e.code}` : `DISCORD_HTTP_${e.status}`,
                    e.status === 429 || e.status >= 500, // retrying can work without changing anything
                    e.message,
                )
            }
            if (e instanceof HTTPError) {
                if (e.status === 401) this.tokenRejected = true
                throw new ServiceError(
                    SERVICE,
                    `DISCORD_HTTP_${e.status}`,
                    e.status >= 500,
                    e.message,
                )
            }
            throw new ServiceError(
                SERVICE,
                'DISCORD_NETWORK',
                true,
                e instanceof Error ? e.message : String(e),
            )
        }
    }

    /** Runs `fn`; resolves `fallback` instead if it fails with one of `codes`. */
    private async unless<T, F>(codes: RESTJSONErrorCodes[], fallback: F, fn: () => Promise<T>) {
        try {
            return await fn()
        } catch (e) {
            if (codes.some((code) => isCode(e, code))) return fallback
            throw e
        }
    }

    // ---------- Members ----------

    /**
     * The member with this Discord username, or null if there isn't one in the server. Search matches
     * username or nickname prefixes, so this picks the exact username out of the results. It
     * doesn't need the privileged Server Members intent.
     */
    async findMember(username: string): Promise<Member | null> {
        const wanted = username.trim().toLowerCase()
        if (!wanted) return null

        const search = (limit: number) =>
            this.request<APIGuildMember[]>('GET', Routes.guildMembersSearch(this.guildId), {
                query: { query: wanted, limit: String(limit) },
            })
        const exact = (members: APIGuildMember[]) =>
            members.find(
                (m): m is Member => !m.user?.bot && m.user?.username.toLowerCase() === wanted,
            ) ?? null

        const page = await search(100)
        // A full page means more members share the prefix, so the exact one could be past it
        return exact(page) ?? (page.length === 100 ? exact(await search(1000)) : null)
    }

    /** A member by user id, or null if they aren't in the server. */
    member(userId: string): Promise<APIGuildMember | null> {
        return this.unless(
            [RESTJSONErrorCodes.UnknownMember, RESTJSONErrorCodes.UnknownUser],
            null,
            () => this.request<APIGuildMember>('GET', Routes.guildMember(this.guildId, userId)),
        )
    }

    application(): Promise<APIApplication> {
        return this.request('GET', '/applications/@me')
    }

    /** These return false if the user isn't in the server (so there's nothing to do), true otherwise. */
    addRole(userId: string, roleId: string, reason?: string): Promise<boolean> {
        return this.unless([RESTJSONErrorCodes.UnknownMember], false, async () => {
            await this.request('PUT', Routes.guildMemberRole(this.guildId, userId, roleId), {
                reason,
            })
            return true
        })
    }

    removeRole(userId: string, roleId: string, reason?: string): Promise<boolean> {
        return this.unless([RESTJSONErrorCodes.UnknownMember], false, async () => {
            await this.request('DELETE', Routes.guildMemberRole(this.guildId, userId, roleId), {
                reason,
            })
            return true
        })
    }

    // ---------- Roles ----------

    guild(): Promise<APIGuild> {
        return this.request('GET', Routes.guild(this.guildId))
    }

    createRole(name: string, reason?: string): Promise<Role> {
        return this.request('POST', Routes.guildRoles(this.guildId), {
            body: { name, permissions: '0', mentionable: false },
            reason,
        })
    }

    deleteRole(roleId: string, reason?: string) {
        return this.unless([RESTJSONErrorCodes.UnknownRole], undefined, () =>
            this.request('DELETE', Routes.guildRole(this.guildId, roleId), { reason }),
        )
    }

    // ---------- Channels ----------

    channels(): Promise<Channel[]> {
        return this.request('GET', Routes.guildChannels(this.guildId))
    }

    createChannel(body: RESTPostAPIGuildChannelJSONBody, reason?: string): Promise<Channel> {
        // a guild channel, since that's what POST /guilds/{id}/channels makes
        return this.request<Channel>('POST', Routes.guildChannels(this.guildId), { body, reason })
    }

    /** Moves a channel into a category and syncs its permissions with it. */
    moveChannel(channelId: string, parentId: string, reason?: string) {
        return this.request('PATCH', Routes.guildChannels(this.guildId), {
            body: [{ id: channelId, parent_id: parentId, lock_permissions: true }],
            reason,
        })
    }

    deleteChannel(channelId: string, reason?: string) {
        return this.unless([RESTJSONErrorCodes.UnknownChannel], undefined, () =>
            this.request('DELETE', Routes.channel(channelId), { reason }),
        )
    }

    sendMessage(channelId: string, body: RESTPostAPIChannelMessageJSONBody): Promise<APIMessage> {
        return this.request('POST', Routes.channelMessages(channelId), { body })
    }

    // ---------- Threads ----------

    /** Every active thread in the server, public and private. */
    async activeThreads(): Promise<Thread[]> {
        const { threads } = await this.request<APIThreadList>(
            'GET',
            Routes.guildActiveThreads(this.guildId),
        )
        return threads as Thread[]
    }

    /** All archived private threads, including older pages. */
    async archivedPrivateThreads(channelId: string): Promise<Thread[]> {
        const all: Thread[] = []
        let before: string | undefined
        for (;;) {
            const page = await this.request<RESTGetAPIChannelThreadsArchivedPrivateResult>(
                'GET',
                Routes.channelThreads(channelId, 'private'),
                {
                    query: { limit: '100', ...(before && { before }) },
                },
            )
            all.push(...(page.threads as Thread[]))
            if (!page.has_more) return all
            const cursor = (page.threads.at(-1) as Thread | undefined)?.thread_metadata
                ?.archive_timestamp
            if (!cursor || cursor === before)
                throw new ServiceError(
                    SERVICE,
                    'INCOMPLETE_THREADS',
                    true,
                    'Archived thread pagination stalled',
                )
            before = cursor
        }
    }

    /** Creates a private thread only moderators can add people to. */
    createPrivateThread(channelId: string, name: string, reason?: string): Promise<Thread> {
        return this.request('POST', Routes.threads(channelId), {
            body: {
                name,
                type: ChannelType.PrivateThread,
                invitable: false,
                auto_archive_duration: ThreadAutoArchiveDuration.OneWeek,
            },
            reason,
        })
    }

    unarchiveThread(threadId: string, reason?: string) {
        return this.request('PATCH', Routes.channel(threadId), {
            body: { archived: false },
            reason,
        })
    }

    secureThread(threadId: string) {
        return this.request('PATCH', Routes.channel(threadId), {
            body: { invitable: false },
            reason: 'Only moderators may invite leads',
        })
    }

    async threadMemberIds(threadId: string): Promise<Set<string>> {
        const ids = new Set<string>()
        let after: string | undefined
        for (;;) {
            const page = await this.request<APIThreadMember[]>(
                'GET',
                Routes.threadMembers(threadId),
                {
                    query: { with_member: 'true', limit: '100', ...(after && { after }) },
                },
            )
            for (const m of page) if (m.user_id) ids.add(m.user_id)
            if (page.length < 100) return ids
            const cursor = page.at(-1)?.user_id
            if (!cursor || cursor === after)
                throw new ServiceError(
                    SERVICE,
                    'INCOMPLETE_MEMBERS',
                    true,
                    'Thread-member pagination stalled',
                )
            after = cursor
        }
    }

    /** Both return false if the user isn't in the server. */
    addThreadMember(threadId: string, userId: string): Promise<boolean> {
        return this.unless(
            [RESTJSONErrorCodes.UnknownMember, RESTJSONErrorCodes.UnknownUser],
            false,
            async () => {
                await this.request('PUT', Routes.threadMembers(threadId, userId))
                return true
            },
        )
    }

    removeThreadMember(threadId: string, userId: string): Promise<boolean> {
        return this.unless(
            [RESTJSONErrorCodes.UnknownMember, RESTJSONErrorCodes.UnknownUser],
            false,
            async () => {
                await this.request('DELETE', Routes.threadMembers(threadId, userId))
                return true
            },
        )
    }

    // ---------- Onboarding ----------

    onboarding(): Promise<APIGuildOnboarding> {
        return this.request('GET', Routes.guildOnboarding(this.guildId))
    }

    /** Replaces the whole prompt list; send back every prompt you want to keep. */
    putOnboarding(body: RESTPutAPIGuildOnboardingJSONBody, reason?: string) {
        return this.request<APIGuildOnboarding>('PUT', Routes.guildOnboarding(this.guildId), {
            body,
            reason,
        })
    }
}
