import { ApplicationFlags, ChannelType, PermissionFlagsBits } from 'discord-api-types/v10'
import type {
    APIGuildOnboarding,
    APIGuildOnboardingPrompt,
    RESTAPIGuildOnboardingPrompt,
} from 'discord-api-types/v10'
import type { MembershipState, Team, TeamUser, User } from '../db/access'
import type { Vertical } from '../db/schema'
import { Service, ServiceError, execRoles } from '../service'
import type {
    ExecRole,
    FailedChange,
    FixServiceResult,
    NeededChange,
    ServiceResult,
} from '../service'
import {
    DISCORD_PERMISSIONS_REQUIRED,
    DiscordApi,
    SERVICE,
    installUrl,
    permissionNames,
} from './discord-api'
import type { Channel, Role, Thread } from './discord-api'
import {
    MEMBER_ROLE,
    LEAD_ROLE,
    EXEC_BOARD_ROLE,
    norm,
    verticalLabel,
    execLeadVertical,
    roleNames,
    teamRoleNames,
    rankRoleNames,
    managedNames,
    hasEnded,
    isLeadOf,
    wantedNames,
    withAssignment,
    groupRows,
    execWanted,
    execKeep,
    teamScopeWanted,
    fullWanted,
} from './discord-roles'
import type { Wanted } from './discord-roles'

// ============================================================
// Naming
// Roles are found by name (case-insensitive) so D1 doesn't have to store role ids. A team's
// channel is named by its team slug. Change these to change the server's conventions.
// ============================================================

const CATEGORY_NAME = 'Project Channels' // every team channel lives here
const LEADS_THREAD = 'Leads' // private thread in each team channel, only for the team's leads
const ONBOARDING_PROMPT = 'Which projects do you want to follow?' // the onboarding question this service manages

const WELCOME_COLOR = 0xbf5700 // burnt orange

// ============================================================
// Changes. `manual` ones need a person; `blocking` ones are entities an action can't run without.
// ============================================================

const kinds = {
    // the bot or its setup
    missing_permissions: { blocking: true, manual: true },
    bot_not_in_guild: { blocking: true, manual: true },
    role_above_bot: { blocking: true, manual: true },
    onboarding_unavailable: { blocking: true, manual: true },
    setup_conflict: { blocking: true, manual: true },
    members_intent_required: { blocking: true, manual: true },
    // a user's account
    user_not_in_guild: { blocking: true, manual: true },
    user_missing_discord_id: { blocking: true, manual: true },
    // entities
    create_role: { blocking: true },
    create_category: { blocking: true },
    create_team_channel: { blocking: true },
    create_leads_thread: { blocking: true },
    secure_leads_thread: { blocking: true },
    move_channel: {},
    set_onboarding_option: {},
    remove_onboarding_option: {},
    delete_channel: {}, // never done unless a person passes it to autoFix
    // memberships
    add_role: {},
    remove_role: {},
    add_leads_member: {},
    remove_leads_member: {},
} satisfies Record<string, { blocking?: true; manual?: true }>
type Kind = keyof typeof kinds

// Order autoFix makes changes in: things before what depends on them, deletions last.
const fixOrder: Kind[] = [
    'create_role',
    'create_category',
    'create_team_channel',
    'create_leads_thread',
    'secure_leads_thread',
    'move_channel',
    'add_role',
    'remove_role',
    'add_leads_member',
    'remove_leads_member',
    'set_onboarding_option',
    'remove_onboarding_option',
    'delete_channel',
]

const infoOf = (kind: string): { blocking?: true; manual?: true } | undefined =>
    Object.hasOwn(kinds, kind) ? (kinds as Record<string, {}>)[kind] : undefined

type Ids = { teamId?: string; userId?: string }

function change(kind: Kind, target: string, reason: string, ids: Ids = {}): NeededChange {
    const info: { blocking?: true; manual?: true } = kinds[kind]
    return {
        service: SERVICE,
        kind,
        target,
        reason,
        ...ids,
        fixable: !info.manual,
        blocking: !!info.blocking,
    }
}

function dedupe(changes: NeededChange[]): NeededChange[] {
    const seen = new Set<string>()
    return changes.filter((c) => {
        const key = [c.kind, norm(c.target), c.userId ?? '', c.teamId ?? ''].join('|')
        if (seen.has(key)) return false
        seen.add(key)
        return true
    })
}

/** The action ran (or had nothing to do). Non-blocking changes are things it noticed. */
const ok = (changes: NeededChange[] = []): ServiceResult => ({
    changes: dedupe(changes),
    failed: false,
})
/** The action did not run: something it needs is missing, and nothing was changed. */
const blocked = (changes: NeededChange[]): ServiceResult => ({
    changes: dedupe(changes),
    failed: true,
})
const isBlocked = (changes: NeededChange[]) => changes.some((c) => c.blocking)

const roleMissing = (name: string) =>
    new ServiceError(SERVICE, 'ROLE_MISSING', false, `Role "${name}" does not exist`)
const notInGuildError = (discordId: string) =>
    new ServiceError(SERVICE, 'USER_NOT_IN_GUILD', false, `${discordId} hasn't joined the server`)

// ============================================================
// A snapshot of the server, loaded fresh at the start of every operation so something someone
// just created by hand is seen immediately.
// ============================================================

class RoleBook {
    private roles = new Map<string, Role>()
    add(role: Role) {
        this.roles.set(role.id, role)
    }
    remove(role: Role) {
        this.roles.delete(role.id)
    }
    get(id: string) {
        return this.roles.get(id)
    }
    nameOf(id: string) {
        return this.get(id)?.name
    }
    get size() {
        return this.roles.size
    }
    private named(name: string) {
        return [...this.roles.values()].filter((r) => !r.managed && norm(r.name) === norm(name))
    }
    find(name: string) {
        return this.named(name)[0]
    }
    ambiguous(name: string) {
        return this.named(name).length > 1
    }
}

type LeadsThread = { thread: Thread; archived: boolean }

class Guild {
    private activeThreads?: Thread[]
    private archivedThreads = new Map<string, Thread[]>()
    private members = new Map<string, Promise<Set<string>>>()

    constructor(
        readonly api: DiscordApi,
        readonly book: RoleBook,
        readonly channels: Channel[],
        readonly problems: NeededChange[] = [],
        readonly features: string[] = [],
    ) {}

    static async load(api: DiscordApi): Promise<Guild> {
        const book = new RoleBook()
        try {
            const [guild, channels] = await Promise.all([api.guild(), api.channels()])
            for (const role of guild.roles) book.add(role)
            return new Guild(api, book, channels, [], guild.features)
        } catch (e) {
            if (
                !(e instanceof ServiceError) ||
                ![
                    'DISCORD_10004',
                    'DISCORD_50001',
                    'DISCORD_50013',
                    'DISCORD_50014',
                    'DISCORD_HTTP_401',
                    'DISCORD_HTTP_403',
                ].includes(e.code)
            )
                throw e
            return new Guild(
                api,
                book,
                [],
                [
                    change(
                        'missing_permissions',
                        api.guildId,
                        `The bot cannot read the server setup (${e.message}). Verify DISCORD_TOKEN, DISCORD_APP_ID and DISCORD_GUILD_ID, then install/re-authorize it: ${installUrl({ DISCORD_APP_ID: api.botId })}`,
                    ),
                ],
            )
        }
    }

    category(): Channel | undefined {
        return this.channels.find(
            (c) => c.type === ChannelType.GuildCategory && norm(c.name) === norm(CATEGORY_NAME),
        )
    }

    channelOf(slug: string): Channel | undefined {
        return this.channels.find((c) => c.type === ChannelType.GuildText && c.name === slug)
    }

    /** The team channels this service owns: text channels in the category. */
    categoryChannels(): Channel[] {
        const category = this.category()
        return category
            ? this.channels.filter(
                  (c) => c.type === ChannelType.GuildText && c.parent_id === category.id,
              )
            : []
    }

    /** The team's private leads thread, active or archived. */
    async leadsThread(slug: string): Promise<LeadsThread | undefined> {
        const channel = this.channelOf(slug)
        if (!channel) return undefined
        const find = (list: Thread[]) => {
            const matches = list.filter(
                (t) => t.parent_id === channel.id && t.name === LEADS_THREAD,
            )
            if (matches.length > 1 || matches.some((t) => t.type !== ChannelType.PrivateThread)) {
                throw new ServiceError(
                    SERVICE,
                    'THREAD_CONFLICT',
                    false,
                    `#${slug} has duplicate or public leads threads. Resolve them manually; the managed leads thread must be private.`,
                )
            }
            return matches[0]
        }

        this.activeThreads ??= await this.api.activeThreads()
        const active = find(this.activeThreads)
        if (active) return { thread: active, archived: false }

        let archived = this.archivedThreads.get(channel.id)
        if (!archived) {
            archived = await this.api.archivedPrivateThreads(channel.id)
            this.archivedThreads.set(channel.id, archived)
        }
        const found = find(archived)
        return found && { thread: found, archived: true }
    }

    addThread(thread: Thread) {
        this.activeThreads?.push(thread)
    }

    memberIds(threadId: string) {
        let members = this.members.get(threadId)
        if (!members) this.members.set(threadId, (members = this.api.threadMemberIds(threadId)))
        return members
    }

    async activeThreadCount() {
        this.activeThreads ??= await this.api.activeThreads()
        return this.activeThreads.length
    }
}

// ============================================================
// What the bot needs to be able to do
// ============================================================

/**
 * Whether the bot is in the server with every permission in DISCORD_PERMISSIONS_REQUIRED, and
 * (for the roles an action touches) whether those roles sit below the bot's own. Every problem here
 * needs a person, and comes back with the link that fixes it.
 */
async function checkBot(
    g: Guild,
    env: Cloudflare.Env,
    roleNamesTouched: string[],
    slugs: string[],
): Promise<NeededChange[]> {
    if (g.problems.length) return g.problems
    const url = installUrl(env)
    const bot = await g.api.member(g.api.botId)
    if (!bot) {
        return [
            change('bot_not_in_guild', g.api.botId, `The bot isn't in the server. Add it: ${url}`),
        ]
    }

    let permissions = BigInt(g.book.get(g.api.guildId)?.permissions ?? 0) // @everyone's role id is the guild id
    let top = 0
    for (const id of bot.roles) {
        const role = g.book.get(id)
        if (!role) continue
        permissions |= BigInt(role.permissions)
        top = Math.max(top, role.position)
    }

    if ((permissions & PermissionFlagsBits.Administrator) === 0n) {
        const missing = DISCORD_PERMISSIONS_REQUIRED & ~permissions
        if (missing) {
            const names = permissionNames(missing).join(', ')
            return [
                change(
                    'missing_permissions',
                    names,
                    `The bot is missing permissions: ${names}. Re-authorize it with the full set: ${url}`,
                ),
            ]
        }
    }

    const problems = roleNamesTouched.flatMap((name) => {
        const role = g.book.find(name)
        return role && role.position >= top
            ? [
                  change(
                      'role_above_bot',
                      role.name,
                      `Role "${role.name}" is at or above the bot's highest role, so the bot can't manage it. Drag the bot's role above it in Server Settings > Roles. Installation: ${url}`,
                  ),
              ]
            : []
    })

    // Guild permissions alone don't account for category/channel overwrites.
    // Inspect the project category and each modeled channel before any mutation.
    const category = g.category()
    for (const channel of g.channels.filter(
        (c) =>
            c.id === category?.id ||
            (category && c.parent_id === category.id) ||
            slugs.includes(c.name),
    )) {
        const effective = channelPermissions(permissions, channel, bot.roles, g.api)
        const missing = DISCORD_PERMISSIONS_REQUIRED & CHANNEL_PERMISSIONS & ~effective
        if (missing)
            problems.push(
                change(
                    'missing_permissions',
                    channel.id,
                    `The bot lacks ${permissionNames(missing).join(', ')} in "${channel.name}". Fix its category/channel overwrites. Re-authorize if needed: ${url}`,
                ),
            )
    }
    return problems
}

const CHANNEL_PERMISSIONS =
    PermissionFlagsBits.ViewChannel |
    PermissionFlagsBits.ManageChannels |
    PermissionFlagsBits.ManageRoles |
    PermissionFlagsBits.ManageThreads |
    PermissionFlagsBits.CreatePrivateThreads |
    PermissionFlagsBits.SendMessages |
    PermissionFlagsBits.SendMessagesInThreads |
    PermissionFlagsBits.ReadMessageHistory |
    PermissionFlagsBits.EmbedLinks

function channelPermissions(
    base: bigint,
    channel: Channel,
    roles: string[],
    api: DiscordApi,
): bigint {
    if (base & PermissionFlagsBits.Administrator) return ~0n
    const overwrites = channel.permission_overwrites ?? []
    const apply = (allow: bigint, deny: bigint) => {
        base = (base & ~deny) | allow
    }
    const everyone = overwrites.find((o) => o.id === api.guildId)
    if (everyone) apply(BigInt(everyone.allow), BigInt(everyone.deny))
    let allow = 0n,
        deny = 0n
    for (const o of overwrites.filter((o) => o.type === 0 && roles.includes(o.id))) {
        allow |= BigInt(o.allow)
        deny |= BigInt(o.deny)
    }
    apply(allow, deny)
    const member = overwrites.find((o) => o.type === 1 && o.id === api.botId)
    if (member) apply(BigInt(member.allow), BigInt(member.deny))
    return base
}

// ============================================================
// Working out which roles someone should have
// ============================================================

/** The roles in `names` that don't exist in the server yet, as (blocking) changes to make. */
const missingRoleChanges = (book: RoleBook, names: string[], teamId?: string): NeededChange[] =>
    names
        .filter((n) => !book.find(n))
        .map((n) => change('create_role', n, `Role "${n}" doesn't exist`, { teamId }))

/** Where a member's roles differ from `wanted`, as changes. Missing roles come with the change that creates them. */
function diffChanges(book: RoleBook, held: Set<string>, wanted: Wanted, ctx: Ids): NeededChange[] {
    const out: NeededChange[] = []
    for (const [name, shouldHave] of wanted) {
        const role = book.find(name)
        if (shouldHave) {
            if (!role) out.push(...missingRoleChanges(book, [name], ctx.teamId))
            if (!role || !held.has(role.id)) {
                out.push(change('add_role', name, `Should have role "${name}"`, ctx))
            }
        } else if (role && held.has(role.id)) {
            out.push(change('remove_role', name, `Should not have role "${name}"`, ctx))
        }
    }
    return out
}

// ============================================================
// Channels, leads threads and onboarding
// ============================================================

async function ensureCategory(g: Guild): Promise<Channel> {
    const existing = g.category()
    if (existing) return existing
    const created = await g.api.createChannel(
        { name: CATEGORY_NAME, type: ChannelType.GuildCategory },
        'Created by the team service',
    )
    g.channels.push(created)
    return created
}

/** Created with no overwrites of its own, so it stays synced to the category's (standard Discord) permissions. */
async function ensureChannel(g: Guild, team: Team): Promise<Channel> {
    const existing = g.channelOf(team.teamSlug)
    if (existing) return existing
    const category = await ensureCategory(g)
    const created = await g.api.createChannel(
        {
            name: team.teamSlug,
            type: ChannelType.GuildText,
            parent_id: category.id,
            topic: `${team.name}'s project channel`,
        },
        `Team channel for ${team.name}`,
    )
    g.channels.push(created)
    return created
}

async function ensureThread(g: Guild, team: Team): Promise<LeadsThread> {
    const existing = await g.leadsThread(team.teamSlug)
    if (existing) return existing
    const channel = g.channelOf(team.teamSlug)
    if (!channel) {
        throw new ServiceError(
            SERVICE,
            'CHANNEL_MISSING',
            false,
            `#${team.teamSlug} does not exist`,
        )
    }
    const thread = await g.api.createPrivateThread(
        channel.id,
        LEADS_THREAD,
        `Leads thread for ${team.name}`,
    )
    g.addThread(thread)
    return { thread, archived: false }
}

/** Puts a lead in (or takes them out of) the team's leads thread. Removing does nothing if there's no thread. */
async function setLeadsMember(g: Guild, team: Team, discordId: string, shouldBeIn: boolean) {
    const found = await g.leadsThread(team.teamSlug)
    if (!found) {
        if (shouldBeIn)
            throw new ServiceError(
                SERVICE,
                'THREAD_MISSING',
                false,
                `#${team.teamSlug} has no leads thread`,
            )
        return
    }

    const members = await g.memberIds(found.thread.id)
    if (members.has(discordId) === shouldBeIn) return
    if (found.archived) {
        await g.api.unarchiveThread(found.thread.id, 'Updating leads')
        found.archived = false
    }
    const done = shouldBeIn
        ? await g.api.addThreadMember(found.thread.id, discordId)
        : await g.api.removeThreadMember(found.thread.id, discordId)
    if (shouldBeIn && !done) throw notInGuildError(discordId)
    if (shouldBeIn) members.add(discordId)
    else members.delete(discordId)
}

/** The team's channel, category, leads thread and role entities, as changes to make. */
async function entityChanges(
    g: Guild,
    team: Team,
    opts: { thread: boolean },
): Promise<NeededChange[]> {
    const ids = { teamId: team.id }
    const changes = missingRoleChanges(g.book, teamRoleNames(team), team.id)
    const category = g.category()
    if (!category)
        changes.push(
            change(
                'create_category',
                CATEGORY_NAME,
                `Category "${CATEGORY_NAME}" doesn't exist`,
                ids,
            ),
        )

    const channel = g.channelOf(team.teamSlug)
    if (!channel) {
        changes.push(
            change(
                'create_team_channel',
                team.teamSlug,
                `Channel #${team.teamSlug} doesn't exist`,
                ids,
            ),
        )
    } else if (category && channel.parent_id !== category.id) {
        changes.push(
            change(
                'move_channel',
                team.teamSlug,
                `#${team.teamSlug} should be in "${CATEGORY_NAME}"`,
                ids,
            ),
        )
    }
    if (opts.thread && !(await g.leadsThread(team.teamSlug))) {
        changes.push(
            change(
                'create_leads_thread',
                team.teamSlug,
                `#${team.teamSlug} has no private "${LEADS_THREAD}" thread`,
                ids,
            ),
        )
    }
    const found = await g.leadsThread(team.teamSlug)
    if (found && found.thread.thread_metadata?.invitable !== false) {
        changes.push(
            change(
                'secure_leads_thread',
                team.teamSlug,
                `Disable member invitations in #${team.teamSlug}'s private leads thread`,
                ids,
            ),
        )
    }
    return changes
}

const optionTitle = (team: Pick<Team, 'name'>) => team.name.slice(0, 50)
const managedPrompt = (o: APIGuildOnboarding) =>
    o.prompts.find((p) => p.title === ONBOARDING_PROMPT)

/** Validate names and Discord's hard entity limits before provisioning starts. */
function identityChanges(g: Guild, teams: Team[]): NeededChange[] {
    const out: NeededChange[] = []
    const problem = (target: string, reason: string) =>
        out.push(change('setup_conflict', target, reason))
    const roleOwners = new Map<string, string>()
    for (const name of [
        '@everyone',
        MEMBER_ROLE,
        EXEC_BOARD_ROLE,
        ...execRoles,
        ...rankRoleNames(),
    ])
        roleOwners.set(norm(name), 'shared roles')
    for (const team of teams) {
        if (team.teamSlug.length > 100 || !team.teamSlug)
            problem(team.id, 'Team slug must contain 1–100 characters')
        for (const name of teamRoleNames(team)) {
            const owner = roleOwners.get(norm(name))
            if (owner)
                problem(
                    name,
                    `Discord role "${name}" collides between ${owner} and ${team.name}. Rename the team; role names are limited to 100 characters.`,
                )
            roleOwners.set(norm(name), team.name)
        }
    }
    for (const name of roleOwners.keys()) {
        if (g.book.ambiguous(name))
            problem(
                name,
                `Multiple Discord roles named "${name}" exist. Rename the duplicates before managing access.`,
            )
    }
    const titles = teams.map(optionTitle)
    if (new Set(titles).size !== titles.length)
        problem(
            ONBOARDING_PROMPT,
            'Team names collide after the 50-character onboarding option limit. Rename them.',
        )
    if (
        g.channels.filter(
            (c) => c.type === ChannelType.GuildCategory && norm(c.name) === norm(CATEGORY_NAME),
        ).length > 1
    ) {
        problem(
            CATEGORY_NAME,
            'Multiple Project Channels categories exist. Rename the extra categories.',
        )
    }
    for (const team of teams) {
        if (
            g.channels.filter((c) => c.type === ChannelType.GuildText && c.name === team.teamSlug)
                .length > 1
        ) {
            problem(
                team.teamSlug,
                'Multiple channels match this team slug. Resolve the ambiguity before provisioning.',
            )
        }
    }
    return out
}

async function setupChanges(
    g: Guild,
    teams: Team[],
    onboarding: APIGuildOnboarding,
    planned: {
        roles: string[]
        channels: string[]
        category: boolean
        options: string[]
        removeOptions?: string[]
        threads?: string[]
    },
): Promise<NeededChange[]> {
    const out = identityChanges(g, teams)
    const problem = (target: string, reason: string) =>
        out.push(change('setup_conflict', target, reason))
    const rolesToCreate = new Set(planned.roles.filter((n) => !g.book.find(n)).map(norm)).size
    if (g.book.size + rolesToCreate > 250)
        problem('roles', 'Discord role limit (250) would be exceeded. Free up roles manually.')
    const channelsToCreate = new Set(planned.channels.filter((slug) => !g.channelOf(slug))).size
    const category = g.category()
    if (g.channels.length + channelsToCreate + Number(planned.category && !category) > 500) {
        problem(
            'channels',
            'Discord channel limit (500) would be exceeded. Free up channels manually.',
        )
    }
    const movingIn = new Set(
        planned.channels.filter(
            (slug) => !category || g.channelOf(slug)?.parent_id !== category.id,
        ),
    ).size
    const children = category ? g.channels.filter((c) => c.parent_id === category.id).length : 0
    if (children + movingIn > 50)
        problem(
            CATEGORY_NAME,
            'Project Channels would exceed Discord’s 50-channel category limit. Reorganize the category manually.',
        )
    const prompt = managedPrompt(onboarding)
    const kept =
        prompt?.options
            .filter((o) => !planned.removeOptions?.includes(o.title))
            .map((o) => o.title) ?? []
    const optionCount = new Set([...kept, ...planned.options]).size
    if (optionCount > 50)
        problem(
            ONBOARDING_PROMPT,
            'The follow-projects question would exceed 50 options. Split the question manually.',
        )
    if (!prompt && planned.options.length && onboarding.prompts.length >= 15)
        problem(ONBOARDING_PROMPT, 'Discord’s 15 onboarding prompts are already in use.')
    let newThreads = 0
    for (const slug of new Set(planned.threads)) {
        if (!(await g.leadsThread(slug))) newThreads++
    }
    if (newThreads && (await g.activeThreadCount()) + newThreads > 1000) {
        problem(
            'threads',
            'Discord’s 1,000 active-thread limit would be exceeded. Archive unused threads manually.',
        )
    }
    return out
}

/** Onboarding, or the change explaining why it can't be edited. Retryable failures throw. */
async function loadOnboarding(g: Guild): Promise<APIGuildOnboarding | NeededChange> {
    if (!g.features.includes('COMMUNITY')) {
        return change(
            'onboarding_unavailable',
            'onboarding',
            `Enable Community in Server Settings before configuring project onboarding. Installation: ${installUrl({ DISCORD_APP_ID: g.api.botId })}`,
        )
    }
    try {
        const onboarding = await g.api.onboarding()
        if (onboarding.prompts.filter((p) => p.title === ONBOARDING_PROMPT).length > 1) {
            return change(
                'setup_conflict',
                ONBOARDING_PROMPT,
                'Multiple project-following questions exist. Rename the duplicate questions before syncing.',
            )
        }
        return onboarding
    } catch (e) {
        if (!(e instanceof ServiceError) || e.retryable) throw e
        return change(
            'onboarding_unavailable',
            'onboarding',
            `Server onboarding can't be edited (${e.message}). Enable Community and grant Manage Server/Manage Roles. Installation: ${installUrl({ DISCORD_APP_ID: g.api.botId })}`,
        )
    }
}

const onboardingProblem = (o: APIGuildOnboarding | NeededChange): o is NeededChange => 'kind' in o

/** The "follow a project" option for each team, and options for teams that no longer exist. */
function onboardingChanges(g: Guild, o: APIGuildOnboarding, teams: Team[]): NeededChange[] {
    const options = managedPrompt(o)?.options ?? []
    const changes: NeededChange[] = []
    for (const team of teams) {
        const channel = g.channelOf(team.teamSlug)
        const option = options.find((opt) => opt.title === optionTitle(team))
        if (
            !option ||
            option.role_ids.length ||
            (channel && (option.channel_ids.length !== 1 || option.channel_ids[0] !== channel.id))
        ) {
            changes.push(
                change(
                    'set_onboarding_option',
                    team.name,
                    `Onboarding "${ONBOARDING_PROMPT}" should offer ${team.name}`,
                    { teamId: team.id },
                ),
            )
        }
    }
    const titles = new Set(teams.map(optionTitle))
    for (const opt of options) {
        if (!titles.has(opt.title)) {
            changes.push(
                change(
                    'remove_onboarding_option',
                    opt.title,
                    `Onboarding option "${opt.title}" has no team`,
                ),
            )
        }
    }
    return changes
}

// Snowflake-shaped id for a prompt Discord hasn't seen yet
const newSnowflake = () => ((BigInt(Date.now()) - 1420070400000n) << 22n).toString()

const toRequestPrompt = (p: APIGuildOnboardingPrompt): RESTAPIGuildOnboardingPrompt => ({
    id: p.id,
    title: p.title,
    type: p.type,
    single_select: p.single_select,
    required: p.required,
    in_onboarding: p.in_onboarding,
    options: p.options.map((o) => ({
        id: o.id,
        title: o.title,
        description: o.description,
        channel_ids: o.channel_ids,
        role_ids: o.role_ids,
        emoji_id: o.emoji?.id ?? undefined,
        emoji_name: o.emoji?.name ?? undefined,
        emoji_animated: o.emoji?.animated ?? undefined,
    })),
})

/**
 * Adds/replaces the "follow" option for each team in `add` and drops options titled in `remove`, in
 * one read-modify-write (Discord replaces every prompt on a write). Other prompts are sent back as they were.
 */
async function applyOnboarding(g: Guild, add: Team[], remove: string[]) {
    const current = await g.api.onboarding()
    const prompts = current.prompts.map(toRequestPrompt)
    let ours = prompts.find((p) => p.title === ONBOARDING_PROMPT)
    if (!ours) {
        ours = {
            id: newSnowflake(),
            title: ONBOARDING_PROMPT,
            type: 0, // multiple choice
            single_select: false,
            required: false,
            in_onboarding: true,
            options: [],
        }
        prompts.push(ours)
    }

    ours.options = ours.options.filter((o) => !remove.includes(o.title))
    for (const team of add) {
        const channel = g.channelOf(team.teamSlug)
        if (!channel)
            throw new ServiceError(
                SERVICE,
                'CHANNEL_MISSING',
                false,
                `#${team.teamSlug} does not exist`,
            )
        const option = { title: optionTitle(team), channel_ids: [channel.id], role_ids: [] }
        const i = ours.options.findIndex((o) => o.title === option.title)
        if (i >= 0) ours.options[i] = { ...ours.options[i], ...option }
        else ours.options.push(option)
    }

    // A question needs at least one answer
    const next = ours.options.length ? prompts : prompts.filter((p) => p !== ours)
    if (JSON.stringify(next) === JSON.stringify(current.prompts.map(toRequestPrompt))) return
    await g.api.putOnboarding({ prompts: next }, 'Team projects changed')
}

// ============================================================
// The service
// ============================================================

/** A member of the server: their user id (not the username D1 stores) and the role ids they hold. */
type Reach = { memberId: string; held: Set<string> }
const isProblem = (r: Reach | NeededChange): r is NeededChange => 'kind' in r

export class DiscordService extends Service {
    readonly name = SERVICE

    private readonly api = new DiscordApi(this.env)
    private snapshot?: Promise<MembershipState>

    private state() {
        return (this.snapshot ??= this.db.getState())
    }

    private async teams() {
        return (await this.state()).teams
    }

    // ---------- D1 reads (through this.db; this class never writes) ----------

    /** All of one user's assignments, across every team (shared roles like Leads depend on all of them). */
    private async getRows(userId: string): Promise<TeamUser[]> {
        return (await this.state()).assignments.filter((a) => a.userId === userId)
    }

    // ---------- Reaching a member ----------

    /** Finds the member in the server by their Discord username, or says why they can't be reached. */
    private async reach(user: User): Promise<Reach | NeededChange> {
        const ids = { userId: user.id }
        if (!user.discordId) {
            return change(
                'user_missing_discord_id',
                user.id,
                `User ${user.id} has no Discord username in D1`,
                ids,
            )
        }
        const member = await this.api.findMember(user.discordId)
        if (!member) {
            return change(
                'user_not_in_guild',
                user.discordId,
                `Discord user "${user.discordId}" isn't in the server (they haven't joined, or the username in D1 is wrong)`,
                ids,
            )
        }
        return { memberId: member.user.id, held: new Set(member.roles) }
    }

    /** A reach failure as drift: a person who hasn't joined yet doesn't stop anything. */
    private drift(problem: NeededChange, user: User): NeededChange[] {
        return hasEnded(user) ? [] : [{ ...problem, blocking: false }]
    }

    // ---------- Applying a wanted list to one member ----------

    /** Gives the member every role marked true. Roles must already exist (never creates them). */
    private async grant(g: Guild, r: Reach, wanted: Wanted, reason: string) {
        for (const [name, shouldHave] of wanted) {
            if (!shouldHave) continue
            const role = g.book.find(name)
            if (!role) throw roleMissing(name)
            if (r.held.has(role.id)) continue
            if (!(await this.api.addRole(r.memberId, role.id, reason)))
                throw notInGuildError(r.memberId)
            r.held.add(role.id)
        }
    }

    /** Takes away every role marked false that the member has. Missing roles are skipped. */
    private async revoke(g: Guild, r: Reach, wanted: Wanted, reason: string) {
        for (const [name, shouldHave] of wanted) {
            if (shouldHave) continue
            const role = g.book.find(name)
            if (!role || !r.held.has(role.id)) continue
            await this.api.removeRole(r.memberId, role.id, reason)
            r.held.delete(role.id)
        }
    }

    /** Problems with the bot itself or the roles an action touches. Empty if it can go ahead. */
    private async preflight(g: Guild, touched: string[] = [], extraTeams: Team[] = []) {
        const teams = [
            ...new Map([...(await this.teams()), ...extraTeams].map((t) => [t.id, t])).values(),
        ]
        const problems = await checkBot(
            g,
            this.env,
            touched,
            teams.map((t) => t.teamSlug),
        )
        if (problems.length) return problems
        problems.push(...identityChanges(g, teams))
        if (problems.length) return problems
        const url = installUrl(this.env)
        try {
            const app = await this.api.application()
            if (
                !(
                    (app.flags ?? 0) &
                    (ApplicationFlags.GatewayGuildMembers |
                        ApplicationFlags.GatewayGuildMembersLimited)
                )
            ) {
                return [
                    change(
                        'members_intent_required',
                        'Server Members Intent',
                        `Enable Server Members Intent at https://discord.com/developers/applications/${this.api.botId}/bot (apply for approval if required). This is separate from OAuth permissions: ${url}`,
                    ),
                ]
            }
            // Exercise the read paths that membership removals/updates will need before changing roles.
            for (const team of teams) {
                const found = await g.leadsThread(team.teamSlug)
                if (found) await g.memberIds(found.thread.id)
            }
        } catch (e) {
            if (!(e instanceof ServiceError) || e.retryable) throw e
            problems.push(
                change(
                    e.code === 'THREAD_CONFLICT' ? 'setup_conflict' : 'missing_permissions',
                    'thread access',
                    `Cannot inspect leads-thread membership (${e.message}). Check channel access and Server Members Intent at https://discord.com/developers/applications/${this.api.botId}/bot. Installation: ${url}`,
                ),
            )
        }
        return problems
    }

    // ---------- Users and teams ----------

    async addUserToTeam(
        user: User,
        team: Team,
        vertical: Vertical,
        isLead: boolean,
    ): Promise<ServiceResult> {
        const rows = withAssignment(await this.getRows(user.id), {
            userId: user.id,
            teamId: team.id,
            vertical,
            isLead,
        })
        const wanted = teamScopeWanted(team, rows, execKeep(user))
        const isTeamLead = isLeadOf(rows, team.id) // a lead in any of their verticals here

        // Checks first. Nothing is changed until all of them pass (no partial configs).
        const g = await Guild.load(this.api)
        if (g.problems.length) return blocked(g.problems)
        const reach = await this.reach(user)
        const needed = [
            ...(await this.preflight(
                g,
                wanted.map(([name]) => name),
            )),
            ...(isProblem(reach) ? [reach] : []),
            ...missingRoleChanges(g.book, wantedNames(wanted), team.id),
            ...(await entityChanges(g, team, { thread: isTeamLead })),
        ]
        if (isBlocked(needed) || isProblem(reach)) return blocked(needed)

        const wasMember = reach.held.has(g.book.find(team.name)!.id)
        const reason = `Added to ${team.name} / ${vertical}`
        // Grants first so a lead <-> fellow swap never leaves someone without a role if it fails halfway
        await this.grant(g, reach, wanted, reason)
        await this.revoke(g, reach, wanted, reason)
        await setLeadsMember(g, team, reach.memberId, isTeamLead)
        // Only for someone new to the team, so re-running (or adding a second vertical) doesn't re-welcome them
        if (!wasMember) {
            // Cosmetic: access is already set up, so a failed welcome mustn't make the action fail
            await this.welcome(g, team, reach.memberId, vertical, isLead).catch((e) =>
                console.warn(`Discord welcome for ${user.id} in #${team.teamSlug} failed`, e),
            )
        }
        return ok(needed)
    }

    private async welcome(
        g: Guild,
        team: Team,
        discordId: string,
        vertical: Vertical,
        isLead: boolean,
    ) {
        const channel = g.channelOf(team.teamSlug)!
        await this.api.sendMessage(channel.id, {
            content: `<@${discordId}>`,
            allowed_mentions: { users: [discordId] },
            embeds: [
                {
                    title: `Welcome to ${team.name}!`,
                    description:
                        `<@${discordId}> just joined as a **${verticalLabel(vertical)} ${isLead ? 'Lead' : 'Fellow'}**. ` +
                        `Say hi and introduce yourself!`,
                    color: WELCOME_COLOR,
                    footer: { text: 'Longhorn Developers' },
                    timestamp: new Date().toISOString(),
                },
            ],
        })
    }

    async removeUserFromTeam(user: User, team: Team): Promise<ServiceResult> {
        const g = await Guild.load(this.api)
        if (g.problems.length) return blocked(g.problems)
        const reach = await this.reach(user)
        if (isProblem(reach)) return ok() // can't be in the server's roles, so nothing to remove

        // Same whether or not the DB rows for this team are already gone
        const rows = (await this.getRows(user.id)).filter((r) => r.teamId !== team.id)
        const wanted = teamScopeWanted(team, rows, execKeep(user))

        const gate = await this.preflight(
            g,
            wanted.map(([name]) => name),
        )
        if (gate.length) return blocked(gate)

        await this.revoke(g, reach, wanted, `Removed from ${team.name}`)
        await setLeadsMember(g, team, reach.memberId, false)
        return ok()
    }

    // ---------- Onboarding / deactivation ----------

    // Only `discord` (the user's Discord username) is used here. name/email/github are for other services.
    async onboardUser(
        _name: string,
        _email: string,
        _github: string | undefined,
        discord: string,
    ): Promise<ServiceResult> {
        const g = await Guild.load(this.api)
        const needed = await this.preflight(g, [MEMBER_ROLE])
        if (needed.length) return blocked(needed)
        needed.push(...missingRoleChanges(g.book, [MEMBER_ROLE]))

        const member = await this.api.findMember(discord)
        if (!member) {
            needed.push(
                change(
                    'user_not_in_guild',
                    discord,
                    `Discord user "${discord}" isn't in the server (they haven't joined, or the username is wrong)`,
                ),
            )
        }
        if (isBlocked(needed) || !member) return blocked(needed)

        await this.grant(
            g,
            { memberId: member.user.id, held: new Set(member.roles) },
            [[MEMBER_ROLE, true]],
            'Onboarded',
        )
        return ok(needed)
    }

    async deactivateUser(user: User): Promise<ServiceResult> {
        const g = await Guild.load(this.api)
        if (g.problems.length) return blocked(g.problems)
        const reach = await this.reach(user)
        if (isProblem(reach)) return ok()

        // Checked against every team, so it doesn't matter whether the user's team_users rows still exist
        const teams = await this.teams()
        const managed = managedNames(teams)
        const toRemove = [...reach.held].filter((id) => {
            const name = g.book.nameOf(id)
            return !!name && managed.has(norm(name))
        })

        const gate = await this.preflight(
            g,
            toRemove.map((id) => g.book.nameOf(id)!),
        )
        if (gate.length) return blocked(gate)

        for (const roleId of toRemove)
            await this.api.removeRole(reach.memberId, roleId, 'Deactivated')
        for (const team of teams) await setLeadsMember(g, team, reach.memberId, false)
        return ok()
    }

    async updateUser(before: User, after: User): Promise<ServiceResult> {
        if (before.discordId === after.discordId) return ok() // nothing Discord cares about changed
        const g = await Guild.load(this.api)
        if (g.problems.length) return blocked(g.problems)
        const old = await this.reach(before)
        if (isProblem(old)) return ok() // no old account to move from; syncUser will report what's missing

        const next = await this.reach(after)
        if (isProblem(next)) return blocked([next]) // nothing changed
        // Correcting capitalization or a leading @ can resolve to the very same account.
        // Moving access to itself would otherwise remove all its roles and leads memberships.
        if (old.memberId === next.memberId) return ok()

        const teams = await this.teams()
        const managed = managedNames(teams)
        const toMove = [...old.held].filter((id) => {
            const name = g.book.nameOf(id)
            return !!name && managed.has(norm(name))
        })
        const gate = await this.preflight(
            g,
            toMove.map((id) => g.book.nameOf(id)!),
        )
        if (gate.length) return blocked(gate)

        const rows = await this.getRows(after.id)
        const needed: NeededChange[] = []
        for (const team of teams.filter((t) => isLeadOf(rows, t.id))) {
            needed.push(...(await entityChanges(g, team, { thread: true })))
        }
        if (isBlocked(needed)) return blocked(needed)
        for (const roleId of toMove) {
            if (next.held.has(roleId)) continue
            if (!(await this.api.addRole(next.memberId, roleId, 'Discord account changed'))) {
                throw notInGuildError(next.memberId)
            }
        }
        for (const team of teams) {
            if (!isLeadOf(rows, team.id)) continue
            await setLeadsMember(g, team, next.memberId, true)
            await setLeadsMember(g, team, old.memberId, false)
        }
        for (const roleId of toMove)
            await this.api.removeRole(old.memberId, roleId, 'Discord account changed')
        return ok()
    }

    // ---------- Exec ----------

    async makeExec(
        user: User,
        execRole: ExecRole,
        previousRole?: ExecRole,
    ): Promise<ServiceResult> {
        const wanted = execWanted(execRole)
        // Moving between exec roles: also drop what only the old one gave (the new one and their teams still count)
        if (previousRole && previousRole !== execRole) {
            const rows = await this.getRows(user.id)
            wanted.push(...this.execRoleLeftBehind(previousRole, rows, execKeep(user)))
        }

        const g = await Guild.load(this.api)
        if (g.problems.length) return blocked(g.problems)
        const reach = await this.reach(user)

        const needed = [
            ...(await this.preflight(
                g,
                wanted.map(([name]) => name),
            )),
            ...(isProblem(reach) ? [reach] : []),
            ...missingRoleChanges(g.book, wantedNames(wanted)),
        ]
        if (isBlocked(needed) || isProblem(reach)) return blocked(needed)

        await this.grant(g, reach, wanted, `Made ${execRole}`)
        if (previousRole)
            await this.revoke(g, reach, wanted, `Moved from ${previousRole} to ${execRole}`)
        return ok(needed)
    }

    /** They're no longer exec: everything `execRole` gave them goes, except what their team assignments still justify. */
    async removeExec(user: User, execRole: ExecRole): Promise<ServiceResult> {
        const g = await Guild.load(this.api)
        if (g.problems.length) return blocked(g.problems)
        const reach = await this.reach(user)
        if (isProblem(reach)) return ok()

        const wanted: Wanted = [
            [EXEC_BOARD_ROLE, false],
            ...this.execRoleLeftBehind(execRole, await this.getRows(user.id), new Set()),
        ]

        const gate = await this.preflight(
            g,
            wanted.map(([name]) => name),
        )
        if (gate.length) return blocked(gate)

        await this.revoke(g, reach, wanted, `No longer ${execRole}`)
        return ok()
    }

    /** The roles `execRole` gave that should go (marked false): itself, and Leads roles nothing else justifies. `keep` is what still justifies them. */
    private execRoleLeftBehind(execRole: ExecRole, rows: TeamUser[], keep: Set<string>): Wanted {
        const wanted: Wanted = [[execRole, false]]
        const vertical = execLeadVertical[execRole]
        if (vertical) {
            const leadName = roleNames.verticalRank(vertical, true)
            if (!rows.some((r) => r.isLead) && !keep.has(norm(LEAD_ROLE)))
                wanted.push([LEAD_ROLE, false])
            if (
                !rows.some((r) => r.vertical === vertical && r.isLead) &&
                !keep.has(norm(leadName))
            ) {
                wanted.push([leadName, false])
            }
        }
        return wanted
    }

    // ---------- Teams ----------

    async createTeam(team: Team): Promise<ServiceResult> {
        const g = await Guild.load(this.api)

        // Check everything this will touch before creating anything
        const needed = await this.preflight(g, teamRoleNames(team))
        if (needed.length) return blocked(needed)
        const onboarding = await loadOnboarding(g)
        if (onboardingProblem(onboarding)) needed.push(onboarding)
        else
            needed.push(
                ...(await setupChanges(g, await this.teams(), onboarding, {
                    roles: teamRoleNames(team),
                    channels: [team.teamSlug],
                    category: true,
                    options: [optionTitle(team)],
                    threads: [team.teamSlug],
                })),
            )
        if (needed.length) return blocked(needed)

        const [teamRoleName, ...verticalRoleNames] = teamRoleNames(team)
        if (!g.book.find(teamRoleName)) await this.createRole(g, teamRoleName)
        for (const name of verticalRoleNames) {
            if (!g.book.find(name)) await this.createRole(g, name)
        }

        const channel = await ensureChannel(g, team)
        const category = await ensureCategory(g)
        if (channel.parent_id !== category.id)
            await this.api.moveChannel(
                channel.id,
                category.id,
                'Team channels live in the project category',
            )
        const leads = await ensureThread(g, team)
        if (leads.thread.thread_metadata?.invitable !== false)
            await this.api.secureThread(leads.thread.id)
        await applyOnboarding(g, [team], [])
        return ok()
    }

    private async createRole(g: Guild, name: string): Promise<Role> {
        const role = await this.api.createRole(name, 'Created by the team service')
        g.book.add(role)
        return role
    }

    async deleteTeam(team: Team): Promise<ServiceResult> {
        const g = await Guild.load(this.api)
        const gate = await this.preflight(g, teamRoleNames(team), [team])
        if (gate.length) return blocked(gate)
        const onboarding = await loadOnboarding(g)
        if (onboardingProblem(onboarding)) return blocked([onboarding])
        const leads = await g.leadsThread(team.teamSlug)
        const members = leads ? await g.memberIds(leads.thread.id) : new Set<string>()

        // Preserve the conversation, but revoke the deleted team's private access.
        for (const id of members) {
            if (id !== this.api.botId) await setLeadsMember(g, team, id, false)
        }

        // Deleting a role also takes it off everyone who had it
        for (const name of teamRoleNames(team)) {
            const role = g.book.find(name)
            if (!role) continue
            await this.api.deleteRole(role.id, 'Team deleted')
            g.book.remove(role)
        }

        if (managedPrompt(onboarding)?.options.some((o) => o.title === optionTitle(team))) {
            await applyOnboarding(g, [], [optionTitle(team)])
        }

        // Channels are never deleted for you
        const channel = g.channelOf(team.teamSlug)
        return ok(channel ? [this.deleteChannelChange(channel)] : [])
    }

    private deleteChannelChange(channel: Channel, reason?: string) {
        return change(
            'delete_channel',
            channel.id,
            reason ??
                `Optional: delete #${channel.name} and its leads thread, since its team was deleted. Only do this if you're sure.`,
        )
    }

    // ---------- Syncs: report only, change nothing ----------

    /** The team's roles, channel and thread, plus whether each of its D1 members has the right roles for it. */
    async syncTeam(team: Team): Promise<ServiceResult> {
        const g = await Guild.load(this.api)
        const gate = await this.preflight(g, teamRoleNames(team))
        if (gate.length) return ok(gate)

        const changes = await entityChanges(g, team, { thread: true })
        const onboarding = await loadOnboarding(g)
        if (onboardingProblem(onboarding)) changes.push(onboarding)
        else
            changes.push(
                ...onboardingChanges(g, onboarding, [team]).filter(
                    (c) => c.kind === 'set_onboarding_option',
                ),
            )

        const state = await this.state()
        const rowsByUser = groupRows(state.assignments)
        const resolved = new Map<string, string>() // D1 user id -> Discord user id, for everyone found in the server
        for (const user of state.users) {
            const rows = hasEnded(user) ? [] : (rowsByUser.get(user.id) ?? [])
            const reach = await this.reach(user)
            if (isProblem(reach)) {
                changes.push(...this.drift(reach, user))
                continue
            }
            resolved.set(user.id, reach.memberId)
            const wanted = teamScopeWanted(team, rows, execKeep(user))
            changes.push(
                ...diffChanges(g.book, reach.held, wanted, { userId: user.id, teamId: team.id }),
            )
        }
        changes.push(...(await this.leadsThreadChanges(g, team, state.users, rowsByUser, resolved)))
        return ok(changes)
    }

    /** One user's roles across every team, plus Members and exec roles. Also finds roles they shouldn't have. */
    async syncUser(user: User): Promise<ServiceResult> {
        const g = await Guild.load(this.api)
        const gate = await this.preflight(g)
        if (gate.length) return ok(gate)

        const [rows, teams] = await Promise.all([this.getRows(user.id), this.teams()])
        const reach = await this.reach(user)
        const changes = await this.userChanges(g, user, rows, teams, reach)

        if (!isProblem(reach)) {
            for (const team of teams) {
                if (!hasEnded(user) && isLeadOf(rows, team.id)) {
                    changes.push(...(await entityChanges(g, team, { thread: true })))
                }
                const found = await g.leadsThread(team.teamSlug)
                if (!found) continue
                const isIn = (await g.memberIds(found.thread.id)).has(reach.memberId)
                const shouldBe = !hasEnded(user) && isLeadOf(rows, team.id)
                if (shouldBe && !isIn)
                    changes.push(this.leadsMemberChange(true, reach.memberId, team, user.id))
                if (!shouldBe && isIn)
                    changes.push(this.leadsMemberChange(false, reach.memberId, team, user.id))
            }
        }
        return ok(changes)
    }

    /** Every team's entities, the shared roles, onboarding, and every D1 user's roles. */
    async syncService(): Promise<ServiceResult> {
        return this.audit(await Guild.load(this.api))
    }

    private async audit(g: Guild, touched: string[] = []): Promise<ServiceResult> {
        const gate = await this.preflight(g, touched)
        if (gate.length) return ok(gate)

        const state = await this.state()
        const rowsByUser = groupRows(state.assignments)

        const changes = missingRoleChanges(g.book, [
            MEMBER_ROLE,
            EXEC_BOARD_ROLE,
            ...execRoles,
            ...rankRoleNames(),
        ])
        for (const team of state.teams)
            changes.push(...(await entityChanges(g, team, { thread: true })))

        const onboarding = await loadOnboarding(g)
        if (onboardingProblem(onboarding)) changes.push(onboarding)
        else changes.push(...onboardingChanges(g, onboarding, state.teams))

        const slugs = new Set(state.teams.map((t) => t.teamSlug))
        for (const channel of g.categoryChannels()) {
            if (!slugs.has(channel.name)) {
                changes.push(
                    this.deleteChannelChange(
                        channel,
                        `Optional: #${channel.name} is in "${CATEGORY_NAME}" but matches no team. Delete it only if it's a leftover.`,
                    ),
                )
            }
        }

        const resolved = new Map<string, string>()
        for (const user of state.users) {
            const reach = await this.reach(user)
            if (!isProblem(reach)) resolved.set(user.id, reach.memberId)
            changes.push(
                ...(await this.userChanges(
                    g,
                    user,
                    rowsByUser.get(user.id) ?? [],
                    state.teams,
                    reach,
                )),
            )
        }
        for (const team of state.teams) {
            changes.push(
                ...(await this.leadsThreadChanges(g, team, state.users, rowsByUser, resolved)),
            )
        }
        return ok(changes)
    }

    private async userChanges(
        g: Guild,
        user: User,
        rows: TeamUser[],
        teams: Team[],
        known?: Reach | NeededChange,
    ): Promise<NeededChange[]> {
        const reach = known ?? (await this.reach(user))
        if (isProblem(reach)) return this.drift(reach, user)
        return diffChanges(g.book, reach.held, fullWanted(user, rows, teams), { userId: user.id })
    }

    /** `memberId` is the Discord user id (the change's target), not the username. */
    private leadsMemberChange(add: boolean, memberId: string, team: Team, userId?: string) {
        return change(
            add ? 'add_leads_member' : 'remove_leads_member',
            memberId,
            add
                ? `Should be in #${team.teamSlug}'s private "${LEADS_THREAD}" thread`
                : `Should not be in #${team.teamSlug}'s private "${LEADS_THREAD}" thread`,
            { teamId: team.id, userId },
        )
    }

    /** Who is in the team's leads thread vs who should be: its D1 leads, and nobody else but the bot. `resolved` maps D1 user ids to Discord user ids. */
    private async leadsThreadChanges(
        g: Guild,
        team: Team,
        users: User[],
        rowsByUser: Map<string, TeamUser[]>,
        resolved: Map<string, string>,
    ): Promise<NeededChange[]> {
        const found = await g.leadsThread(team.teamSlug)
        if (!found) return []
        const members = await g.memberIds(found.thread.id)

        const changes: NeededChange[] = []
        const shouldBeIn = new Set<string>([g.api.botId])
        for (const user of users) {
            const memberId = resolved.get(user.id)
            if (!memberId || hasEnded(user) || !isLeadOf(rowsByUser.get(user.id) ?? [], team.id))
                continue
            shouldBeIn.add(memberId)
            if (!members.has(memberId))
                changes.push(this.leadsMemberChange(true, memberId, team, user.id))
        }
        const userOf = new Map([...resolved].map(([userId, memberId]) => [memberId, userId]))
        for (const id of members) {
            if (!shouldBeIn.has(id))
                changes.push(this.leadsMemberChange(false, id, team, userOf.get(id)))
        }
        return changes
    }

    // ---------- Fixing ----------

    /**
     * Makes the changes this service reported that it can make, in a safe order (roles, channels,
     * threads, memberships, onboarding, then deletions). Checks the bot's permissions first and
     * throws, changing nothing, if anything is missing. Re-running is safe: everything here is idempotent.
     */
    async autoFix(changes: NeededChange[]): Promise<FixServiceResult> {
        const rejected: NeededChange[] = []
        const queue: NeededChange[] = []
        for (const c of changes) {
            const info = infoOf(c.kind)
            if (c.service === SERVICE && info && !('manual' in info) && c.fixable) queue.push(c)
            else rejected.push(c) // needs a person, or isn't ours / a kind we know
        }
        if (!queue.length) return { changes: [], failed: false, failedChanges: [], rejected }

        queue.sort((a, b) => fixOrder.indexOf(a.kind as Kind) - fixOrder.indexOf(b.kind as Kind))
        const g = await Guild.load(this.api)

        // Validate against current D1 and Discord before any writes, just like the GitHub service.
        const audit = await this.audit(
            g,
            queue.filter((c) => c.kind.endsWith('_role')).map((c) => c.target),
        )
        const manual = audit.changes.filter((c) => c.blocking && !c.fixable)
        if (manual.length)
            return {
                changes: manual,
                failed: true,
                failedChanges: [],
                rejected: [...rejected, ...queue],
            }
        const same = (a: NeededChange, b: NeededChange) =>
            a.kind === b.kind &&
            a.target === b.target &&
            (['create_role', 'create_category'].includes(a.kind) ||
                (a.userId === b.userId && a.teamId === b.teamId))
        const selected: NeededChange[] = []
        const failedChanges: FailedChange[] = []
        for (const c of queue) {
            const fresh = audit.changes.find((n) => n.fixable && same(c, n))
            if (!fresh || selected.some((n) => same(n, fresh))) {
                failedChanges.push({
                    change: c,
                    error: new Error(`Stale or duplicate Discord change: ${c.kind} ${c.target}`),
                })
            } else selected.push(fresh)
        }
        const gate: NeededChange[] = []
        const teams = await this.teams()
        const onboardingState = await loadOnboarding(g)
        if (onboardingProblem(onboardingState)) gate.push(onboardingState)
        else
            gate.push(
                ...(await setupChanges(g, teams, onboardingState, {
                    roles: selected.filter((c) => c.kind === 'create_role').map((c) => c.target),
                    channels: selected
                        .filter((c) => ['create_team_channel', 'move_channel'].includes(c.kind))
                        .flatMap((c) =>
                            teams.filter((t) => t.id === c.teamId).map((t) => t.teamSlug),
                        ),
                    category: selected.some((c) =>
                        ['create_category', 'create_team_channel', 'move_channel'].includes(c.kind),
                    ),
                    options: selected
                        .filter((c) => c.kind === 'set_onboarding_option')
                        .flatMap((c) => teams.filter((t) => t.id === c.teamId).map(optionTitle)),
                    removeOptions: selected
                        .filter((c) => c.kind === 'remove_onboarding_option')
                        .map((c) => c.target),
                    threads: selected
                        .filter((c) => c.kind === 'create_leads_thread')
                        .flatMap((c) =>
                            teams.filter((t) => t.id === c.teamId).map((t) => t.teamSlug),
                        ),
                })),
            )
        // Dependencies may be created by this batch, but must not be discovered missing mid-write.
        const will = (kind: Kind, target: string) =>
            selected.some((c) => c.kind === kind && c.target === target)
        for (const c of selected) {
            const team = teams.find((t) => t.id === c.teamId)
            if (
                ['create_team_channel', 'move_channel'].includes(c.kind) &&
                !g.category() &&
                !will('create_category', CATEGORY_NAME)
            ) {
                gate.push(
                    change(
                        'create_category',
                        CATEGORY_NAME,
                        'Select the missing project category creation first',
                    ),
                )
            }
            if (c.kind === 'add_role' && !g.book.find(c.target) && !will('create_role', c.target)) {
                gate.push(...missingRoleChanges(g.book, [c.target], c.teamId))
            }
            if (
                team &&
                ['create_leads_thread', 'add_leads_member', 'set_onboarding_option'].includes(
                    c.kind,
                ) &&
                !g.channelOf(team.teamSlug) &&
                !will('create_team_channel', team.teamSlug)
            ) {
                gate.push(
                    change(
                        'create_team_channel',
                        team.teamSlug,
                        'Select the missing channel creation first',
                        { teamId: team.id },
                    ),
                )
            }
            if (
                team &&
                c.kind === 'add_leads_member' &&
                !(await g.leadsThread(team.teamSlug)) &&
                !will('create_leads_thread', team.teamSlug)
            ) {
                gate.push(
                    change(
                        'create_leads_thread',
                        team.teamSlug,
                        'Select the missing leads-thread creation first',
                        { teamId: team.id },
                    ),
                )
            }
        }
        if (gate.length) {
            return {
                changes: dedupe(gate),
                failed: true,
                failedChanges,
                rejected: [...rejected, ...selected],
            }
        }

        const fail = (c: NeededChange, error: unknown) =>
            failedChanges.push({
                change: c,
                error: error instanceof Error ? error : new Error(String(error)),
            })

        // Onboarding is one read-modify-write for all of its changes
        const onboarding = selected.filter((c) => c.kind.endsWith('_onboarding_option'))
        for (const c of selected.filter(
            (c) => !onboarding.includes(c) && c.kind !== 'delete_channel',
        )) {
            try {
                await this.fix(c, g)
            } catch (e) {
                fail(c, e)
            }
        }
        if (onboarding.length) await this.fixOnboarding(g, onboarding, fail)
        for (const c of selected.filter((c) => c.kind === 'delete_channel')) {
            try {
                await this.fix(c, g)
            } catch (e) {
                fail(c, e)
            }
        }

        return { changes: [], failed: failedChanges.length > 0, failedChanges, rejected }
    }

    private async fixOnboarding(
        g: Guild,
        changes: NeededChange[],
        fail: (c: NeededChange, e: unknown) => void,
    ) {
        const add: Team[] = []
        const valid: NeededChange[] = []
        for (const c of changes.filter((c) => c.kind === 'set_onboarding_option')) {
            try {
                add.push(await this.db.getTeam(c.teamId ?? ''))
                valid.push(c)
            } catch (e) {
                fail(c, e)
            }
        }
        const remove = changes.filter((c) => c.kind === 'remove_onboarding_option')
        try {
            await applyOnboarding(
                g,
                add,
                remove.map((c) => c.target),
            )
        } catch (e) {
            for (const c of [...valid, ...remove]) fail(c, e)
        }
    }

    private async teamOf(c: NeededChange): Promise<Team> {
        if (!c.teamId) throw new Error(`Change ${c.kind} "${c.target}" has no teamId`)
        return this.db.getTeam(c.teamId) // throws RecordNotFoundError if the team is gone
    }

    private async fix(c: NeededChange, g: Guild): Promise<void> {
        switch (c.kind as Kind) {
            case 'create_role':
                if (!g.book.find(c.target)) await this.createRole(g, c.target)
                return

            case 'create_category':
                await ensureCategory(g)
                return

            case 'create_team_channel': {
                const team = await this.teamOf(c)
                await ensureChannel(g, team)
                return
            }

            case 'create_leads_thread':
                await ensureThread(g, await this.teamOf(c))
                return

            case 'secure_leads_thread': {
                const found = await g.leadsThread((await this.teamOf(c)).teamSlug)
                if (found) {
                    if (found.archived)
                        await this.api.unarchiveThread(found.thread.id, 'Securing leads thread')
                    await this.api.secureThread(found.thread.id)
                }
                return
            }

            case 'move_channel': {
                const team = await this.teamOf(c)
                const channel = g.channelOf(team.teamSlug)
                if (!channel)
                    throw new ServiceError(
                        SERVICE,
                        'CHANNEL_MISSING',
                        false,
                        `#${team.teamSlug} does not exist`,
                    )
                const category = await ensureCategory(g)
                if (channel.parent_id !== category.id) {
                    await this.api.moveChannel(
                        channel.id,
                        category.id,
                        'Team channels live in the project category',
                    )
                    channel.parent_id = category.id
                }
                return
            }

            case 'add_role':
            case 'remove_role': {
                if (!c.userId) throw new Error(`Change for role "${c.target}" has no userId`)
                const user = await this.db.getUser(c.userId) // throws RecordNotFoundError if they're gone
                if (!user.discordId)
                    throw new Error(`User ${c.userId} has no Discord username in D1`)
                const role = g.book.find(c.target)
                if (!role) throw roleMissing(c.target)

                const member = await this.api.findMember(user.discordId)
                if (!member) {
                    if (c.kind === 'remove_role') return // not in the server, so they can't hold it
                    throw notInGuildError(user.discordId)
                }
                if (c.kind === 'remove_role')
                    await this.api.removeRole(member.user.id, role.id, c.reason)
                else if (!(await this.api.addRole(member.user.id, role.id, c.reason)))
                    throw notInGuildError(user.discordId)
                return
            }

            case 'add_leads_member':
            case 'remove_leads_member':
                // target is the Discord id: the member may not be a D1 user at all
                await setLeadsMember(
                    g,
                    await this.teamOf(c),
                    c.target,
                    c.kind === 'add_leads_member',
                )
                return

            case 'delete_channel': {
                // Stable channel ids prevent old approvals from targeting replacement channels.
                const channel = g.categoryChannels().find((ch) => ch.id === c.target)
                if (channel && (await this.teams()).some((t) => t.teamSlug === channel.name)) {
                    throw new Error('Channel now belongs to a team; approval is stale')
                }
                if (channel) await this.api.deleteChannel(channel.id, 'Deleted on request')
                return
            }

            default:
                throw new Error(`Unsupported change kind "${c.kind}"`)
        }
    }
}
