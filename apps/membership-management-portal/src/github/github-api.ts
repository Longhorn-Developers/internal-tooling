import { createAppAuth } from '@octokit/auth-app'
import { Octokit } from '@octokit/core'
import { paginateRest } from '@octokit/plugin-paginate-rest'
import { restEndpointMethods } from '@octokit/plugin-rest-endpoint-methods'
import { RequestError } from '@octokit/request-error'
import { ServiceError } from '../service'
import Env = Cloudflare.Env;

// API names for repository roles; the GitHub UI calls `push` "Write"
export type RepoPermission = 'pull' | 'triage' | 'push' | 'maintain' | 'admin'
export type TeamRole = 'member' | 'maintainer'

export type GitHubErrorCode =
    | 'GITHUB_BAD_CREDENTIALS'
    | 'GITHUB_NOT_FOUND'
    | 'GITHUB_FORBIDDEN'
    | 'GITHUB_RATE_LIMITED'
    | 'GITHUB_VALIDATION_FAILED'
    | 'GITHUB_UNAVAILABLE'
    | 'GITHUB_ERROR'

const retryableCodes = new Set<GitHubErrorCode>([
    'GITHUB_RATE_LIMITED',
    'GITHUB_UNAVAILABLE',
    'GITHUB_ERROR',
])

// Octokit only gives the HTTP status; the codes are ours
function codeFor(status: number, message: string): GitHubErrorCode {
    if (status === 401) return 'GITHUB_BAD_CREDENTIALS'
    if (status === 404) return 'GITHUB_NOT_FOUND'
    if (status === 429 || (status === 403 && /rate limit/i.test(message))) {
        return 'GITHUB_RATE_LIMITED'
    }
    if (status === 403) return 'GITHUB_FORBIDDEN'
    if (status === 422) return 'GITHUB_VALIDATION_FAILED'
    if (status >= 500) return 'GITHUB_UNAVAILABLE'
    return 'GITHUB_ERROR'
}

/** A failed GitHub call; `code` says what kind (see the README's table). */
export class GitHubError extends ServiceError {
    declare code: GitHubErrorCode

    constructor(
        public status: number,
        message: string,
    ) {
        const code = codeFor(status, message)
        super('github', code, retryableCodes.has(code), message)
    }
}

const lc = (value: string) => value.toLowerCase()

/** Null instead of throwing on a 404, so deleting what is already gone counts as done. */
const orNull = <T>(request: Promise<T>) =>
    request.catch((error) => {
        if (error instanceof GitHubError && error.status === 404) return null
        throw error
    })

// ============================================================
// GraphQL: one query reads the whole org
// ============================================================

const PAGE_INFO = 'pageInfo { hasNextPage endCursor }'
const MEMBER_EDGES = `${PAGE_INFO} edges { role node { login } }`
const COLLABORATOR_EDGES = `edges {
  permission node { login }
  permissionSources { permission source { __typename ... on Repository { id } } }
}`

const TEAM_FIELDS = `fragment TeamFields on Team {
  id databaseId slug name
  members(first: $page, membership: IMMEDIATE) { ${MEMBER_EDGES} }
  invitations(first: $page) { ${PAGE_INFO} nodes { invitee { login } } }
  repositories(first: $page) { ${PAGE_INFO} edges { permission node { name } } }
}`

const REPO_FIELDS = `fragment RepoFields on Repository {
  id name isArchived isFork
  collaborators(first: $page, affiliation: DIRECT) { ${PAGE_INFO} ${COLLABORATOR_EDGES} }
}`

const SNAPSHOT = `query Snapshot($org: String!, $page: Int!) {
  organization(login: $org) {
    members: membersWithRole(first: $page) { ${MEMBER_EDGES} }
    pending: pendingMembers(first: 1) { totalCount }
    teams(first: $page) { ${PAGE_INFO} nodes { ...TeamFields } }
    repositories(first: $page) { ${PAGE_INFO} nodes { ...RepoFields } }
  }
}
${TEAM_FIELDS}
${REPO_FIELDS}`

// follow-up pages, only for lists longer than one page
const orgPage = (name: string, field: string, selection: string, fragments = '') =>
    `query ${name}($org: String!, $page: Int!, $after: String) {
  organization(login: $org) { c: ${field}(first: $page, after: $after) { ${PAGE_INFO} ${selection} } }
}
${fragments}`

const nodePage = (name: string, type: string, field: string, selection: string) =>
    `query ${name}($id: ID!, $page: Int!, $after: String) {
  node(id: $id) { ... on ${type} { c: ${field} { ${PAGE_INFO} ${selection} } } }
}`

const MORE = {
    orgMembers: orgPage('OrgMembers', 'membersWithRole', 'edges { role node { login } }'),
    orgTeams: orgPage('OrgTeams', 'teams', 'nodes { ...TeamFields }', TEAM_FIELDS),
    orgRepos: orgPage('OrgRepos', 'repositories', 'nodes { ...RepoFields }', REPO_FIELDS),
    teamMembers: nodePage('TeamMembers', 'Team', 'members(first: $page, after: $after, membership: IMMEDIATE)', 'edges { role node { login } }'),
    teamInvites: nodePage('TeamInvites', 'Team', 'invitations(first: $page, after: $after)', 'nodes { invitee { login } }'),
    teamRepos: nodePage('TeamRepos', 'Team', 'repositories(first: $page, after: $after)', 'edges { permission node { name } }'),
    collaborators: nodePage('RepoCollaborators', 'Repository', 'collaborators(first: $page, after: $after, affiliation: DIRECT)', COLLABORATOR_EDGES),
}

const fromGraphQL: Record<string, RepoPermission> = {
    ADMIN: 'admin', MAINTAIN: 'maintain', WRITE: 'push', TRIAGE: 'triage', TRIAGE_PLUS: 'triage', READ: 'pull',
}
const toGraphQL: Record<RepoPermission, string> = {
    admin: 'ADMIN', maintain: 'MAINTAIN', push: 'WRITE', triage: 'TRIAGE', pull: 'READ',
}

type Conn<T> = { pageInfo: { hasNextPage: boolean; endCursor: string | null }; edges?: T[]; nodes?: T[] }
type MemberEdge = { role: string; node: { login: string } }
type RepoEdge = { permission: string; node: { name: string } }
type CollaboratorEdge = {
    permission: string; node: { login: string }
    permissionSources: { permission: string; source: { __typename: string; id?: string } }[] | null
}
type GqlTeam = {
    id: string; databaseId: number; slug: string; name: string
    members: Conn<MemberEdge>
    invitations: Conn<{ invitee: { login: string } | null }> | null
    repositories: Conn<RepoEdge>
}
type GqlRepo = {
    id: string; name: string; isArchived: boolean; isFork: boolean
    collaborators: Conn<CollaboratorEdge> | null
}

const EMPTY = { pageInfo: { hasNextPage: false, endCursor: null } }

// GraphQL error types -> the HTTP status they mean
const statusOf = (type?: string) =>
    type === 'NOT_FOUND' ? 404
    : type === 'FORBIDDEN' || type === 'INSUFFICIENT_SCOPES' ? 403
    : type === 'RATE_LIMITED' || type === 'RATE_LIMIT' ? 429
    : 500

// ============================================================
// The snapshot
// ============================================================

type OrgEntry = { role: 'admin' | 'member'; state: 'active' | 'pending' }
// role is null when unknown (e.g. an owner we just demoted, or a pending invite)
type TeamEntry = { role: TeamRole | null; state: 'active' | 'pending' }
type TeamState = { id: string; dbId: number; name: string; members: Map<string, TeamEntry>; repos: Map<string, RepoPermission> }
type RepoState = { id: string; name: string; archived: boolean; fork: boolean; direct: Map<string, RepoPermission> }
type Snapshot = { members: Map<string, OrgEntry>; teams: Map<string, TeamState>; repos: Map<string, RepoState> }

export type TeamRepoGrant = { slug: string; repo: string; permission: RepoPermission }

const CALL_BUDGET = 36
const HARD_CALL_BUDGET = 44
// mutations per GraphQL request (a request with mutations costs 5 secondary-limit points)
const BATCH = 50
const PAGE = 100

export class GitHubBudgetExceeded extends Error {
    constructor() { super('GitHub request budget exhausted; retry with a fresh snapshot') }
}

const ownerIn = (s: Snapshot, id: string) => {
    const m = s.members.get(id)
    return m?.state === 'active' && m.role === 'admin'
}

const GitHub = Octokit.plugin(paginateRest, restEndpointMethods)

// one auth per app installation, so its installation token outlives a call
const auths = new Map<string, ReturnType<typeof createAppAuth>>()

/** Per-RPC snapshot; writes skip no-ops and update memory only after remote success. */
export class GitHubOrg {
    constructor(
        private readonly env: Env,
        private readonly pageSize = PAGE,
    ) {}

    private snap?: Snapshot
    private loading?: Promise<void>
    private accounts = new Map<string, number | null>() // logins checked outside the org -> user id (null: no such account)
    private batchGrants = true // false once GitHub refuses batched team grants
    private calls = 0

    private get org() {
        return this.env.GITHUB_ORG
    }

    /** The snapshot, read from GitHub on first use. */
    private async state(): Promise<Snapshot> {
        await this.load()
        return this.snap!
    }

    private _octokit?: InstanceType<typeof GitHub>
    private get octokit() {
        if (!this._octokit) {
            const { GITHUB_APP_ID: appId, GITHUB_APP_INSTALLATION_ID: installationId } = this.env
            const privateKey = this.env.GITHUB_APP_PRIVATE_KEY
            const key = `${appId}:${installationId}:${privateKey}`
            let auth = auths.get(key)
            if (!auth) auths.set(key, (auth = createAppAuth({ appId, privateKey, installationId })))
            const client = new GitHub({
                authStrategy: () => auth!,
                userAgent: 'lhd-membership-worker',
            })
            client.hook.before('request', (options) => {
                if (this.calls >= HARD_CALL_BUDGET) throw new GitHubBudgetExceeded()
                this.calls++
                options.headers['x-github-api-version'] = '2026-03-10'
            })
            client.hook.error('request', (error) => {
                throw error instanceof RequestError ? new GitHubError(error.status, error.message) : error
            })
            this._octokit = client
        }
        return this._octokit
    }

    /** Remote calls left before the subrequest budget is spent. */
    get callsLeft() {
        return CALL_BUDGET - this.calls
    }

    // ------------------------------------------------------------
    // Loading
    // ------------------------------------------------------------

    private async load(): Promise<void> {
        this.loading ??= this.fetchSnapshot().catch((error) => {
            this.loading = undefined
            throw error
        })
        await this.loading
    }

    /** Runs a GraphQL document. Partial results are returned with their errors instead of thrown. */
    private async gql(query: string, variables: Record<string, unknown> = {}) {
        try {
            return { data: await this.octokit.graphql<any>(query, variables), errors: [] as any[] }
        } catch (error: any) {
            if (error?.name !== 'GraphqlResponseError') throw error
            return { data: error.data ?? {}, errors: error.errors ?? [] }
        }
    }

    private async query(query: string, variables: Record<string, unknown> = {}, inOrg = true) {
        const { data, errors } = await this.gql(query, {
            ...(inOrg ? { org: this.org } : {}),
            page: this.pageSize,
            ...variables,
        })
        if (errors.length) {
            throw new GitHubError(statusOf(errors[0].type), errors.map((e: any) => e.message).join('; '))
        }
        return data
    }

    private async drain<T>(
        first: Conn<T> | null | undefined,
        field: 'edges' | 'nodes',
        more: (after: string) => Promise<Conn<T> | null | undefined>,
    ): Promise<T[]> {
        let page = first ?? (EMPTY as Conn<T>)
        const items = [...(page[field] ?? [])]
        while (page.pageInfo.hasNextPage && page.pageInfo.endCursor) {
            page = (await more(page.pageInfo.endCursor)) ?? (EMPTY as Conn<T>)
            items.push(...(page[field] ?? []))
        }
        return items
    }

    private async fetchSnapshot(): Promise<void> {
        const { organization: o } = await this.query(SNAPSHOT)
        if (!o) throw new GitHubError(404, `Organization ${this.org} does not exist`)
        const s: Snapshot = { members: new Map(), teams: new Map(), repos: new Map() }

        const members = await this.drain<MemberEdge>(o.members, 'edges', async (after) =>
            (await this.query(MORE.orgMembers, { after })).organization.c)
        for (const { role, node } of members) {
            s.members.set(lc(node.login), { role: role === 'ADMIN' ? 'admin' : 'member', state: 'active' })
        }

        const teams = await this.drain<GqlTeam>(o.teams, 'nodes', async (after) =>
            (await this.query(MORE.orgTeams, { after })).organization.c)
        for (const t of teams) await this.ingestTeam(s, t)

        const repos = await this.drain<GqlRepo>(o.repositories, 'nodes', async (after) =>
            (await this.query(MORE.orgRepos, { after })).organization.c)
        for (const r of repos) await this.ingestRepo(s, r)

        // invitations carry the role that pendingMembers doesn't
        if (o.pending.totalCount > 0) {
            const invitations = await this.octokit.paginate(this.octokit.rest.orgs.listPendingInvitations, {
                org: this.org,
                per_page: 100,
            })
            for (const { login, role } of invitations) {
                if (login && !s.members.has(lc(login))) {
                    s.members.set(lc(login), { role: role === 'admin' ? 'admin' : 'member', state: 'pending' })
                }
            }
        }
        this.snap = s
    }

    private async ingestTeam(s: Snapshot, t: GqlTeam) {
        const team: TeamState = { id: t.id, dbId: t.databaseId, name: t.name, members: new Map(), repos: new Map() }
        const members = await this.drain<MemberEdge>(t.members, 'edges', async (after) =>
            (await this.query(MORE.teamMembers, { id: t.id, after }, false)).node.c)
        for (const { role, node } of members) {
            team.members.set(lc(node.login), { role: role === 'MAINTAINER' ? 'maintainer' : 'member', state: 'active' })
        }
        const invites = await this.drain<{ invitee: { login: string } | null }>(t.invitations, 'nodes', async (after) =>
            (await this.query(MORE.teamInvites, { id: t.id, after }, false)).node.c)
        for (const { invitee } of invites) {
            if (invitee) team.members.set(lc(invitee.login), { role: null, state: 'pending' })
        }
        const repos = await this.drain<RepoEdge>(t.repositories, 'edges', async (after) =>
            (await this.query(MORE.teamRepos, { id: t.id, after }, false)).node.c)
        for (const { permission, node } of repos) team.repos.set(lc(node.name), fromGraphQL[permission] ?? 'pull')
        s.teams.set(t.slug, team)
    }

    private async ingestRepo(s: Snapshot, r: GqlRepo) {
        const repo: RepoState = { id: r.id, name: r.name, archived: r.isArchived, fork: r.isFork, direct: new Map() }
        const collaborators = await this.drain<CollaboratorEdge>(r.collaborators, 'edges', async (after) =>
            (await this.query(MORE.collaborators, { id: r.id, after }, false)).node.c)
        for (const { permission, node, permissionSources } of collaborators) {
            const direct = permissionSources?.find((p) => p.source.__typename === 'Repository' && p.source.id === r.id)
            if (permissionSources && !direct) continue
            repo.direct.set(lc(node.login), fromGraphQL[direct?.permission ?? permission] ?? 'pull')
        }
        s.repos.set(lc(r.name), repo)
    }

    /** Used as an optimization for `exists` to batch lookups; `exists` may be used standalone */
    async ensureAccounts(logins: string[]): Promise<void> {
        await this.load()
        await this.lookup(logins)
    }

    // doesn't load the snapshot, so a lone existence check stays one request
    private async lookup(logins: string[]): Promise<void> {
        const unknown = [...new Set(logins.map(lc))].filter(
            (login) => !this.snap?.members.has(login) && !this.accounts.has(login),
        )
        for (let i = 0; i < unknown.length; i += 50) {
            const chunk = unknown.slice(i, i + 50)
            const vars = chunk.map((_, n) => `$l${n}: String!`).join(', ')
            const fields = chunk.map((_, n) => `u${n}: user(login: $l${n}) { login databaseId }`).join(' ')
            const { data, errors } = await this.gql(
                `query Accounts(${vars}) { ${fields} }`,
                Object.fromEntries(chunk.map((login, n) => [`l${n}`, login])),
            )
            const bad = errors.find((e: any) => e.type !== 'NOT_FOUND')
            if (bad) throw new GitHubError(statusOf(bad.type), bad.message)
            chunk.forEach((login, n) => this.accounts.set(login, data[`u${n}`]?.databaseId ?? null))
        }
    }

    // ------------------------------------------------------------
    // Reads (the first one loads the snapshot)
    // ------------------------------------------------------------

    async exists(login: string): Promise<boolean> {
        await this.load();
        await this.lookup([login])
        return this.snap?.members.has(lc(login)) || this.accounts.get(lc(login)) != null
    }

    /** Undefined if neither a member nor invited. */
    async member(login: string) {
        return (await this.state()).members.get(lc(login))
    }

    async isOwner(login: string) {
        return ownerIn(await this.state(), lc(login))
    }

    /** Lowercased logins of active members with this role. */
    async orgLogins(role: 'admin' | 'member') {
        const { members } = await this.state()
        return [...members].filter(([, m]) => m.state === 'active' && m.role === role).map(([login]) => login)
    }

    /** Lowercased logins of pending org invitees. */
    async pendingLogins() {
        const { members } = await this.state()
        return [...members].filter(([, m]) => m.state === 'pending').map(([login]) => login)
    }

    async team(slug: string) {
        return (await this.state()).teams.get(slug)
    }

    async teams() {
        return [...(await this.state()).teams.keys()]
    }

    /** Attached repos and permissions. */
    async teamRepos(slug: string) {
        const s = await this.state()
        return [...(s.teams.get(slug)?.repos ?? [])].flatMap(([key, permission]) => {
            const repo = s.repos.get(key)
            return repo ? [{ name: repo.name, permission }] : []
        })
    }

    /** All org repos, including archived repos and forks. */
    async repos() {
        return [...(await this.state()).repos.values()]
    }

    /** Direct (not through a team) collaborators of a repo: lowercased login -> permission. */
    async collaborators(repo: string): Promise<ReadonlyMap<string, RepoPermission>> {
        return (await this.state()).repos.get(lc(repo))?.direct ?? new Map()
    }

    // ------------------------------------------------------------
    // Writes
    // ------------------------------------------------------------

    /** Sets an active member's role, or invites a non-member with it; pending roles left unchanged. */
    async setOrgRole(login: string, role: 'admin' | 'member'): Promise<void> {
        const s = await this.state()
        const id = lc(login)
        const current = s.members.get(id)
        if (!current) return this.invite(login, role, [])
        if (current.state === 'pending' || current.role === role) return

        const { data } = await this.octokit.rest.orgs.setMembershipForUser({ org: this.org, username: login, role })
        const isOwner = data.role === 'admin'
        s.members.set(id, { role: isOwner ? 'admin' : 'member', state: data.state })
        // owner team-role override
        for (const team of s.teams.values()) {
            const entry = team.members.get(id)
            if (entry?.state === 'active') entry.role = isOwner ? 'maintainer' : null
        }
    }

    /**
     * Invites a non-member with an org role and teams in one invitation (as team members; roles
     * come after they accept). A role or teams can't be edited later: cancel it and invite again.
     * Skipped if they're a member or already invited. Counts against the invitation limit.
     */
    async invite(login: string, role: 'admin' | 'member', teamSlugs: string[]): Promise<void> {
        const s = await this.state()
        const id = lc(login)
        if (s.members.has(id)) return

        await this.lookup([login])
        const inviteeId = this.accounts.get(id)
        if (inviteeId == null) throw new GitHubError(404, `GitHub user ${login} does not exist`)

        const teams = teamSlugs.flatMap((slug) => {
            const team = s.teams.get(slug)
            return team ? [{ slug, team }] : []
        })
        await this.octokit.rest.orgs.createInvitation({
            org: this.org,
            invitee_id: inviteeId,
            role: role === 'admin' ? 'admin' : 'direct_member',
            team_ids: teams.map(({ team }) => team.dbId),
        })
        s.members.set(id, { role, state: 'pending' })
        for (const { team } of teams) team.members.set(id, { role: null, state: 'pending' })
    }

    /** Removes org membership, teams and repo access; skips the no-op check if nothing is loaded yet. */
    async removeFromOrg(login: string): Promise<void> {
        const id = lc(login)
        if (this.snap && !this.snap.members.has(id)) return

        await orNull(this.octokit.rest.orgs.removeMembershipForUser({ org: this.org, username: login }))
        if (!this.snap) return
        this.snap.members.delete(id)
        for (const team of this.snap.teams.values()) team.members.delete(id)
        for (const repo of this.snap.repos.values()) repo.direct.delete(id)
    }

    /** Sets team membership after org invitation; pending invitees are skipped. */
    async setTeamMember(slug: string, login: string, role: TeamRole): Promise<void> {
        const s = await this.state()
        const id = lc(login)
        const team = s.teams.get(slug)
        if (!team) throw new GitHubError(404, `Team ${slug} does not exist`)
        const current = team.members.get(id)
        // GitHub doesn't document adding a pending invitee to another team; it's applied once they accept
        if (s.members.get(id)?.state === 'pending') return
        if (current?.state === 'active' && current.role === role) return
        if (current?.role === 'maintainer' && ownerIn(s, id)) return

        const { data } = await this.octokit.rest.teams.addOrUpdateMembershipForUserInOrg({
            org: this.org,
            team_slug: slug,
            username: login,
            role,
        })
        team.members.set(id, { role: data.role, state: data.state })
        if (!s.members.has(id)) s.members.set(id, { role: 'member', state: 'pending' })
    }

    /** Removes from a team (they stay in the org) or cancels their team invite. */
    async removeTeamMember(slug: string, login: string): Promise<void> {
        const id = lc(login)
        const team = (await this.state()).teams.get(slug)
        if (!team?.members.has(id)) return

        await orNull(
            this.octokit.rest.teams.removeMembershipForUserInOrg({ org: this.org, team_slug: slug, username: login }),
        )
        team.members.delete(id)
    }

    /** Creates a visible team unless one with this slug exists (GitHub derives the slug from the name). */
    async createTeam(name: string, slug: string): Promise<{ slug: string; id: string }> {
        const s = await this.state()
        const existing = s.teams.get(slug)
        if (existing) return { slug, id: existing.id }

        const { data } = await this.octokit.rest.teams.create({ org: this.org, name, privacy: 'closed' })
        s.teams.set(data.slug, { id: data.node_id, dbId: data.id, name: data.name, members: new Map(), repos: new Map() })
        return { slug: data.slug, id: data.node_id }
    }

    /** Deletes a team (its memberships go with it); members and repos stay in the org. */
    async deleteTeam(slug: string): Promise<void> {
        const s = await this.state()
        if (!s.teams.has(slug)) return

        await orNull(this.octokit.rest.teams.deleteInOrg({ org: this.org, team_slug: slug }))
        s.teams.delete(slug)
    }

    /** Last grant per target wins; ordered errors, null for success or superseded input. */
    async setTeamRepos(grants: TeamRepoGrant[]): Promise<(Error | null)[]> {
        const s = await this.state()
        const results: (Error | null)[] = grants.map(() => null)
        const todo: number[] = []
        const last = new Map<string, number>()
        const key = (g: TeamRepoGrant) => `${g.slug}/${lc(g.repo)}`
        grants.forEach((grant, i) => last.set(key(grant), i))
        grants.forEach(({ slug, repo, permission }, i) => {
            if (last.get(key(grants[i])) !== i) return
            const team = s.teams.get(slug)
            if (!team || !s.repos.has(lc(repo))) {
                results[i] = new GitHubError(404, `Team ${slug} or repository ${repo} does not exist`)
            } else if (team.repos.get(lc(repo)) !== permission) todo.push(i)
        })

        const apply = (i: number) => s.teams.get(grants[i].slug)!.repos.set(lc(grants[i].repo), grants[i].permission)
        const viaRest = async (i: number) => {
            const { slug, repo, permission } = grants[i]
            try {
                await this.octokit.rest.teams.addOrUpdateRepoPermissionsInOrg({
                    org: this.org, team_slug: slug, owner: this.org, repo, permission,
                })
                apply(i)
            } catch (error) {
                results[i] = error as Error
            }
        }

        for (let from = 0; from < todo.length; from += BATCH) {
            const batch = todo.slice(from, from + BATCH)
            if (!this.batchGrants) {
                for (const i of batch) await viaRest(i)
                continue
            }
            const fields = batch.map((i, n) => {
                const { slug, repo, permission } = grants[i]
                const input = { repositoryId: s.repos.get(lc(repo))!.id, teamIds: [s.teams.get(slug)!.id], permission: toGraphQL[permission] }
                return `m${n}: updateTeamsRepository(input: {repositoryId: ${JSON.stringify(input.repositoryId)}, teamIds: ${JSON.stringify(input.teamIds)}, permission: ${input.permission}}) { clientMutationId }`
            })
            let data: any
            let errors: any[] = []
            try {
                ;({ data, errors } = await this.gql(`mutation Grants { ${fields.join(' ')} }`))
            } catch (error) {
                if (error instanceof GitHubError && error.status === 403 && error.code !== 'GITHUB_RATE_LIMITED') {
                    this.batchGrants = false
                    for (const i of batch) await viaRest(i)
                    continue
                }
                for (const i of batch) results[i] = error as Error
                continue
            }
            for (const [n, i] of batch.entries()) {
                const aliasErrors = errors.filter((e: any) => !e.path || e.path[0] === `m${n}`)
                if (data?.[`m${n}`] && !aliasErrors.length) apply(i)
                else if (aliasErrors.some((e: any) => statusOf(e.type) === 429)) {
                    results[i] = new GitHubError(429, aliasErrors.map((e: any) => e.message).join('; '))
                }
                else {
                    this.batchGrants = false
                    await viaRest(i)
                }
            }
        }
        return results
    }

    /** Direct Admin for active org members only; no repo invitations. */
    async grantDirectAdmin(repo: string, login: string): Promise<void> {
        const s = await this.state()
        const id = lc(login)
        const state = s.repos.get(lc(repo))
        if (!state) throw new GitHubError(404, `Repository ${repo} does not exist`)
        if (s.members.get(id)?.state !== 'active' || state.direct.get(id) === 'admin') return

        const res = await this.octokit.rest.repos.addCollaborator({
            owner: this.org, repo, username: login, permission: 'admin',
        })
        if (Number(res.status) !== 204) throw new Error(`GitHub invited ${login} to ${repo} instead of adding them`)
        state.direct.set(id, 'admin')
    }

    /** Removes a user's direct access to a repo (team and org access are unaffected). */
    async removeDirect(repo: string, login: string): Promise<void> {
        const id = lc(login)
        const state = (await this.state()).repos.get(lc(repo))
        if (!state?.direct.has(id)) return

        await this.octokit.rest.repos.removeCollaborator({ owner: this.org, repo, username: login })
        state.direct.delete(id)
    }
}
