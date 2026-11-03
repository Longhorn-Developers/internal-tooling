import {
    assignRepo,
    getTeam,
    getTeamMembers,
    getUserById,
    listRepoAssignments,
    listTeamRepos,
    listTeams,
    listUsers,
    setGithubTeamSlug,
    unassignRepo,
} from '../db/access'
import type { Team, User } from '../db/access'
import type { Vertical } from '../db/schema'
import { Service } from '../services/service'
import type { ExecRole, NeededChange } from '../services/service'
import * as gh from './github-api'
import type { Env as GitHubApiEnv, RepoPermission, TeamRole } from './github-api'

export type Env = GitHubApiEnv & {
    membership_db: D1Database
    GITHUB_EXEC_TEAM: string // slug of the exec team, e.g. "exec" (wrangler.jsonc vars)
}

/** The NeededChange kinds GitHubService reports; see the README for what each means. */
export type GitHubChangeKind =
    // fixTeam makes these
    | 'create_team'
    | 'grant_team_repo'
    | 'remove_team_member'
    | 'remove_repo_admin'
    | 'create_exec_team'
    | 'grant_exec_repo_admin'
    | 'add_exec_member'
    | 'remove_exec_member'
    // these need a person
    | 'github_user_not_found'
    | 'missing_repo'
    | 'unknown_account'
    | 'extra_team_repo'
    | 'orphan_repo'
    | 'team_slug_conflict'

const fixableKinds = new Set<string>([
    'create_team',
    'grant_team_repo',
    'remove_team_member',
    'remove_repo_admin',
    'create_exec_team',
    'grant_exec_repo_admin',
    'add_exec_member',
    'remove_exec_member',
])

// GitHub logins are case-insensitive.
const key = (login: string) => login.toLowerCase()

// Approximates how GitHub derives a team slug from its name, e.g. "Portal Web" -> "portal-web".
const slugify = (name: string) =>
    name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')

type DevMember = { userId: string; role: TeamRole }

/**
 * Keeps the GitHub org in sync with D1:
 * - Each team has a GitHub team with Write on the team's repositories (team_repos).
 * - Active tech members are on it: dev leads as maintainers with direct Admin on the team's
 *   repositories, dev fellows as members. Other verticals get no GitHub access.
 * - Active execs are on the exec team, which has Admin on every non-archived repository.
 * - Accounts not in D1 are reported, never removed. Org owners never lose access.
 */
export class GitHubService extends Service<Env> {
    readonly name = 'github'

    // ============================================================
    // Service actions
    // ============================================================

    async addUserToTeam(
        userId: string,
        teamId: string,
        vertical: Vertical,
        isLead: boolean,
    ): Promise<NeededChange[]> {
        // Only active dev members get GitHub access; syncUsers adds others once they qualify.
        const user = await this.user(userId)
        if (vertical !== 'tech' || user.status !== 'active') return []

        const { slug, needed } = await this.checkTeamSetup(await this.team(teamId))
        needed.push(...(await this.checkAccounts([user])))
        if (needed.length || !slug) return needed

        await this.applyMember(user.githubId, slug, teamId, isLead ? 'maintainer' : 'member')
        return []
    }

    async removeUserFromTeam(userId: string, teamId: string): Promise<void> {
        const user = await getUserById(this.db, userId)
        const team = await getTeam(this.db, teamId)
        if (!user || !team) return
        await this.removeMember(user.githubId, team)
    }

    /** Invites the user to the org; members and pending invites are left as they are. */
    async onboardUser(
        _name: string,
        _email: string,
        github: string,
        _discord: string,
    ): Promise<NeededChange[]> {
        if (!(await gh.userExists(this.env, github))) {
            return [this.change('github_user_not_found', github, this.notFound(github))]
        }
        await gh.inviteToOrg(this.env, github)
        return []
    }

    /**
     * Removes the user from the org, which also removes their team memberships and repository
     * access. Org owners can't be removed by the app, so they are only taken off LHD's teams.
     */
    async deactivateUser(userId: string): Promise<void> {
        const user = await getUserById(this.db, userId)
        if (!user) return
        const login = user.githubId

        if (!(await this.isOwner(login))) {
            await gh.removeFromOrg(this.env, login)
            return
        }
        for (const team of await listTeams(this.db)) {
            if (team.githubTeamSlug) await gh.removeFromTeam(this.env, login, team.githubTeamSlug)
        }
        await gh.removeFromTeam(this.env, login, this.execSlug)
    }

    /** Adds the user to the exec team. Every exec role gets the same GitHub access. */
    async makeExec(userId: string, _execRole: ExecRole): Promise<NeededChange[]> {
        const user = await this.user(userId)
        const needed = await this.checkExecSetup()
        needed.push(...(await this.checkAccounts([user])))
        if (needed.length) return needed

        await gh.addToTeam(this.env, user.githubId, this.execSlug)
        return []
    }

    async removeExec(userId: string, _execRole: ExecRole): Promise<void> {
        const user = await getUserById(this.db, userId)
        if (user) await gh.removeFromTeam(this.env, user.githubId, this.execSlug)
    }

    /**
     * Creates the team's GitHub team, or links one with the same name made by hand, saves its
     * slug, and gives it Write on the team's repositories. Members are added by syncUsers.
     */
    async createTeam(teamId: string): Promise<void> {
        const team = await this.team(teamId)
        let slug = team.githubTeamSlug && (await gh.getTeam(this.env, team.githubTeamSlug))?.slug
        if (!slug) {
            const existing = await gh.getTeam(this.env, slugify(team.name))
            slug = existing?.slug ?? (await gh.createTeam(this.env, team.name)).slug
        }
        if (key(slug) === key(this.execSlug)) {
            throw new Error(`${team.name} would use the exec team ${slug}; rename the team`)
        }
        if (slug !== team.githubTeamSlug) await setGithubTeamSlug(this.db, teamId, slug)

        const current = await this.teamRepoRoles(slug)
        for (const repoName of await listTeamRepos(this.db, teamId)) {
            const role = current.get(key(repoName))
            if (role === 'push') continue
            // Repositories missing from GitHub are reported by syncTeam.
            if (role || (await gh.getRepo(this.env, repoName))) {
                await gh.setTeamRepoPermission(this.env, slug, repoName, 'push')
            }
        }
    }

    /**
     * Deletes the team's GitHub team and removes LHD members' direct Admin on its repositories,
     * which become orphaned. Members stay in the org.
     */
    async deleteTeam(teamId: string): Promise<void> {
        const team = await getTeam(this.db, teamId)
        if (!team) return

        for (const repoName of await listTeamRepos(this.db, teamId)) {
            await this.removeMemberAdmins(repoName)
        }
        if (team.githubTeamSlug && key(team.githubTeamSlug) !== key(this.execSlug)) {
            await gh.deleteTeam(this.env, team.githubTeamSlug)
        }
        await setGithubTeamSlug(this.db, teamId, null)
    }

    /**
     * Checks the team's GitHub team, its repository access, and for access D1 doesn't account
     * for: LHD members who are no longer on the team, non-leads with direct Admin, unknown
     * accounts, and repositories not assigned in D1. Missing members are added by syncUsers,
     * since it is given the team's users from D1. Changes nothing.
     */
    async syncTeam(teamId: string): Promise<NeededChange[]> {
        const team = await this.team(teamId)
        const { slug, needed } = await this.checkTeamSetup(team)
        if (!slug) return needed

        const ids = { teamId }
        const devs = await this.devMembers(teamId)
        const known = await this.knownLogins()

        for (const login of (await gh.listTeamMembers(this.env, slug)) ?? []) {
            if (devs.has(key(login))) continue
            const userId = known.get(key(login))
            needed.push(
                userId
                    ? this.change(
                          'remove_team_member',
                          login,
                          `${login} is no longer a dev member of ${team.name}`,
                          { ...ids, userId },
                      )
                    : this.change(
                          'unknown_account',
                          login,
                          `${login} is on ${slug} but not in D1`,
                          ids,
                      ),
            )
        }

        const assigned = await listTeamRepos(this.db, teamId)
        for (const repoName of assigned) {
            for (const { login, role_name } of await gh.listDirectCollaborators(
                this.env,
                repoName,
            )) {
                if (devs.get(key(login))?.role === 'maintainer') continue
                const userId = known.get(key(login))
                if (!userId) {
                    needed.push(
                        this.change(
                            'unknown_account',
                            login,
                            `${login} has direct ${role_name} access to ${repoName} but is not in D1`,
                            ids,
                        ),
                    )
                } else if (role_name === 'admin' && !(await this.isOwner(login))) {
                    needed.push(
                        this.change(
                            'remove_repo_admin',
                            repoName,
                            `${login} has direct Admin on ${repoName} but isn't a lead of ${team.name}`,
                            { ...ids, userId },
                        ),
                    )
                }
            }
        }

        const assignedKeys = new Set(assigned.map(key))
        for (const repo of (await gh.listTeamRepos(this.env, slug)) ?? []) {
            if (!assignedKeys.has(key(repo.name))) {
                needed.push(
                    this.change(
                        'extra_team_repo',
                        repo.name,
                        `${slug} has access to ${repo.name} in GitHub but it isn't assigned to ${team.name} in D1; assign it or remove the access`,
                        ids,
                    ),
                )
            }
        }
        return needed
    }

    /**
     * Gives each user the GitHub access D1 says they should have on the team (see addUserToTeam),
     * and removes it from those who no longer qualify. Changes nothing if the team isn't set up.
     */
    async syncUsers(teamId: string, userIds: string[]): Promise<NeededChange[]> {
        const team = await this.team(teamId)
        const devs = await this.devMembers(teamId)
        const users = await Promise.all(userIds.map((userId) => this.user(userId)))

        const { slug, needed } = await this.checkTeamSetup(team)
        needed.push(...(await this.checkAccounts(users.filter((u) => devs.has(key(u.githubId))))))
        if (needed.length || !slug) return needed

        for (const user of users) {
            const dev = devs.get(key(user.githubId))
            if (dev) await this.applyMember(user.githubId, slug, teamId, dev.role)
            else await this.removeMember(user.githubId, team)
        }
        return []
    }

    async fixTeam(changes: NeededChange[]): Promise<void> {
        const mine = changes.filter(
            (change) => change.service === this.name && fixableKinds.has(change.kind),
        )
        // Teams first, since the other changes need them.
        const creates = (change: NeededChange) =>
            change.kind === 'create_team' || change.kind === 'create_exec_team' ? 0 : 1
        for (const change of mine.sort((a, b) => creates(a) - creates(b))) {
            await this.fix(change)
        }
    }

    // ============================================================
    // GitHub-only actions (repositories and the exec team)
    // ============================================================

    /**
     * Assigns an org repository to a team: the team gets Write and its dev leads get Admin. If
     * another team had it, that team loses access and LHD members lose direct Admin. Changes
     * nothing if the team isn't set up; unknown repository names reject the promise.
     */
    async assignRepoToTeam(teamId: string, repoName: string): Promise<NeededChange[]> {
        const team = await this.team(teamId)
        const repo = await gh.getRepo(this.env, repoName)
        if (!repo) throw new Error(`${this.env.GITHUB_ORG} has no repository named ${repoName}`)

        const { slug, needed } = await this.checkTeamSetup(team)
        if (needed.length || !slug) return needed

        const previousTeamId = await assignRepo(this.db, teamId, repo.name)
        if (previousTeamId) {
            const previous = await getTeam(this.db, previousTeamId)
            if (previous?.githubTeamSlug) {
                await gh.removeTeamRepo(this.env, previous.githubTeamSlug, repo.name)
            }
            await this.removeMemberAdmins(repo.name)
        }

        await gh.setTeamRepoPermission(this.env, slug, repo.name, 'push')
        for (const [login, dev] of await this.devMembers(teamId)) {
            if (dev.role === 'maintainer') {
                await gh.setCollaboratorPermission(this.env, repo.name, login, 'admin')
            }
        }
        return []
    }

    /** Unassigns a repository: its team loses access and LHD members lose direct Admin. */
    async unassignRepo(repoName: string): Promise<void> {
        const teamId = await unassignRepo(this.db, repoName)
        if (!teamId) return
        const team = await getTeam(this.db, teamId)
        if (team?.githubTeamSlug) await gh.removeTeamRepo(this.env, team.githubTeamSlug, repoName)
        await this.removeMemberAdmins(repoName)
    }

    /** Reports active, non-fork org repositories assigned to no team. Changes nothing. */
    async auditRepos(): Promise<NeededChange[]> {
        const assigned = new Set(
            (await listRepoAssignments(this.db)).map((row) => key(row.repoName)),
        )
        return (await gh.listOrgRepos(this.env))
            .filter((repo) => !repo.archived && !repo.fork && !assigned.has(key(repo.name)))
            .map((repo) =>
                this.change('orphan_repo', repo.name, `${repo.name} is not assigned to any team`),
            )
    }

    /**
     * Checks the exec team: it exists, has Admin on every non-archived repository, and has every
     * active exec (is_exec) as a member and no other LHD members. Changes nothing.
     */
    async syncExecTeam(): Promise<NeededChange[]> {
        const needed = await this.checkExecSetup()
        const exists = !needed.some((change) => change.kind === 'create_exec_team')

        const execs = new Map<string, User>()
        for (const user of await listUsers(this.db)) {
            if (user.isExec && user.status === 'active') execs.set(key(user.githubId), user)
        }
        const members = new Set(
            ((exists && (await gh.listTeamMembers(this.env, this.execSlug))) || []).map(key),
        )

        for (const [login, user] of execs) {
            if (members.has(login)) continue
            // Invited but not yet accepted.
            if (exists && (await gh.getTeamMembership(this.env, login, this.execSlug))) continue
            needed.push(
                (await gh.userExists(this.env, login))
                    ? this.change(
                          'add_exec_member',
                          user.githubId,
                          `${user.githubId} is an exec but not on ${this.execSlug}`,
                          { userId: user.id },
                      )
                    : this.change(
                          'github_user_not_found',
                          user.githubId,
                          this.notFound(user.githubId),
                          { userId: user.id },
                      ),
            )
        }

        const known = await this.knownLogins()
        for (const login of members) {
            if (execs.has(login)) continue
            const userId = known.get(login)
            needed.push(
                userId
                    ? this.change(
                          'remove_exec_member',
                          login,
                          `${login} is on ${this.execSlug} but is not an active exec`,
                          { userId },
                      )
                    : this.change(
                          'unknown_account',
                          login,
                          `${login} is on ${this.execSlug} but not in D1`,
                      ),
            )
        }
        return needed
    }

    // ============================================================
    // Checks
    // ============================================================

    /**
     * Checks the team has a GitHub team with Write on each assigned repository.
     * `slug` is null when the GitHub team can't be used yet.
     */
    private async checkTeamSetup(
        team: Team,
    ): Promise<{ slug: string | null; needed: NeededChange[] }> {
        const ids = { teamId: team.id }
        const saved = team.githubTeamSlug
        const slug = saved && (await gh.getTeam(this.env, saved)) ? saved : null
        if (slug && key(slug) === key(this.execSlug)) {
            const reason = `${team.name} is linked to the exec team; set its github_team_slug to its own team`
            return { slug: null, needed: [this.change('team_slug_conflict', slug, reason, ids)] }
        }

        const needed: NeededChange[] = []
        if (!slug)
            needed.push(
                this.change('create_team', team.name, `${team.name} has no GitHub team`, ids),
            )

        const current = slug ? await this.teamRepoRoles(slug) : new Map()
        for (const repoName of await listTeamRepos(this.db, team.id)) {
            const role = current.get(key(repoName))
            if (role === 'push') continue
            if (!role && !(await gh.getRepo(this.env, repoName))) {
                const reason = `${repoName} is assigned to ${team.name} in D1 but isn't in ${this.env.GITHUB_ORG}; unassign or restore it`
                needed.push(this.change('missing_repo', repoName, reason, ids))
            } else if (slug) {
                // Without a GitHub team, createTeam grants this.
                needed.push(
                    this.change(
                        'grant_team_repo',
                        repoName,
                        `${slug} needs Write on ${repoName}`,
                        ids,
                    ),
                )
            }
        }
        return { slug, needed }
    }

    /** Checks the exec team exists and has Admin on every non-archived repository. */
    private async checkExecSetup(): Promise<NeededChange[]> {
        const slug = this.execSlug
        if (!(await gh.getTeam(this.env, slug))) {
            return [
                this.change(
                    'create_exec_team',
                    slug,
                    `The exec team ${slug} doesn't exist in GitHub`,
                ),
            ]
        }
        const current = await this.teamRepoRoles(slug)
        return (await gh.listOrgRepos(this.env))
            .filter((repo) => !repo.archived && current.get(key(repo.name)) !== 'admin')
            .map((repo) =>
                this.change(
                    'grant_exec_repo_admin',
                    repo.name,
                    `${slug} needs Admin on ${repo.name}`,
                ),
            )
    }

    /** Checks each user's github_id is a real GitHub account. */
    private async checkAccounts(users: User[]): Promise<NeededChange[]> {
        const needed: NeededChange[] = []
        for (const user of users) {
            if (!(await gh.userExists(this.env, user.githubId))) {
                needed.push(
                    this.change(
                        'github_user_not_found',
                        user.githubId,
                        this.notFound(user.githubId),
                        { userId: user.id },
                    ),
                )
            }
        }
        return needed
    }

    // ============================================================
    // Changes
    // ============================================================

    private async fix(change: NeededChange): Promise<void> {
        const teamId = () => required(change.teamId, change)
        const login = async () => (await this.user(required(change.userId, change))).githubId
        const slug = async () =>
            required((await this.team(teamId())).githubTeamSlug ?? undefined, change)

        switch (change.kind) {
            case 'create_team':
                return this.createTeam(teamId())
            case 'grant_team_repo':
                return gh.setTeamRepoPermission(this.env, await slug(), change.target, 'push')
            case 'remove_team_member':
                await gh.removeFromTeam(this.env, await login(), await slug())
                return
            case 'remove_repo_admin':
                return this.removeDirectAdmin(change.target, await login())
            case 'create_exec_team':
                return this.createExecTeam()
            case 'grant_exec_repo_admin':
                return gh.setTeamRepoPermission(this.env, this.execSlug, change.target, 'admin')
            case 'add_exec_member':
                await gh.addToTeam(this.env, await login(), this.execSlug)
                return
            case 'remove_exec_member':
                await gh.removeFromTeam(this.env, await login(), this.execSlug)
                return
        }
    }

    /** Creates the exec team with Admin on every non-archived repository. */
    private async createExecTeam(): Promise<void> {
        const created = await gh.createTeam(this.env, this.execSlug)
        if (created.slug !== this.execSlug) {
            throw new Error(
                `GitHub named the exec team ${created.slug}; set GITHUB_EXEC_TEAM to match`,
            )
        }
        for (const repo of await gh.listOrgRepos(this.env)) {
            if (!repo.archived)
                await gh.setTeamRepoPermission(this.env, created.slug, repo.name, 'admin')
        }
    }

    /**
     * Gives a user their team role. Leads get direct Admin on the team's repositories; non-leads
     * lose it (e.g. a lead who stepped down).
     */
    private async applyMember(
        login: string,
        slug: string,
        teamId: string,
        role: TeamRole,
    ): Promise<void> {
        await gh.addToTeam(this.env, login, slug, role)
        for (const repoName of await listTeamRepos(this.db, teamId)) {
            if (role === 'maintainer') {
                await gh.setCollaboratorPermission(this.env, repoName, login, 'admin')
            } else {
                await this.removeDirectAdmin(repoName, login)
            }
        }
    }

    /** Takes a user off a team's GitHub team and removes their direct Admin on its repositories. */
    private async removeMember(login: string, team: Team): Promise<void> {
        if (team.githubTeamSlug) await gh.removeFromTeam(this.env, login, team.githubTeamSlug)
        for (const repoName of await listTeamRepos(this.db, team.id)) {
            await this.removeDirectAdmin(repoName, login)
        }
    }

    /** Removes a user's direct Admin on a repository, unless they are an org owner. */
    private async removeDirectAdmin(repoName: string, login: string): Promise<void> {
        const collaborators = await gh.listDirectCollaborators(this.env, repoName)
        const collaborator = collaborators.find((c) => key(c.login) === key(login))
        if (collaborator?.role_name !== 'admin' || (await this.isOwner(login))) return
        await gh.removeCollaborator(this.env, repoName, login)
    }

    /** Removes direct Admin from every LHD member (except org owners) on a repository. */
    private async removeMemberAdmins(repoName: string): Promise<void> {
        const known = await this.knownLogins()
        for (const { login, role_name } of await gh.listDirectCollaborators(this.env, repoName)) {
            if (role_name !== 'admin' || !known.has(key(login)) || (await this.isOwner(login)))
                continue
            await gh.removeCollaborator(this.env, repoName, login)
        }
    }

    // ============================================================
    // Lookups
    // ============================================================

    private get db() {
        return this.env.membership_db
    }

    private get execSlug() {
        return this.env.GITHUB_EXEC_TEAM
    }

    private async user(userId: string): Promise<User> {
        const user = await getUserById(this.db, userId)
        if (!user) throw new Error(`User ${userId} not found`)
        return user
    }

    private async team(teamId: string): Promise<Team> {
        const team = await getTeam(this.db, teamId)
        if (!team) throw new Error(`Team ${teamId} not found`)
        return team
    }

    /** Active tech members of a team by lowercased login: dev leads are maintainers. */
    private async devMembers(teamId: string): Promise<Map<string, DevMember>> {
        const devs = new Map<string, DevMember>()
        for (const { user, verticals } of await getTeamMembers(this.db, teamId)) {
            const dev = verticals.find((assignment) => assignment.vertical === 'tech')
            if (user.status !== 'active' || !dev) continue
            devs.set(key(user.githubId), {
                userId: user.id,
                role: dev.isLead ? 'maintainer' : 'member',
            })
        }
        return devs
    }

    /** User IDs of everyone in D1 by lowercased login, to tell LHD members from unknown accounts. */
    private async knownLogins(): Promise<Map<string, string>> {
        return new Map((await listUsers(this.db)).map((user) => [key(user.githubId), user.id]))
    }

    /** A team's current role on each of its repositories, keyed by lowercased repo name. */
    private async teamRepoRoles(slug: string): Promise<Map<string, RepoPermission | null>> {
        const repos = (await gh.listTeamRepos(this.env, slug)) ?? []
        return new Map(repos.map((repo) => [key(repo.name), gh.roleOf(repo.permissions)]))
    }

    private async isOwner(login: string): Promise<boolean> {
        return (await gh.getOrgMembership(this.env, login))?.role === 'admin'
    }

    private change(
        kind: GitHubChangeKind,
        target: string,
        reason: string,
        ids: { teamId?: string; userId?: string } = {},
    ): NeededChange {
        return { service: this.name, kind, ...ids, target, reason, fixable: fixableKinds.has(kind) }
    }

    private notFound(login: string): string {
        return `GitHub has no account named ${login}; correct the user's github_id in D1`
    }
}

function required<T>(value: T | undefined, change: NeededChange): T {
    if (value === undefined)
        throw new Error(`${change.kind} change for ${change.target} is missing an ID`)
    return value
}
