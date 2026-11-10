import type { Team, User } from '../db/access'
import type { Vertical } from '../db/schema'
import { Service } from '../service'
import type { ExecRole, FailedChange, FixServiceResult, NeededChange, ServiceResult } from '../service'
import { GitHubBudgetExceeded, GitHubOrg } from './github-api'
import type { RepoPermission, TeamRepoGrant, TeamRole } from './github-api'

type ReservedTeamKey = 'exec' | 'leads'

/** The NeededChange kinds GitHubService reports; see the README for what each means. */
export type GitHubChangeKind =
    | 'create_team'
    | 'set_team_member'
    | 'remove_team_member'
    | 'set_team_repo_role'
    | 'grant_repo_admin'
    | 'remove_repo_collaborator'
    | `create_${ReservedTeamKey}_team`
    | `set_${ReservedTeamKey}_repo_role`
    | `add_${ReservedTeamKey}_member`
    | `remove_${ReservedTeamKey}_member`
    | 'make_org_owner'
    | 'demote_owner'
    | 'invite_to_org'
    | 'remove_org_member'
    // these need a person
    | 'github_user_not_found'
    | 'no_github_account'
    | 'pending_invite'
    | 'orphan_repo'
    | 'team_slug_conflict'

// An action can't run while one of these is reported: the entity it needs doesn't exist.
const blockingKinds = new Set<string>([
    'create_team',
    'create_exec_team',
    'create_leads_team',
    'github_user_not_found',
    'no_github_account',
    'team_slug_conflict',
])

const manualKinds = new Set<string>([
    'github_user_not_found',
    'no_github_account',
    'pending_invite',
    'orphan_repo',
    'team_slug_conflict',
])

// A team's GitHub team is found by name: GitHub derives the slug from it, e.g.
// "UT Dining" -> "ut-dining". Renaming a team in D1 needs the GitHub team renamed to match.
const slugOf = (name: string) =>
    name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')

const lc = (value: string) => value.toLowerCase()

type DevMember = { userId: string; role: TeamRole }
type ReservedTeam = { name: string; slug: string; permission: RepoPermission }
type Ids = { teamId?: string; userId?: string }
type Dictionary = Map<string, string>

/**
 * Keeps the GitHub org in sync with D1 (D1 logins are lowercase):
 * - each team: GitHub team with Write on its repos (set in GitHub); tech leads are maintainers
 *   with direct Admin on those repos, tech fellows members
 * - leads team: every tech lead, Maintain on every non-archived repo
 * - exec team: every active exec, Admin on every non-archived repo; execs are the org owners
 * - org members: users with a tech assignment, plus execs
 * - changes for accounts not in D1 have no userId
 *
 * Actions need their entities (teams, accounts) to exist (blocking changes) and report setup
 * problems as non-blocking changes; syncs only report; autoFix makes changes. Everything reads from one GitHubOrg
 * snapshot, and writes go through its methods, which skip what is already in place.
 */
export class GitHubService extends Service {
    readonly name = 'github'

    private readonly gh = new GitHubOrg(this.env)

    // ============================================================
    // Service actions
    // ============================================================

    async addUserToTeam(
        user: User,
        team: Team,
        vertical: Vertical,
        isLead: boolean,
    ): Promise<ServiceResult> {
        // only tech gets GitHub access
        if (vertical !== 'tech') return this.done([])

        if (!user.githubId) return this.blocked([this.noGithub(user)])!

        // check for needed changes
        const { slug, needed } = await this.checkTeamSetup(team)
        needed.push(...(await this.checkGitHubExists(user)))
        if (isLead) needed.push(...(await this.checkReservedTeam('leads')))
        const blocked = this.blocked(needed)
        if (blocked) return blocked

        // perform the changes
        const login = user.githubId!;
        await this.gh.setTeamMember(slug!, login, isLead ? 'maintainer' : 'member')

        if (isLead) {
            await this.gh.setTeamMember(this.reservedTeams.leads.slug, login, 'member')
        } else if (!(await this.leads()).has(login)) {
            await this.gh.removeTeamMember(this.reservedTeams.leads.slug, login)
        }

        // anything that is already good will no-op in the GH API
        const led = (await this.leadRepos()).get(login) // from SQL
        for (const { name } of await this.gh.teamRepos(slug!)) {
            if (led?.has(lc(name))) await this.gh.grantDirectAdmin(name, login)
            else await this.gh.removeDirect(name, login)
        }

        return this.done(needed)
    }

    async removeUserFromTeam(user: User, team: Team): Promise<ServiceResult> {
        if (!user.githubId) return this.done([]);

        await this.removeMember(user, team)
        return this.done([])
    }

    /** Only checks the account exists. */
    async onboardUser(
        _name: string,
        _email: string,
        github: string | undefined,
        _discord: string,
    ): Promise<ServiceResult> {
        if (!github || (await this.gh.exists(github))) return this.done([])
        return this.blocked([this.change('github_user_not_found', github, this.notFound(github))])!
    }

    /** Removes the user from the org, and so from its teams and repos. */
    async deactivateUser(user: User): Promise<ServiceResult> {
        if (!user.githubId) return this.done([])

        await this.gh.removeFromOrg(user.githubId)
        return this.done([])
    }

    /** Adds to the exec team and makes an org owner; a pending invite keeps its role. */
    async makeExec(user: User, _execRole: ExecRole): Promise<ServiceResult> {
        if (!user.githubId) return this.blocked([this.noGithub(user)])!

        const needed = await this.checkReservedTeam('exec')
        needed.push(...(await this.checkGitHubExists(user)))
        const blocked = this.blocked(needed)
        if (blocked) return blocked

        await this.gh.setOrgRole(user.githubId, 'admin')
        await this.gh.setTeamMember(this.reservedTeams.exec.slug, user.githubId, 'member')
        return this.done(needed)
    }

    /** Leaves the exec team and ownership, or the org if nothing else keeps them. */
    async removeExec(user: User, _execRole: ExecRole): Promise<ServiceResult> {
        const login = user.githubId
        if (!login) return this.done([])

        if (!(await this.keepsOrgAccess(user))) {
            await this.gh.removeFromOrg(login)
            return this.done([])
        }

        await this.gh.removeTeamMember(this.reservedTeams.exec.slug, login)
        const membership = await this.gh.member(login)
        if (membership?.role === 'admin') {
            // pending role can't be changed; re-invite
            if (membership.state === 'pending') await this.gh.removeFromOrg(login)
            await this.gh.setOrgRole(login, 'member')
        }

        for (const assignment of (await this.assignments({userId: user.id}))) {
            const { slug } = await this.checkTeamSetup(await this.db.getTeam(assignment.teamId));
            if (!slug) continue
            await this.gh.setTeamMember(slug, login, assignment.isLead ? 'maintainer' : 'member')
        }

        return this.done([])
    }

    /**
     * Creates the team's GitHub team unless one with its name exists. Repositories are added to
     * it in GitHub; members are added by autoFix after syncTeam.
     */
    async createTeam(team: Team): Promise<ServiceResult> {
        const slug = slugOf(team.name)
        if (this.reserved(slug)) {
            return this.blocked([this.change('team_slug_conflict', slug,
                `${team.name} would use the reserved team ${slug}; rename the team`, { teamId: team.id })])!
        }
        const created = await this.gh.createTeam(team.name, slug)
        if (created.slug !== slug) {
            throw new Error(
                `GitHub named ${team.name}'s team ${created.slug}; rename the team so it slugifies to the GitHub team`,
            )
        }
        return this.done([])
    }

    /** Removes members' access (see removeMember), then deletes the GitHub team; its repos become orphans. */
    async deleteTeam(team: Team): Promise<ServiceResult> {
        const slug = slugOf(team.name)
        if (this.reserved(slug)) return this.done([]) // shouldn't be possible, but just a safeguard

        const gitHubTeam = await this.gh.team(slug)
        if (!gitHubTeam) return this.done([])

        const users = new Map((await this.users()).map((user) => [user.githubId, user]))

        // deleting the team removes its memberships
        for (const login of [...gitHubTeam.members.keys()]) {
            const user = users.get(login)
            if (user) await this.removeMember(user, team, false)
        }

        await this.gh.deleteTeam(slug)
        return this.done([])
    }

    /**
     * Reports whether the GitHub team exists with Write on its repos, has exactly the D1 dev
     * members in the right roles, and only its leads have direct repo access.
     */
    async syncTeam(team: Team): Promise<ServiceResult> {
        const { slug, needed } = await this.checkTeamSetup(team)
        if (!slug) return this.done(needed)

        const ids = { teamId: team.id }

        const devs = new Map<string, DevMember>()
        for (const { user, isLead } of await this.assignments({teamId: team.id})) {
            if (!user.githubId) {
                needed.push(this.noGithub(user));
                continue
            }
            devs.set(user.githubId, { userId: user.id, role: isLead ? 'maintainer' : 'member' })
        }

        const known = await this.knownLogins()
        await this.gh.ensureAccounts([...devs.keys()])
        const members = (await this.gh.team(slug))!.members

        for (const [login, { userId, role }] of devs) {
            const entry = members.get(login)
            if (entry?.state === 'pending') continue

            if (entry && (entry.role === role || (entry.role === 'maintainer' && (await this.gh.isOwner(login))))) continue
            needed.push(
                await this.missing(
                    'set_team_member',
                    login,
                    userId,
                    `${login} should be a ${role} of ${slug}`,
                    ids,
                ),
            )
        }
        for (const login of members.keys()) {
            if (devs.has(login)) continue
            needed.push(this.stray('remove_team_member', login,
                `${login} is on ${slug} but is not a dev member of ${team.name}`, known, ids))
        }

        const leadRepos = await this.leadRepos()
        for (const { name } of (await this.gh.teamRepos(slug))) {
            const direct = (await this.gh.collaborators(name))
            for (const [login, { userId, role }] of devs) {
                if (role !== 'maintainer' || direct.get(login) === 'admin') continue
                // repo access only after joining the org
                if ((await this.gh.member(login))?.state !== 'active') continue
                needed.push(
                    this.change('grant_repo_admin', `${name}/${login}`,
                        `${login} leads ${team.name} and needs direct Admin on ${name}`, { ...ids, userId }),
                )
            }
            for (const [login, permission] of direct) {
                if (leadRepos.get(login)?.has(lc(name))) continue
                needed.push(
                    this.stray('remove_repo_collaborator', login,
                        `${login} has direct ${permission} access to ${name} but is not its lead`,
                        known, ids, `${name}/${login}`),
                )
            }
        }
        return this.done(needed)
    }

    /**
     * Reports what no single team covers: exec and leads teams, org owners and members, and
     * repos no team owns (with their direct collaborators).
     */
    async syncService(): Promise<ServiceResult> {
        const known = await this.knownLogins()
        const execs: Dictionary = new Map(
            (await this.users())
                .filter((user) => user.execRole && user.githubId && user.status === 'active')
                .map((user) => [user.githubId!, user.id]))
        const leadLogins = await this.leads()
        const techs: Dictionary = new Map(
            (await this.assignments())
                .filter(u=>u.user.githubId)
                .map(({ user }) => [user.githubId!, user.id]))
        const wanted = new Map([...techs, ...execs])
        await this.gh.ensureAccounts(wanted.keys().toArray())

        const needed = [...(await this.checkReservedTeam('exec')), ...(await this.checkReservedTeam('leads'))]
        needed.push(...(await this.checkMembers('exec', execs, known)))
        needed.push(...(await this.checkMembers('leads', leadLogins, known)))

        for (const [login, userId] of wanted) {
            const exec = execs.has(login)
            const member = (await this.gh.member(login))
            if (member?.state === 'active' && (member.role === 'admin' || !exec)) continue

            needed.push(
                member?.state === 'pending'
                    ? this.change(
                        'pending_invite',
                        login,
                        `${login} hasn't accepted their GitHub org invitation`,
                        { userId },
                    )
                    : await this.missing(
                        exec ? 'make_org_owner' : 'invite_to_org',
                        login,
                        userId,
                        `${login} should be ${exec ? 'an org owner' : 'in the org'}`,
                    ),
            )
        }
        const owners = new Set((await this.gh.orgLogins('admin')))
        for (const login of owners) {
            if (execs.has(login)) continue
            needed.push(this.stray('demote_owner', login, `${login} owns the org but is not an exec`, known))
        }
        for (const login of [...(await this.gh.orgLogins('member')), ...(await this.gh.pendingLogins())]) {
            if (wanted.has(login)) continue
            needed.push(this.stray('remove_org_member', login,
                `${login} is in the org (or invited) without a tech assignment`, known))
        }

        const owned = new Set<string>()
        for (const team of await this.teams()) {
            for (const repo of (await this.gh.teamRepos(slugOf(team.name)))) owned.add(lc(repo.name))
        }
        for (const repo of (await this.gh.repos()).filter((r) => !r.fork && !owned.has(lc(r.name)))) {
            const reason = `${repo.name} isn't on any team's GitHub team; add it to one in GitHub`
            needed.push(this.change('orphan_repo', repo.name, reason))
            for (const [login, permission] of (await this.gh.collaborators(repo.name))) {
                if (owners.has(login)) continue
                needed.push(
                    this.stray('remove_repo_collaborator', login,
                        `${login} has direct ${permission} access to unowned ${repo.name}`,
                        known, {}, `${repo.name}/${login}`),
                )
            }
        }

        for (const team of await this.teams()) {
            needed.push(...(await this.syncTeam(team)).changes)
        }

        return this.done(needed)
    }

    /**
     * Fixes what the syncs report for a user who just accepted their org invitation (team roles,
     * direct repo access, leads and exec membership, ownership).
     */
    // TODO: fix
    async onJoinedOrg(login: string): Promise<FixServiceResult> {
        const user = (await this.users()).find((u) => u.githubId === lc(login))
        if (!user || user.status !== 'active') return { failed: false,
            changes: [this.change('remove_org_member', login, `${login} is in the org without a tech assignment`, {userId: user?.id})], failedChanges: [] }

        const teamIds = new Set((await this.assignments({userId: user.id})).map((a) => a.teamId))

        const found: NeededChange[] = []
        for (const team of await this.teams()) {
            if (teamIds.has(team.id)) found.push(...((await this.syncTeam(team)).changes ?? []))
        }
        found.push(...((await this.syncService()).changes ?? []))

        return this.autoFix(found.filter((change) => change.userId === user.id))
    }

    /** Up to ten fixes; batched repo roles. Failures are returned, and so are deferred changes (as `changes`). */
    async autoFix(changes: NeededChange[]): Promise<FixServiceResult> {
        const failedChanges: FailedChange[] = []
        const deferred: NeededChange[] = []
        const finish = (): FixServiceResult => ({
            changes: deferred,
            failed: failedChanges.length > 0 || deferred.length > 0,
            failedChanges,
        })

        const eligible = changes.filter(
            (change) => change.service === this.name && !manualKinds.has(change.kind),
        )
        deferred.push(...changes.filter(c=>!eligible.includes(c)))

        const mine = eligible.slice(0, 10)
        deferred.push(...eligible.slice(10))
        if (!mine.length) return finish()

        const phase = (change: NeededChange) =>
            change.kind.startsWith('create_')
                ? 0
                : change.kind === 'invite_to_org' || change.kind === 'make_org_owner'
                    ? 1
                    : change.kind.endsWith('_repo_role')
                        ? 2
                        : 3
        const fail = (change: NeededChange, error: unknown) => {
            if (error instanceof GitHubBudgetExceeded) deferred.push(change)
            else failedChanges.push({ change, error: error instanceof Error ? error : new Error(String(error)) })
        }

        for (const n of [0, 1, 2, 3]) {
            const inPhase = mine.filter((change) => phase(change) === n)
            if (n === 2) { // lets us batch this
                await this.fixRepoRoles(inPhase, failedChanges, deferred)
                continue
            }
            for (const change of inPhase) {
                if (this.gh.callsLeft <= 0) deferred.push(change)
                else await this.fix(change).catch((error) => fail(change, error))
            }
        }
        return finish()
    }

    // ============================================================
    // Checks
    // ============================================================

    /**
     * The GitHub team must exist (blocking changes; `slug` is null then). Repos it doesn't have
     * Write on come back as non-blocking changes.
     */
    private async checkTeamSetup(
        team: Team,
    ): Promise<{ slug: string | null; needed: NeededChange[] }> {
        const ids = { teamId: team.id }
        const slug = slugOf(team.name)
        if (this.reserved(slug)) {
            return { slug: null, needed: [this.change('team_slug_conflict', slug,
                    `${team.name}'s name matches a reserved team; rename the team`, ids)] }
        }
        if (!(await this.gh.team(slug))) {
            return { slug: null, needed: [this.change('create_team', team.name,
                    `${team.name} has no GitHub team (${slug})`, ids)] }
        }
        const needed = (await this.gh.teamRepos(slug))
            .filter((repo) => repo.permission !== 'push')
            .map((repo) =>
                this.change('set_team_repo_role', repo.name, `${slug} needs Write on ${repo.name}`, ids),
            )
        return { slug, needed }
    }

    /** A group team must exist (blocking); repos it lacks its role on are non-blocking changes. */
    private async checkReservedTeam(key: ReservedTeamKey): Promise<NeededChange[]> {
        const { slug, permission } = this.reservedTeams[key];
        if (!(await this.gh.team(slug))) {
            return [
                this.change(`create_${key}_team`, slug, `The ${key} team ${slug} doesn't exist in GitHub`),
            ]
        }
        const current = new Map((await this.gh.teamRepos(slug)).map((repo) => [lc(repo.name), repo.permission]))
        return (await this.gh.repos())
            .filter((repo) => current.get(lc(repo.name)) !== permission)
            .map((repo) =>
                this.change(
                    `set_${key}_repo_role`,
                    repo.name,
                    `${slug} needs ${permission} on ${repo.name}`,
                ),
            )
    }

    /** Checks a group team's members (invited ones too) are exactly `desired` (login -> user ID). */
    private async checkMembers(
        key: ReservedTeamKey,
        desired: Dictionary,
        known: Dictionary,
    ): Promise<NeededChange[]> {
        const { slug } = this.reservedTeams[key];

        const team = (await this.gh.team(slug))
        if (!team) return [] // already handled in an above case

        const needed: NeededChange[] = []
        for (const [login, userId] of desired) {
            if (team.members.has(login)) continue
            const reason = `${login} should be in ${slug}`
            needed.push(await this.missing(`add_${key}_member`, login, userId, reason))
        }
        for (const login of team.members.keys()) {
            if (desired.has(login)) continue
            const reason = `${login} is in ${slug} but should not be`
            needed.push(this.stray(`remove_${key}_member`, login, reason, known))
        }
        return needed
    }

    /** Checks each user's github_id is a real GitHub account. */
    private async checkGitHubExists(user: User): Promise<NeededChange[]> {
        const needed: NeededChange[] = []
        const login = user.githubId!;

        if (!(await this.gh.exists(login))) {
            needed.push(
                this.change(
                    'github_user_not_found',
                    login,
                    this.notFound(login),
                    { userId: user.id },
                ),
            )
        }
        return needed
    }

    // ============================================================
    // Changes
    // ============================================================

    private async fix(change: NeededChange): Promise<void> {
        const { kind, target } = change
        const [repo, login = target] = target.split('/') // "repo/login" targets
        const team = async () => this.db.getTeam(required(change.teamId, change))
        const slug = async () => slugOf((await team()).name)
        const reservedTeamKey = /_(exec|leads)_/.exec(kind)?.[1] as ReservedTeamKey;

        switch (kind) {
            case 'create_team': {
                const created = await this.createTeam(await team())
                if (created.failed) throw new Error(created.changes![0].reason)
                return
            }
            case 'set_team_member': {
                const current = await team()
                const dev = (await this.devMembers(current)).get(login)
                if (dev) await this.gh.setTeamMember(slugOf(current.name), login, dev.role)
                return
            }
            case 'remove_team_member':
                return this.gh.removeTeamMember(await slug(), login)
            case 'grant_repo_admin':
                return this.gh.grantDirectAdmin(repo, login)
            case 'remove_repo_collaborator':
                return this.gh.removeDirect(repo, login)
            case 'create_exec_team':
            case 'create_leads_team':
                return this.createReservedTeam(reservedTeamKey)
            case 'add_exec_member':
            case 'add_leads_member':
                return this.gh.setTeamMember(this.reservedTeams[reservedTeamKey].slug, target, 'member')
            case 'remove_exec_member':
            case 'remove_leads_member':
                return this.gh.removeTeamMember(this.reservedTeams[reservedTeamKey].slug, target)
            case 'make_org_owner':
                return this.gh.setOrgRole(target, 'admin')
            case 'demote_owner':
                return this.gh.setOrgRole(target, 'member')
            case 'invite_to_org':
                return this.gh.setOrgRole(target, 'member')
            case 'remove_org_member':
                return this.gh.removeFromOrg(target)
            default:
                throw new Error(`${kind} can't be fixed automatically`)
        }
    }

    /** Makes all the team repo role changes in one batch (a few requests, not one per repo). */
    private async fixRepoRoles(
        changes: NeededChange[],
        failedChanges: FailedChange[],
        deferred: NeededChange[],
    ): Promise<void> {
        deferred.push(...changes.slice(this.gh.callsLeft * 50))
        changes = changes.slice(0, this.gh.callsLeft * 50)
        if (!changes.length) return

        const items: { change: NeededChange; grant: TeamRepoGrant }[] = []
        for (const change of changes) {
            try {
                if (change.kind === 'set_team_repo_role') {
                    const team = await this.db.getTeam(required(change.teamId, change))
                    items.push({ change, grant: { slug: slugOf(team.name), repo: change.target, permission: 'push' } })
                } else {
                    const group = this.reservedTeams[/_(exec|leads)_/.exec(change.kind)![1] as ReservedTeamKey]
                    items.push({ change, grant: { slug: group.slug, repo: change.target, permission: group.permission } })
                }
            } catch (error) {
                failedChanges.push({ change, error: error instanceof Error ? error : new Error(String(error)) })
            }
        }
        const errors = await this.gh.setTeamRepos(items.map((item) => item.grant))
        errors.forEach((error, i) => {
            if (error instanceof GitHubBudgetExceeded) deferred.push(items[i].change)
            else if (error) failedChanges.push({ change: items[i].change, error })
        })
    }

    /** Creates a group team with its role on every non-archived repo. */
    private async createReservedTeam(key: ReservedTeamKey): Promise<void> {
        const { slug, name, permission } = this.reservedTeams[key]

        const created = await this.gh.createTeam(name, slug)
        if (created.slug !== slug) {
            throw new Error(
                `GitHub named the ${key} team ${created.slug}; set GITHUB_${key.toUpperCase()}_TEAM to match`,
            )
        }
        const grants = (await this.gh.repos()).map((repo) => ({ slug, repo: repo.name, permission }))
        const errors = await this.gh.setTeamRepos(grants)
        const failure = errors.find((error) => error instanceof GitHubBudgetExceeded) ?? errors.find((error) => error)
        if (failure) throw failure
    }

    /**
     * Removes the user from the org if nothing else keeps them there (which removes the rest).
     * Otherwise removes them from the GitHub team (unless it's being deleted), their direct
     * access to its repos, and the leads team if they lead nothing.
     */
    private async removeMember(user: User, team: Team, leaveTeam = true): Promise<void> {
        const login = user.githubId!
        // if not keeping org access, remove from org and be done with it
        if (!(await this.keepsOrgAccess(user))) return this.gh.removeFromOrg(login)

        const slug = slugOf(team.name)

        // if we're not deleting the team, remove their membership
        if (leaveTeam) await this.gh.removeTeamMember(slug, login)

        // unless they're a lead on a team that shares a repo, remove their direct access
        const led = (await this.leadRepos()).get(login)
        for (const { name } of (await this.gh.teamRepos(slug))) {
            if (!led?.has(lc(name))) await this.gh.removeDirect(name, login)
        }

        // if no longer leading any team, remove from leads team
        if (!(await this.leads()).has(login)) await this.gh.removeTeamMember(this.reservedTeams.leads.slug, login)
    }

    // ============================================================
    // Lookups
    // ============================================================

    // D1 reads, cached for one RPC call (instances are per call); the services never write D1
    private memo = new Map<string, Promise<any>>()

    private once<T>(key: string, load: () => Promise<T>): Promise<T> {
        let value = this.memo.get(key)
        if (!value) {
            value = load()
            value.catch(() => this.memo.delete(key))
            this.memo.set(key, value)
        }
        return value
    }

    private get reservedTeams(): Record<ReservedTeamKey, ReservedTeam> {
        const { GITHUB_EXEC_TEAM: exec, GITHUB_LEADS_TEAM: leads } = this.env
        return {
            exec: { name: exec, slug: slugOf(exec), permission: 'admin' },
            leads: { name: leads, slug: slugOf(leads), permission: 'maintain' },
        }
    }

    private reserved(slug: string): boolean {
        return Object.values(this.reservedTeams).some((group) => group.slug === slug)
    }

    private teams() {
        return this.once('teams', () => this.db.listTeams())
    }

    private users() {
        return this.once('users', () => this.db.listUsers())
    }

    private assignments(ids: Ids = { userId: undefined, teamId: undefined }) {
        return this.once('assignments', () => this.db.listTechAssignments())
            .then(p => !ids.userId ? p : p.filter(a => a.user.id == ids.userId))
            .then(p => !ids.teamId ? p : p.filter(a => a.teamId == ids.teamId))
    }

    /** Active tech members of a team by login: leads are maintainers. */
    private async devMembers(team: Team): Promise<Map<string, DevMember>> {
        const devs = new Map<string, DevMember>()
        for (const { user, isLead } of await this.assignments({teamId: team.id})) {
            if (!user.githubId) continue
            devs.set(user.githubId, { userId: user.id, role: isLead ? 'maintainer' : 'member' })
        }
        return devs
    }

    /** User IDs of everyone in D1 by login, to tell LHD members from unknown accounts. */
    private async knownLogins(): Promise<Dictionary> {
        return new Map((await this.users()).filter(user=>user.githubId).map((user) => [user.githubId!, user.id]))
    }

    /** Active tech leads of any team by login. */
    private async leads(): Promise<Dictionary> {
        return new Map(
            (await this.assignments())
                .filter(({ user, isLead }) => isLead && user.githubId)
                .map(({ user }) => [user.githubId!, user.id]),
        )
    }

    /** Whether exec or a tech assignment still earns org membership. */
    private async keepsOrgAccess({ id, execRole, status }: User): Promise<boolean> {
        if (status !== 'active') return false
        return execRole != null || (await this.assignments()).some(({ user }) => user.id === id)
    }

    /** Lowercased repos each lead gets direct Admin on: those of the teams they lead. */
    private async leadRepos(): Promise<Map<string, Set<string>>> {
        const teams = new Map((await this.teams()).map((team) => [team.id, team]))
        const result = new Map<string, Set<string>>()
        for (const { user, teamId, isLead } of await this.assignments()) {
            if (!user.githubId) continue;
            const team = teams.get(teamId)
            if (!isLead || !team) continue
            const repos = result.get(user.githubId) ?? new Set<string>()
            for (const repo of (await this.gh.teamRepos(slugOf(team.name)))) repos.add(lc(repo.name))
            result.set(user.githubId, repos)
        }
        return result
    }

    /** A sync's (or finished action's) result: it completed, with whatever it reports. */
    private done(changes: NeededChange[]): ServiceResult {
        return { changes: changes, failed: false }
    }

    /** An action's result if a required entity is missing (any blocking change), else undefined. */
    private blocked(changes: NeededChange[]): ServiceResult | undefined {
        return changes.some((change) => change.blocking) ? { changes, failed: true } : undefined
    }

    private change(
        kind: GitHubChangeKind,
        target: string,
        reason: string,
        ids: Ids = {},
    ): NeededChange {
        return {
            service: this.name,
            kind,
            ...ids,
            target,
            reason,
            fixable: !manualKinds.has(kind),
            blocking: blockingKinds.has(kind),
        }
    }

    /** Access that shouldn't exist; no userId (and a note in the reason) if the account isn't in D1. */
    private stray(
        kind: GitHubChangeKind,
        login: string,
        reason: string,
        known: Dictionary,
        ids: Ids = {},
        target = login,
    ): NeededChange {
        const userId = known.get(login)
        return this.change(kind, target, userId ? reason : `${reason} (not in database)`, { ...ids, userId })
    }

    /** Access that should exist, or github_user_not_found if the account doesn't. */
    private async missing(
        kind: GitHubChangeKind,
        login: string,
        userId: string,
        reason: string,
        ids: Ids = {},
    ): Promise<NeededChange> {
        const withUser = { ...ids, userId }
        return (await this.gh.exists(login))
            ? this.change(kind, login, reason, withUser)
            : this.change('github_user_not_found', login, this.notFound(login), withUser)
    }

    private noGithub(user: User): NeededChange {
        return this.change('no_github_account', user.name, "User does not have a GitHub account set. Please set the user's GitHub account.", { userId: user.id })
    }

    private notFound(login: string): string {
        return `Count not find GitHub account '${login}'. Please set the user's GitHub account.`
    }
}

function required<T>(value: T | undefined, change: NeededChange): T {
    if (value === undefined)
        throw new Error(`${change.kind} change for ${change.target} is missing an ID`)
    return value
}
