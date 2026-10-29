import {
    assignRepo,
    getTeam,
    getTeamMembers,
    listRepoAssignments,
    listTeamRepos,
    listTeams,
    listUsers,
    setGithubTeamSlug,
    unassignRepo,
} from '../db/access'
import type { Team } from '../db/access'
import * as gh from './github'
import type { Env as GitHubEnv, RepoPermission, TeamRole } from './github'

export type Env = GitHubEnv & {
    membership_db: D1Database
    GITHUB_EXEC_TEAM: string // slug of the exec team, e.g. "exec" (wrangler.jsonc vars)
}

/**
 * What a sync changed, what it found but left for a person to decide, and the user changes it
 * couldn't make. Permissions that were already correct aren't listed, so re-running a sync with
 * no D1 changes reports no changes.
 */
export type SyncReport = {
    changes: string[]
    flags: string[]
    errors: SyncError[]
}

export type SyncErrorCode =
    | 'GITHUB_USER_NOT_FOUND'
    | 'GITHUB_FORBIDDEN'
    | 'GITHUB_RATE_LIMITED'
    | 'GITHUB_VALIDATION_FAILED'
    | 'GITHUB_UNAVAILABLE'
    | 'GITHUB_ERROR'

export type SyncOperation =
    | 'add_to_team'
    | 'remove_from_team'
    | 'grant_repo_admin'
    | 'remove_repo_admin'

/**
 * A user change the sync couldn't make. Resolve it automatically by passing it to retryError,
 * or manually by following `fix` in GitHub.
 */
export type SyncError = {
    code: SyncErrorCode
    operation: SyncOperation
    githubLogin: string // lowercased
    target: string // GitHub team slug or repository name
    scope: string // what retryError re-syncs: a team ID, the exec team, or an unassigned repo
    message: string // GitHub's error message
    retryable: boolean // whether retrying can work without changing anything first
    fix: string // what to do about it
}

/** How to handle each error code. */
export const errorHelp: Record<SyncErrorCode, { retryable: boolean; fix: string }> = {
    GITHUB_USER_NOT_FOUND: {
        retryable: false,
        fix: "GitHub has no user with this login. Correct the user's github_id in D1, then retry.",
    },
    GITHUB_FORBIDDEN: {
        retryable: false,
        fix: 'GitHub refused the app. Check it has Members and Administration read/write and is installed on all repositories, then retry.',
    },
    GITHUB_RATE_LIMITED: {
        retryable: true,
        fix: 'GitHub rate limit. Retry after a few minutes.',
    },
    GITHUB_VALIDATION_FAILED: {
        retryable: false,
        fix: 'GitHub rejected the change (e.g. no free org seats, or the user blocked the org). Fix it in GitHub by hand; retrying confirms it.',
    },
    GITHUB_UNAVAILABLE: {
        retryable: true,
        fix: 'GitHub or the network failed. Retry.',
    },
    GITHUB_ERROR: {
        retryable: true,
        fix: 'Unexpected GitHub error; see the message. Retrying may work.',
    },
}

// A report being built for one scope, which is stamped onto its errors.
type Draft = SyncReport & { scope: string }

const merge = (target: SyncReport, source: SyncReport) => {
    target.changes.push(...source.changes)
    target.flags.push(...source.flags)
    target.errors.push(...source.errors)
}

// Error scopes for the exec team and for repositories removed from their team.
const EXEC_SCOPE = 'exec-team'
const UNASSIGNED_PREFIX = 'unassigned-repo:'

/** Classifies a failed GitHub call. Bad credentials fail every call, so they abort the sync. */
function classify(error: unknown): Pick<SyncError, 'code' | 'message'> {
    if (!(error instanceof gh.GitHubError)) {
        return { code: 'GITHUB_UNAVAILABLE', message: String(error) }
    }
    const code: SyncErrorCode | null =
        error.status === 401
            ? null
            : error.status === 404
              ? 'GITHUB_USER_NOT_FOUND'
              : error.status === 429 || (error.status === 403 && /rate limit/i.test(error.message))
                ? 'GITHUB_RATE_LIMITED'
                : error.status === 403
                  ? 'GITHUB_FORBIDDEN'
                  : error.status === 422
                    ? 'GITHUB_VALIDATION_FAILED'
                    : error.status >= 500
                      ? 'GITHUB_UNAVAILABLE'
                      : 'GITHUB_ERROR'
    if (!code) throw error
    return { code, message: error.message }
}

/**
 * Makes one change to a user's access. A failure is recorded and the sync carries on.
 * `change` returns the report line, or null if nothing needed changing.
 */
async function attempt(
    report: Draft,
    failure: Pick<SyncError, 'operation' | 'githubLogin' | 'target'>,
    change: () => Promise<string | null>,
): Promise<void> {
    try {
        const line = await change()
        if (line) report.changes.push(line)
    } catch (error) {
        const { code, message } = classify(error)
        report.errors.push({
            ...failure,
            githubLogin: key(failure.githubLogin),
            scope: report.scope,
            code,
            message,
            ...errorHelp[code],
        })
    }
}

/** Runs a sync of one scope (a team ID, the exec team, or an unassigned repository). */
async function inScope(scope: string, run: (report: Draft) => Promise<void>): Promise<SyncReport> {
    const draft: Draft = { changes: [], flags: [], errors: [], scope }
    await run(draft)
    return { changes: draft.changes, flags: draft.flags, errors: draft.errors }
}

// GitHub logins are case-insensitive.
const key = (login: string) => login.toLowerCase()

// ============================================================
// Desired state, from D1
// ============================================================

/**
 * Active dev (tech vertical) members of a team and their GitHub team role:
 * dev leads are maintainers, dev fellows are members.
 */
async function devRoles(env: Env, teamId: string): Promise<Map<string, TeamRole>> {
    const roles = new Map<string, TeamRole>()
    for (const { user, verticals } of await getTeamMembers(env.membership_db, teamId)) {
        const dev = verticals.find((assignment) => assignment.vertical === 'tech')
        if (user.status !== 'active' || !dev) continue
        roles.set(key(user.githubId), dev.isLead ? 'maintainer' : 'member')
    }
    return roles
}

const leadsOf = (roles: Map<string, TeamRole>) =>
    [...roles].filter(([, role]) => role === 'maintainer').map(([login]) => login)

/** Logins of everyone in D1, so sync only removes LHD members and flags anyone else. */
async function knownLogins(env: Env): Promise<Set<string>> {
    return new Set((await listUsers(env.membership_db)).map((user) => key(user.githubId)))
}

/** A team's current role on each of its repositories, keyed by lowercased repo name. */
async function teamRepoRoles(env: Env, slug: string): Promise<Map<string, RepoPermission | null>> {
    const repos = (await gh.listTeamRepos(env, slug)) ?? []
    return new Map(repos.map((repo) => [key(repo.name), gh.roleOf(repo.permissions)]))
}

async function requireTeam(env: Env, teamId: string): Promise<Team> {
    const team = await getTeam(env.membership_db, teamId)
    if (!team) throw new Error(`Team ${teamId} not found`)
    return team
}

// ============================================================
// Teams
// ============================================================

/** Returns the team's GitHub slug, creating the GitHub team (and recording it) if needed. */
async function ensureGithubTeam(env: Env, team: Team, report: Draft): Promise<string> {
    if (team.githubTeamSlug && (await gh.getTeam(env, team.githubTeamSlug))) {
        return team.githubTeamSlug
    }

    // Link a GitHub team someone already made by hand instead of failing on the duplicate name.
    const existing = await gh.getTeam(env, slugify(team.name))
    if (existing) {
        await setGithubTeamSlug(env.membership_db, team.id, existing.slug)
        report.changes.push(`Linked existing GitHub team ${existing.slug} to ${team.name}`)
        return existing.slug
    }

    const created = await gh.createTeam(env, team.name)
    await setGithubTeamSlug(env.membership_db, team.id, created.slug)
    report.changes.push(`Created GitHub team ${created.slug} for ${team.name}`)
    return created.slug
}

// Approximates how GitHub derives a team slug from its name, e.g. "Portal Web" -> "portal-web".
const slugify = (name: string) =>
    name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')

/**
 * Makes a team's GitHub team match D1: creates it if needed, adds dev fellows as members and
 * dev leads as maintainers, removes LHD members who no longer belong, and syncs its repos.
 * Accounts not in D1 and repos not assigned in D1 are flagged, never changed.
 */
export async function syncTeam(env: Env, teamId: string): Promise<SyncReport> {
    const team = await requireTeam(env, teamId)
    return inScope(teamId, async (report) => {
        const slug = await ensureGithubTeam(env, team, report)
        if (key(slug) === key(env.GITHUB_EXEC_TEAM)) {
            throw new Error(
                `${team.name} uses the exec team's slug; the exec team is synced separately`,
            )
        }
        const roles = await devRoles(env, teamId)
        const known = await knownLogins(env)
        await syncMembers(env, slug, roles, known, report)

        const repos = await listTeamRepos(env.membership_db, teamId)
        const current = await teamRepoRoles(env, slug)
        for (const repoName of repos) {
            await syncRepo(env, repoName, slug, leadsOf(roles), known, current, report)
        }

        const assigned = new Set(repos.map(key))
        for (const repo of (await gh.listTeamRepos(env, slug)) ?? []) {
            if (!assigned.has(key(repo.name))) {
                report.flags.push(
                    `${repo.name} is on ${slug} in GitHub but not assigned to it in D1`,
                )
            }
        }
    })
}

/**
 * Gives everyone in `roles` their team role, and removes LHD members who aren't in it.
 * Accounts not in D1 are flagged, never removed.
 */
async function syncMembers(
    env: Env,
    slug: string,
    roles: Map<string, TeamRole>,
    known: Set<string>,
    report: Draft,
): Promise<void> {
    for (const [login, role] of roles) {
        await attempt(
            report,
            { operation: 'add_to_team', githubLogin: login, target: slug },
            async () => {
                const before = await gh.getTeamMembership(env, login, slug)
                if (before?.role === role) return null
                // GitHub can keep a different role (org owners stay maintainers); only report real changes.
                const after = await gh.addToTeam(env, login, slug, role)
                if (before?.role === after.role) return null
                return `${login} is a ${after.role} of ${slug}${after.state === 'pending' ? ' (invited)' : ''}`
            },
        )
    }

    for (const login of (await gh.listTeamMembers(env, slug)) ?? []) {
        if (roles.has(key(login))) continue
        if (known.has(key(login))) {
            await attempt(
                report,
                { operation: 'remove_from_team', githubLogin: login, target: slug },
                async () => {
                    await gh.removeFromTeam(env, login, slug)
                    return `Removed ${login} from ${slug}`
                },
            )
        } else {
            report.flags.push(`${login} is on ${slug} but is not in the membership database`)
        }
    }
}

/**
 * Makes the exec team match D1: active users with is_exec are members, and the team has
 * Admin on every non-archived org repository (re-applied each sync, so new repos are covered).
 * The exec team is not a project team, so it isn't in the teams table.
 */
export async function syncExecTeam(env: Env): Promise<SyncReport> {
    return inScope(EXEC_SCOPE, (report) => syncExec(env, report))
}

async function syncExec(env: Env, report: Draft): Promise<void> {
    let slug = env.GITHUB_EXEC_TEAM
    if (!(await gh.getTeam(env, slug))) {
        slug = (await gh.createTeam(env, env.GITHUB_EXEC_TEAM)).slug
        report.changes.push(`Created GitHub team ${slug} for execs`)
        if (slug !== env.GITHUB_EXEC_TEAM) {
            report.flags.push(`GitHub named the exec team ${slug}; set GITHUB_EXEC_TEAM to match`)
        }
    }

    const roles = new Map<string, TeamRole>()
    for (const user of await listUsers(env.membership_db)) {
        if (user.isExec && user.status === 'active') roles.set(key(user.githubId), 'member')
    }
    await syncMembers(env, slug, roles, await knownLogins(env), report)

    const current = await teamRepoRoles(env, slug)
    const missing = (await gh.listOrgRepos(env)).filter(
        (repo) => !repo.archived && current.get(key(repo.name)) !== 'admin',
    )
    for (const repo of missing) {
        await gh.setTeamRepoPermission(env, slug, repo.name, 'admin')
    }
    if (missing.length) {
        report.changes.push(
            `${slug} now has Admin on ${missing.map((repo) => repo.name).join(', ')}`,
        )
    }
}

// ============================================================
// Repositories
// ============================================================

/**
 * Gives the team Write and each of its dev leads Admin on a repository, and removes direct
 * Admin from LHD members who aren't leads (e.g. a previous lead). Org owners are never touched.
 * `teamRoles` is the team's current role per repository, from teamRepoRoles.
 */
async function syncRepo(
    env: Env,
    repoName: string,
    slug: string,
    leads: string[],
    known: Set<string>,
    teamRoles: Map<string, RepoPermission | null>,
    report: Draft,
): Promise<void> {
    if (teamRoles.get(key(repoName)) !== 'push') {
        await gh.setTeamRepoPermission(env, slug, repoName, 'push')
        report.changes.push(`${repoName}: ${slug} now has Write`)
    }

    // role_name is a collaborator's highest role from any source, so a lead who already has
    // Admin (directly, or as an org owner or exec) isn't granted it again.
    const collaborators = await gh.listDirectCollaborators(env, repoName)
    const admins = new Set(
        collaborators.filter((c) => c.role_name === 'admin').map((c) => key(c.login)),
    )
    for (const lead of leads.filter((lead) => !admins.has(lead))) {
        await attempt(
            report,
            { operation: 'grant_repo_admin', githubLogin: lead, target: repoName },
            async () => {
                await gh.setCollaboratorPermission(env, repoName, lead, 'admin')
                return `${repoName}: ${lead} now has Admin`
            },
        )
    }

    const leadSet = new Set(leads)
    for (const { login, role_name } of collaborators) {
        if (leadSet.has(key(login))) continue
        if (!known.has(key(login))) {
            report.flags.push(
                `${login} has direct ${role_name} access to ${repoName} but is not in D1`,
            )
        } else if (role_name === 'admin') {
            await attempt(
                report,
                { operation: 'remove_repo_admin', githubLogin: login, target: repoName },
                async () => {
                    if ((await gh.getOrgMembership(env, login))?.role === 'admin') return null
                    await gh.removeCollaborator(env, repoName, login)
                    return `${repoName}: removed direct Admin from ${login} (not a lead)`
                },
            )
        }
    }
}

/**
 * Assigns an org repository to a team and applies its permissions. If another team had it, that
 * team loses access and its leads lose Admin. Unknown repository names reject the promise.
 */
export async function assignRepoToTeam(
    env: Env,
    teamId: string,
    repoName: string,
): Promise<SyncReport> {
    const team = await requireTeam(env, teamId)
    const repo = await gh.getRepo(env, repoName)
    if (!repo) throw new Error(`${env.GITHUB_ORG} has no repository named ${repoName}`)

    return inScope(teamId, async (report) => {
        const slug = await ensureGithubTeam(env, team, report)
        const previousTeamId = await assignRepo(env.membership_db, teamId, repo.name)
        if (previousTeamId) {
            const previous = await getTeam(env.membership_db, previousTeamId)
            if (previous?.githubTeamSlug) {
                await gh.removeTeamRepo(env, previous.githubTeamSlug, repo.name)
                report.changes.push(`${repo.name}: removed ${previous.githubTeamSlug}`)
            }
        }

        const roles = await devRoles(env, teamId)
        const known = await knownLogins(env)
        const current = await teamRepoRoles(env, slug)
        await syncRepo(env, repo.name, slug, leadsOf(roles), known, current, report)
    })
}

/**
 * Unassigns a repository: its team loses access and LHD members lose direct Admin.
 * The repository then shows up as orphaned until it is assigned again.
 */
export async function unassignRepoFromTeam(env: Env, repoName: string): Promise<SyncReport> {
    const teamId = await unassignRepo(env.membership_db, repoName)
    if (!teamId) return { changes: [], flags: [], errors: [] }

    return inScope(UNASSIGNED_PREFIX + repoName, async (report) => {
        const team = await getTeam(env.membership_db, teamId)
        if (team?.githubTeamSlug) {
            await gh.removeTeamRepo(env, team.githubTeamSlug, repoName)
            report.changes.push(`${repoName}: removed ${team.githubTeamSlug}`)
        }
        await removeMemberAdmins(env, repoName, report)
    })
}

/** Removes direct Admin from LHD members (except org owners) on an unassigned repository. */
async function removeMemberAdmins(env: Env, repoName: string, report: Draft): Promise<void> {
    const known = await knownLogins(env)
    for (const { login, role_name } of await gh.listDirectCollaborators(env, repoName)) {
        if (!known.has(key(login)) || role_name !== 'admin') continue
        await attempt(
            report,
            { operation: 'remove_repo_admin', githubLogin: login, target: repoName },
            async () => {
                if ((await gh.getOrgMembership(env, login))?.role === 'admin') return null
                await gh.removeCollaborator(env, repoName, login)
                return `${repoName}: removed direct Admin from ${login}`
            },
        )
    }
}

/**
 * Flags orphaned repositories (active, non-fork org repos assigned to no team) and
 * assignments whose repository no longer exists. Changes nothing.
 */
export async function auditRepos(env: Env): Promise<SyncReport> {
    const report: SyncReport = { changes: [], flags: [], errors: [] }
    const orgRepos = await gh.listOrgRepos(env)
    const assigned = new Map(
        (await listRepoAssignments(env.membership_db)).map((row) => [key(row.repoName), row]),
    )

    for (const repo of orgRepos) {
        if (repo.archived || repo.fork) continue
        if (!assigned.has(key(repo.name))) {
            report.flags.push(`Orphaned repository: ${repo.name} is not assigned to any team`)
        }
    }

    const existing = new Set(orgRepos.map((repo) => key(repo.name)))
    for (const [name, row] of assigned) {
        if (!existing.has(name)) {
            report.flags.push(`${row.repoName} is assigned to ${row.teamId} but no longer exists`)
        }
    }

    return report
}

/** Syncs every project team and the exec team, then audits for orphaned repositories. */
export async function syncAll(env: Env): Promise<SyncReport> {
    const report: SyncReport = { changes: [], flags: [], errors: [] }
    for (const team of await listTeams(env.membership_db)) {
        merge(report, await syncTeam(env, team.id))
    }
    merge(report, await syncExecTeam(env))
    merge(report, await auditRepos(env))
    return report
}

// ============================================================
// Retrying errors
// ============================================================

/**
 * Resolves a SyncError automatically: re-syncs its scope (its team, the exec team, or the
 * unassigned repository), reading D1 again, so fixing D1 first (e.g. a user's github_id) works
 * too. `resolved` is true if the same change didn't fail again, because it worked or is no longer
 * needed. The report covers the whole re-sync.
 */
export async function retryError(
    env: Env,
    error: Pick<SyncError, 'scope' | 'operation' | 'githubLogin' | 'target'>,
): Promise<{ resolved: boolean; report: SyncReport }> {
    let report: SyncReport
    if (error.scope === EXEC_SCOPE) {
        report = await syncExecTeam(env)
    } else if (error.scope.startsWith(UNASSIGNED_PREFIX)) {
        const repoName = error.scope.slice(UNASSIGNED_PREFIX.length)
        const reassigned = (await listRepoAssignments(env.membership_db)).some(
            (row) => key(row.repoName) === key(repoName),
        )
        // Once the repository has a team again, that team's sync owns its permissions.
        report = await inScope(error.scope, async (draft) => {
            if (!reassigned) await removeMemberAdmins(env, repoName, draft)
        })
    } else {
        report = await syncTeam(env, error.scope)
    }

    const resolved = !report.errors.some(
        (e) =>
            e.operation === error.operation &&
            e.githubLogin === key(error.githubLogin) &&
            e.target === error.target,
    )
    return { resolved, report }
}
