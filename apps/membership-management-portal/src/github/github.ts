import { createAppAuth } from '@octokit/auth-app'

// The GitHub App must be owned by GITHUB_ORG and installed on it. App ID, installation ID,
// and private key are secrets (wrangler secret put …); GITHUB_ORG is in wrangler.jsonc vars.
export interface Env {
    GITHUB_ORG: string // e.g. "Longhorn-Developers"
    GITHUB_APP_ID: string
    GITHUB_APP_INSTALLATION_ID: string
    GITHUB_APP_PRIVATE_KEY: string // PKCS#8 PEM ("BEGIN PRIVATE KEY"); escaped \n is fine
}

// ============================================================
// Low-level GitHub REST helpers
// https://docs.github.com/en/rest/orgs/members
// https://docs.github.com/en/rest/teams/members
// ============================================================

const API = 'https://api.github.com'

export type OrgMembership = {
    state: 'active' | 'pending' // pending = invited, not yet accepted
    role: 'admin' | 'member' | 'billing_manager'
}

export type TeamRole = 'member' | 'maintainer'

// API names for repository roles; the GitHub UI calls `push` "Write".
export type RepoPermission = 'pull' | 'triage' | 'push' | 'maintain' | 'admin'

export type GitHubTeam = { id: number; slug: string; name: string }

export type GitHubRepo = {
    name: string
    archived: boolean
    fork: boolean
    // On team repository lists, the team's access; on other lists, the app's.
    permissions?: Record<'admin' | 'maintain' | 'push' | 'triage' | 'pull', boolean>
}

export type TeamMembership = { state: 'active' | 'pending'; role: TeamRole }

export type Collaborator = { login: string; role_name: string }

export class GitHubError extends Error {
    constructor(
        public status: number,
        message: string,
    ) {
        super(message)
    }
}

// ============================================================
// Authentication: GitHub App installation tokens
// https://github.com/octokit/auth-app.js
// ============================================================

// One auth instance per app installation, kept for the isolate's lifetime. It caches the
// installation token (valid 1 hour) and requests a new one shortly before it expires.
const auths = new Map<string, ReturnType<typeof createAppAuth>>()

async function installationToken(env: Env, refresh = false): Promise<string> {
    // GitHub downloads keys as PKCS#1, but Workers' Web Crypto only accepts PKCS#8.
    if (env.GITHUB_APP_PRIVATE_KEY.includes('BEGIN RSA PRIVATE KEY')) {
        throw new GitHubError(
            401,
            'GITHUB_APP_PRIVATE_KEY is PKCS#1; convert it with `openssl pkcs8 -topk8 -nocrypt`',
        )
    }

    const cacheKey = `${env.GITHUB_APP_ID}:${env.GITHUB_APP_INSTALLATION_ID}`
    let auth = auths.get(cacheKey)
    if (!auth) {
        auth = createAppAuth({
            appId: env.GITHUB_APP_ID,
            privateKey: env.GITHUB_APP_PRIVATE_KEY,
            installationId: env.GITHUB_APP_INSTALLATION_ID,
        })
        auths.set(cacheKey, auth)
    }

    const { token } = await auth({ type: 'installation', refresh })
    if (!token) throw new GitHubError(401, 'GitHub did not return an installation token')
    return token
}

/** Returns null on 404; throws GitHubError on any other failure. */
async function github<T>(
    env: Env,
    method: string,
    path: string,
    body?: unknown,
    retry = true,
    refreshToken = false,
): Promise<T | null> {
    const token = await installationToken(env, refreshToken)
    const res = await fetch(`${API}${path}`, {
        method,
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2026-03-10',
            'User-Agent': 'lhd-membership-worker', // required; requests without one are rejected
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
    })

    if (res.status === 404) return null

    if (!res.ok) {
        // A cached token can be revoked early (e.g. the app was reinstalled); retry with a new one.
        if (res.status === 401 && retry) {
            return github(env, method, path, body, false, true)
        }

        const retryAfter = res.headers.get('retry-after')
        if ((res.status === 429 || res.status === 403) && retryAfter && retry) {
            await new Promise((r) => setTimeout(r, Number(retryAfter) * 1000))
            return github(env, method, path, body, false)
        }

        // GitHub errors are { message: string }; fall back if the body is anything else.
        const err: unknown = await res.json().catch(() => null)
        const message =
            typeof err === 'object' &&
            err !== null &&
            'message' in err &&
            typeof err.message === 'string'
                ? err.message
                : `GitHub returned ${res.status}`
        throw new GitHubError(res.status, message)
    }

    // Unchecked on purpose: callers pass the documented response type as T. Validating every
    // response at runtime (e.g. with zod) isn't worth it for this internal tool.
    return (res.status === 204 ? undefined : await res.json()) as T
}

/** Fetches every page of a list endpoint; returns null if the list itself is a 404. */
async function githubList<T>(env: Env, path: string): Promise<T[] | null> {
    const results: T[] = []
    const separator = path.includes('?') ? '&' : '?'
    for (let page = 1; ; page++) {
        const items = await github<T[]>(env, 'GET', `${path}${separator}per_page=100&page=${page}`)
        if (!items) return page === 1 ? null : results
        results.push(...items)
        if (items.length < 100) return results
    }
}

const org = (env: Env) => `/orgs/${encodeURIComponent(env.GITHUB_ORG)}`
const user = (username: string) => encodeURIComponent(username)
const team = (env: Env, slug: string) => `${org(env)}/teams/${encodeURIComponent(slug)}`
const repo = (env: Env, name: string) =>
    `/repos/${encodeURIComponent(env.GITHUB_ORG)}/${encodeURIComponent(name)}`

// ============================================================
// Organization membership
// ============================================================

/** Returns null when the user is neither a member nor invited. */
export async function getOrgMembership(env: Env, username: string): Promise<OrgMembership | null> {
    return github<OrgMembership>(env, 'GET', `${org(env)}/memberships/${user(username)}`)
}

/**
 * Invites a user to the org (GitHub emails them; they must accept).
 * Existing members and pending invites are left untouched, so owners are never demoted.
 */
export async function inviteToOrg(env: Env, username: string): Promise<OrgMembership> {
    const existing = await getOrgMembership(env, username)
    if (existing) return existing

    const membership = await github<OrgMembership>(
        env,
        'PUT',
        `${org(env)}/memberships/${user(username)}`,
        {
            role: 'member',
        },
    )
    if (!membership) {
        throw new GitHubError(404, `GitHub user ${username} does not exist`)
    }
    return membership
}

/**
 * Removes a member from the org and all its teams, or cancels their pending invite.
 * Refuses to remove org owners. Returns false if they had no membership.
 */
export async function removeFromOrg(env: Env, username: string): Promise<boolean> {
    const existing = await getOrgMembership(env, username)
    if (!existing) return false
    if (existing.role === 'admin') {
        throw new GitHubError(403, `${username} is an org owner; remove them manually`)
    }

    await github(env, 'DELETE', `${org(env)}/memberships/${user(username)}`)
    return true
}

// ============================================================
// Team membership (team_slug is the team's URL name, e.g. "portal")
// ============================================================

/** Returns null when the user is neither on the team nor invited to it. */
export async function getTeamMembership(
    env: Env,
    username: string,
    teamSlug: string,
): Promise<TeamMembership | null> {
    return github<TeamMembership>(
        env,
        'GET',
        `${team(env, teamSlug)}/memberships/${user(username)}`,
    )
}

/**
 * Adds a user to a team or updates their team role; maintainers can manage the team.
 * If they aren't in the org yet, GitHub invites them and the membership stays pending.
 * GitHub may keep a different role (org owners are always maintainers); the result says which.
 */
export async function addToTeam(
    env: Env,
    username: string,
    teamSlug: string,
    role: TeamRole = 'member',
): Promise<TeamMembership> {
    const membership = await github<TeamMembership>(
        env,
        'PUT',
        `${team(env, teamSlug)}/memberships/${user(username)}`,
        { role },
    )
    if (!membership) {
        throw new GitHubError(404, `Team ${teamSlug} or user ${username} does not exist`)
    }
    return membership
}

/** Removes a user from a team (they stay in the org). Returns false if they weren't on it. */
export async function removeFromTeam(
    env: Env,
    username: string,
    teamSlug: string,
): Promise<boolean> {
    const path = `${team(env, teamSlug)}/memberships/${user(username)}`
    if (!(await github(env, 'GET', path))) return false

    await github(env, 'DELETE', path)
    return true
}

/** Lists the logins of a team's active members and maintainers; null if the team is missing. */
export async function listTeamMembers(env: Env, teamSlug: string): Promise<string[] | null> {
    const members = await githubList<{ login: string }>(env, `${team(env, teamSlug)}/members`)
    return members && members.map((member) => member.login)
}

// ============================================================
// Teams
// ============================================================

/** Returns null when no team has this slug. */
export async function getTeam(env: Env, teamSlug: string): Promise<GitHubTeam | null> {
    return github<GitHubTeam>(env, 'GET', team(env, teamSlug))
}

/** Creates a team visible to all org members; GitHub derives the slug from the name. */
export async function createTeam(env: Env, name: string): Promise<GitHubTeam> {
    const created = await github<GitHubTeam>(env, 'POST', `${org(env)}/teams`, {
        name,
        privacy: 'closed',
    })
    if (!created) {
        throw new GitHubError(404, `Organization ${env.GITHUB_ORG} does not exist`)
    }
    return created
}

// ============================================================
// Repositories
// https://docs.github.com/en/rest/repos/repos
// https://docs.github.com/en/rest/collaborators/collaborators
// ============================================================

/** Returns null when the org has no repository with this name. */
export async function getRepo(env: Env, repoName: string): Promise<GitHubRepo | null> {
    return github<GitHubRepo>(env, 'GET', repo(env, repoName))
}

export async function listOrgRepos(env: Env): Promise<GitHubRepo[]> {
    return (await githubList<GitHubRepo>(env, `${org(env)}/repos?type=all`)) ?? []
}

/** Lists the repositories a team has access to; null if the team is missing. */
export async function listTeamRepos(env: Env, teamSlug: string): Promise<GitHubRepo[] | null> {
    return githubList<GitHubRepo>(env, `${team(env, teamSlug)}/repos`)
}

/** The highest role a permissions object grants. */
export function roleOf(permissions: GitHubRepo['permissions']): RepoPermission | null {
    if (!permissions) return null
    const roles: RepoPermission[] = ['admin', 'maintain', 'push', 'triage', 'pull']
    return roles.find((role) => permissions[role]) ?? null
}

/** Grants a team a role on an org repository, or changes its existing role. */
export async function setTeamRepoPermission(
    env: Env,
    teamSlug: string,
    repoName: string,
    permission: RepoPermission,
): Promise<void> {
    const path = `${team(env, teamSlug)}/repos/${encodeURIComponent(env.GITHUB_ORG)}/${encodeURIComponent(repoName)}`
    if ((await github(env, 'PUT', path, { permission })) === null) {
        throw new GitHubError(404, `Team ${teamSlug} or repository ${repoName} does not exist`)
    }
}

/** Removes a team's access to a repository; the repository itself is untouched. */
export async function removeTeamRepo(env: Env, teamSlug: string, repoName: string): Promise<void> {
    const path = `${team(env, teamSlug)}/repos/${encodeURIComponent(env.GITHUB_ORG)}/${encodeURIComponent(repoName)}`
    await github(env, 'DELETE', path)
}

/**
 * Lists users granted access to the repository directly (not through a team).
 * role_name is the user's highest role from any source.
 */
export async function listDirectCollaborators(env: Env, repoName: string): Promise<Collaborator[]> {
    return (
        (await githubList<Collaborator>(
            env,
            `${repo(env, repoName)}/collaborators?affiliation=direct`,
        )) ?? []
    )
}

/**
 * Grants a user a direct role on a repository, or changes their existing role.
 * Org members are added immediately; anyone else gets an invitation.
 */
export async function setCollaboratorPermission(
    env: Env,
    repoName: string,
    username: string,
    permission: RepoPermission,
): Promise<void> {
    const path = `${repo(env, repoName)}/collaborators/${user(username)}`
    if ((await github(env, 'PUT', path, { permission })) === null) {
        throw new GitHubError(404, `Repository ${repoName} or user ${username} does not exist`)
    }
}

/** Removes a user's direct access; access through teams or org roles is unaffected. */
export async function removeCollaborator(
    env: Env,
    repoName: string,
    username: string,
): Promise<void> {
    await github(env, 'DELETE', `${repo(env, repoName)}/collaborators/${user(username)}`)
}
