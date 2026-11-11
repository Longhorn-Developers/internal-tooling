import type { Team, User } from '../db/access'
import { githubSlugOf as slugOf, leadsSlugOf } from '../db/access'
import type { Vertical } from '../db/schema'
import { Service } from '../service'
import type {
    ExecRole,
    FailedChange,
    FixServiceResult,
    NeededChange,
    ServiceResult,
} from '../service'
import { GitHubBudgetExceeded, GitHubOrg } from './github-api'
import type { TeamRepoGrant } from './github-api'

type ReservedTeamKey = 'exec' | 'leads'

// Subject controls syncTeam's scope. Blocking and manual flags are fixed by kind.
type Subject = 'team' | 'repo' | 'member' | 'other'
type KindInfo = { subject: Subject; blocking?: true; manual?: true }
const kinds = {
    create_team: { subject: 'team', blocking: true },
    create_subteam: { subject: 'team', blocking: true },
    set_team_member: { subject: 'team' },
    remove_team_member: { subject: 'team' },
    set_subteam_member: { subject: 'team' },
    remove_subteam_member: { subject: 'team' },
    set_team_repo_role: { subject: 'team' },
    set_subteam_repo_role: { subject: 'team' },
    remove_subteam_repo: { subject: 'team' },
    team_slug_conflict: { subject: 'team', blocking: true, manual: true },
    remove_repo_collaborator: { subject: 'repo' },
    github_user_not_found: { subject: 'member', blocking: true, manual: true },
    no_github_account: { subject: 'member', blocking: true, manual: true },
    pending_invite: { subject: 'member', manual: true },
    reinvite_as_member: { subject: 'member' },
    create_exec_team: { subject: 'other', blocking: true },
    create_leads_team: { subject: 'other', blocking: true },
    remove_exec_repo: { subject: 'other' },
    remove_leads_repo: { subject: 'other' },
    set_exec_org_role: { subject: 'other' },
    set_leads_org_role: { subject: 'other' },
    org_role_missing: { subject: 'other', manual: true },
    add_exec_member: { subject: 'other' },
    add_leads_member: { subject: 'other' },
    remove_exec_member: { subject: 'other' },
    remove_leads_member: { subject: 'other' },
    make_org_owner: { subject: 'other' },
    demote_owner: { subject: 'other' },
    invite_to_org: { subject: 'other' },
    remove_org_member: { subject: 'other' },
    delete_extra_team: { subject: 'other' },
    orphan_repo: { subject: 'other', manual: true },
} satisfies Record<string, KindInfo>
export type GitHubChangeKind = keyof typeof kinds

const infoOf = (kind: string): KindInfo | undefined =>
    Object.hasOwn(kinds, kind) ? (kinds as Record<string, KindInfo>)[kind] : undefined

const lc = (value: string) => value.toLowerCase()

type ReservedTeam = { name: string; slug: string; orgRole: string }
type Ids = { teamId?: string; userId?: string }
type Dictionary = Map<string, string>

export class StaleNeededChangeError extends Error {
    constructor(public readonly change: NeededChange) {
        super(`${change.kind}: ${change.target} is no longer a required correction`)
    }
}

const sameChange = (a: NeededChange, b: NeededChange) =>
    a.service === b.service &&
    a.kind === b.kind &&
    a.target === b.target &&
    a.teamId === b.teamId &&
    a.userId === b.userId

/** D1 defines access; syncs only report drift. GitHubOrg handles idempotent writes and its snapshot. */
export class GitHubService extends Service {
    readonly name = 'github'

    private readonly gh = new GitHubOrg(this.env)

    // Actions

    async addUserToTeam(
        user: User,
        team: Team,
        vertical: Vertical,
        isLead: boolean,
    ): Promise<ServiceResult> {
        if (vertical !== 'tech') return this.done([])
        if (!user.githubId) return this.blocked([this.noGithub(user)])!

        const { slug, leads, needed: setup } = await this.checkTeamSetup(team)
        const needed = setup.filter((c) => isLead || c.kind !== 'create_subteam')
        needed.push(...(await this.checkGitHubExists(user)))
        const isAnyLead = (await this.leads()).has(user.githubId)
        if (isAnyLead) needed.push(...(await this.checkReservedTeam('leads')))

        const blocked = this.blocked(needed)
        if (blocked) return blocked

        const login = user.githubId
        await this.inviteWithAccess(user)
        await this.gh.setTeamMember(slug!, login)
        if (leads) await this.setMember(leads, login, isLead)
        await this.setMember(this.reservedTeams.leads.slug, login, isAnyLead)

        needed.push(...(await this.pendingInvite(user)))
        return this.done(needed)
    }

    async removeUserFromTeam(user: User, team: Team): Promise<ServiceResult> {
        if (!user.githubId) return this.done([])

        await this.removeMember(user, team)
        return this.done([])
    }

    async onboardUser(
        _name: string,
        _email: string,
        github: string | undefined,
        _discord: string,
    ): Promise<ServiceResult> {
        if (!github || (await this.gh.exists(github))) return this.done([])
        return this.blocked([this.change('github_user_not_found', github, this.notFound(github))])!
    }

    async deactivateUser(user: User): Promise<ServiceResult> {
        if (!user.githubId) return this.done([])

        await this.gh.removeFromOrg(user.githubId)
        return this.done([])
    }

    async makeExec(user: User, _execRole: ExecRole): Promise<ServiceResult> {
        if (!user.githubId) return this.blocked([this.noGithub(user)])!

        const needed = await this.checkReservedTeam('exec')
        needed.push(...(await this.checkGitHubExists(user)))

        const blocked = this.blocked(needed)
        if (blocked) return blocked

        await this.inviteWithAccess(user)
        await this.gh.setOrgRole(user.githubId, 'admin')
        await this.gh.setTeamMember(this.reservedTeams.exec.slug, user.githubId)
        needed.push(...(await this.pendingInvite(user)))
        return this.done(needed)
    }

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
            // Pending invitation roles can't be edited.
            if (membership.state === 'pending') {
                await this.gh.removeFromOrg(login)
                await this.inviteWithAccess(user)
            } else {
                await this.gh.setOrgRole(login, 'member')
            }
        }
        return this.done([])
    }

    async createTeam(team: Team): Promise<ServiceResult> {
        if (this.conflicts(team)) return this.blocked([this.slugConflict(team)])!

        await this.createGitHubTeam(team.name, team.githubSlug)
        await this.createGitHubTeam(
            `${team.name} Leads`,
            leadsSlugOf(team.githubSlug),
            team.githubSlug,
        )
        return this.done([])
    }

    async deleteTeam(team: Team): Promise<ServiceResult> {
        const slug = team.githubSlug
        if (this.conflicts(team)) return this.done([])

        const members = [...((await this.gh.team(slug))?.members.keys() ?? [])]
        const users = new Map((await this.users()).map((user) => [user.githubId, user]))

        await this.gh.deleteTeam(leadsSlugOf(slug))
        await this.gh.deleteTeam(slug)
        for (const login of members) {
            const user = users.get(login)
            if (user) await this.removeMember(user, team)
        }

        return this.done([])
    }

    async syncTeam(team: Team): Promise<ServiceResult> {
        const userIds = new Set(
            (await this.assignments({ teamId: team.id })).map(({ user }) => user.id),
        )
        const repos = new Set(
            (await this.gh.teamRepos(team.githubSlug)).map((repo) => lc(repo.name)),
        )

        return this.done(
            (await this.audit()).filter((change) => {
                if (change.teamId && change.teamId !== team.id) return false
                switch (infoOf(change.kind)?.subject) {
                    case 'team':
                        return true
                    case 'repo':
                        return repos.has(lc(change.target.split('/')[0]))
                    case 'member':
                        return change.userId !== undefined && userIds.has(change.userId)
                    default:
                        return false
                }
            }),
        )
    }

    async syncService(): Promise<ServiceResult> {
        return this.done(await this.audit())
    }

    async syncUser(user: User): Promise<ServiceResult> {
        const assignments = await this.assignments({ userId: user.id })
        const teamIds = new Set(assignments.map((a) => a.teamId))
        for (const team of await this.teams()) {
            if (user.githubId && (await this.gh.team(team.githubSlug))?.members.has(user.githubId))
                teamIds.add(team.id)
        }

        const changes = await this.audit()
        const groups: ReservedTeamKey[] = []
        for (const key of ['exec', 'leads'] as const) {
            const desired =
                key === 'exec'
                    ? user.status === 'active' && user.execRole != null
                    : assignments.some((a) => a.isLead)
            const members = (await this.gh.team(this.reservedTeams[key].slug))?.members
            if (desired || (user.githubId && members?.has(user.githubId))) groups.push(key)
        }

        return this.done(
            changes.filter((c) => {
                if (c.userId === user.id) return true
                if (
                    c.target === user.githubId &&
                    [
                        'demote_owner',
                        'remove_org_member',
                        'remove_exec_member',
                        'remove_leads_member',
                    ].includes(c.kind)
                )
                    return true
                if (
                    c.kind === 'remove_repo_collaborator' &&
                    c.target.split('/')[1] === user.githubId
                )
                    return true
                if (c.teamId && teamIds.has(c.teamId) && !c.userId && !c.kind.endsWith('_member'))
                    return true
                return groups.some(
                    (key) =>
                        c.kind === `create_${key}_team` ||
                        c.kind === `remove_${key}_repo` ||
                        c.kind === `set_${key}_org_role` ||
                        (c.kind === 'org_role_missing' &&
                            c.target === this.reservedTeams[key].orgRole),
                )
            }),
        )
    }

    private async audit(): Promise<NeededChange[]> {
        const allUsers = await this.users()
        const known = new Map(
            allUsers.filter((user) => user.githubId).map((user) => [user.githubId!, user.id]),
        )
        const teams = await this.teams()
        const users = allUsers.filter((user) => user.status === 'active')
        const assignments = await this.assignments()
        const execs: Dictionary = new Map(
            users
                .filter((user) => user.execRole && user.githubId)
                .map((user) => [user.githubId!, user.id]),
        )
        const leadLogins = await this.leads()
        const techs: Dictionary = new Map(
            assignments
                .filter(({ user }) => user.githubId)
                .map(({ user }) => [user.githubId!, user.id]),
        )
        const wanted = new Map([...techs, ...execs])
        await this.gh.ensureAccounts(
            users.flatMap((user) => (user.githubId ? [user.githubId] : [])),
        )

        const needed = [
            ...(await this.checkReservedTeam('exec')),
            ...(await this.checkReservedTeam('leads')),
        ]
        for (const user of users) {
            if (user.githubId) needed.push(...(await this.checkGitHubExists(user)))
            if (
                !user.githubId &&
                (user.execRole != null || assignments.some((a) => a.user.id === user.id))
            ) {
                needed.push(this.noGithub(user))
            }
        }
        needed.push(
            ...(await this.checkMembers(
                this.reservedTeams.exec.slug,
                execs,
                known,
                'add_exec_member',
                'remove_exec_member',
            )),
        )
        needed.push(
            ...(await this.checkMembers(
                this.reservedTeams.leads.slug,
                leadLogins,
                known,
                'add_leads_member',
                'remove_leads_member',
            )),
        )

        for (const [login, userId] of wanted) {
            const exec = execs.has(login)
            const member = await this.gh.member(login)
            if (member?.state === 'active' && (member.role === 'admin' || !exec)) continue

            if (member?.state === 'pending') {
                const wrongRole = member.role === 'admin' && !exec
                const reason = wrongRole
                    ? `${login} was invited as an org owner but isn't an exec; their invitation can't be edited, so it's cancelled and replaced`
                    : `${login} hasn't accepted their GitHub org invitation${exec ? '; they can be made an org owner once they do' : ''}`
                needed.push(
                    this.change(
                        wrongRole ? 'reinvite_as_member' : 'pending_invite',
                        login,
                        reason,
                        { userId },
                    ),
                )
            } else {
                const invite = !member || !exec
                needed.push(
                    await this.missing(
                        invite ? 'invite_to_org' : 'make_org_owner',
                        login,
                        userId,
                        invite
                            ? `${login} should be in the org${exec ? ' as an owner' : ''}; the invitation includes their teams`
                            : `${login} should be an org owner`,
                    ),
                )
            }
        }

        const owners = new Set(await this.gh.orgLogins('admin'))
        for (const login of owners) {
            if (execs.has(login) || !wanted.has(login)) continue
            needed.push(
                this.stray(
                    'demote_owner',
                    login,
                    `${login} owns the org but is not an exec`,
                    known,
                ),
            )
        }
        for (const login of [
            ...owners,
            ...(await this.gh.orgLogins('member')),
            ...(await this.gh.pendingLogins()),
        ]) {
            if (wanted.has(login)) continue
            needed.push(
                this.stray(
                    'remove_org_member',
                    login,
                    `${login} is in the org (or invited) without a tech assignment`,
                    known,
                ),
            )
        }

        const desiredTeams = new Set([
            ...teams.flatMap((t) => [t.githubSlug, leadsSlugOf(t.githubSlug)]),
            ...Object.values(this.reservedTeams).map((t) => t.slug),
        ])
        for (const slug of await this.gh.teams()) {
            if (!desiredTeams.has(slug))
                needed.push(
                    this.change('delete_extra_team', slug, `${slug} has no team in the database`),
                )
        }

        const owned = new Set<string>()
        for (const team of teams) {
            const { slug, leads, needed: setup } = await this.checkTeamSetup(team)
            needed.push(...setup)
            const ids = { teamId: team.id }
            const everyone: Dictionary = new Map()
            const leaders: Dictionary = new Map()
            for (const { user, teamId, isLead } of assignments) {
                if (teamId !== team.id || !user.githubId) continue
                everyone.set(user.githubId, user.id)
                if (isLead) leaders.set(user.githubId, user.id)
            }

            if (slug) {
                needed.push(
                    ...(await this.checkMembers(
                        slug,
                        everyone,
                        known,
                        'set_team_member',
                        'remove_team_member',
                        ids,
                    )),
                )
                for (const repo of await this.gh.teamRepos(slug)) owned.add(lc(repo.name))
            }
            if (leads)
                needed.push(
                    ...(await this.checkMembers(
                        leads,
                        leaders,
                        known,
                        'set_subteam_member',
                        'remove_subteam_member',
                        ids,
                    )),
                )
        }

        for (const repo of await this.gh.repos()) {
            if (!owned.has(lc(repo.name)))
                needed.push(
                    this.change(
                        'orphan_repo',
                        repo.name,
                        `${repo.name} isn't attached to an LHD team`,
                    ),
                )
            for (const [login, permission] of await this.gh.collaborators(repo.name)) {
                needed.push(
                    this.stray(
                        'remove_repo_collaborator',
                        login,
                        `${login} has direct ${permission} access to ${repo.name}; repos use team access only`,
                        known,
                        {},
                        `${repo.name}/${login}`,
                    ),
                )
            }
        }

        return needed.filter(
            (change, i) => needed.findIndex((other) => sameChange(change, other)) === i,
        )
    }

    async updateUser(before: User, after: User): Promise<ServiceResult> {
        if (before.githubId === after.githubId) return this.done([])

        if (before.githubId) await this.gh.removeFromOrg(before.githubId)
        return this.setupUser(after)
    }

    /** Invitation acceptance only sets up eligible users; unexpected joins are reported. */
    async onJoinedOrg(login: string): Promise<ServiceResult> {
        const user = (await this.users()).find((u) => u.githubId === lc(login))
        if (!user || !(await this.keepsOrgAccess(user))) {
            return this.done([
                this.change(
                    'remove_org_member',
                    login,
                    `${login} is in the org without a tech assignment`,
                    { userId: user?.id },
                ),
            ])
        }
        return this.setupUser(user)
    }

    private async setupUser(user: User): Promise<ServiceResult> {
        if (!(await this.keepsOrgAccess(user))) return this.done([])

        const teams = new Map((await this.teams()).map((team) => [team.id, team]))
        const changes = new Map<string, NeededChange>()
        let failed = false
        const add = (result: ServiceResult) => {
            failed ||= result.failed
            for (const change of result.changes) {
                changes.set(
                    `${change.kind}|${change.target}|${change.teamId}|${change.userId}`,
                    change,
                )
            }
        }

        for (const { teamId, isLead } of await this.assignments({ userId: user.id })) {
            const team = teams.get(teamId)
            if (team) add(await this.addUserToTeam(user, team, 'tech', isLead))
        }
        if (user.execRole) add(await this.makeExec(user, user.execRole))
        return { changes: [...changes.values()], failed }
    }

    // Reconciliation fixes
    async autoFix(changes: NeededChange[]): Promise<FixServiceResult> {
        const failedChanges: FailedChange[] = []
        const deferred: NeededChange[] = []
        const rejected = changes.filter((change) => {
            const info = infoOf(change.kind)
            return change.service !== this.name || !info || info.manual
        })
        const finish = (): FixServiceResult => ({
            changes: deferred,
            failed: failedChanges.length > 0,
            failedChanges,
            rejected,
        })

        const eligible = changes.filter((change) => !rejected.includes(change))

        if (!eligible.length) return finish()

        // Validate before writing: an invitation can satisfy later membership selections.
        this.memo.clear()
        const current = await this.audit()
        const valid = eligible.filter((change, i) => {
            const needed =
                current.some((c) => c.fixable && sameChange(c, change)) &&
                !eligible.slice(0, i).some((earlier) => sameChange(earlier, change))
            if (!needed) failedChanges.push({ change, error: new StaleNeededChangeError(change) })
            return needed
        })
        const mine = valid.slice(0, 10)
        deferred.push(...valid.slice(10))

        const phase = ({ kind }: NeededChange) => {
            if (kind.startsWith('create_')) return 0
            if (['invite_to_org', 'reinvite_as_member', 'make_org_owner'].includes(kind)) return 1
            return kind.endsWith('_repo_role') ? 2 : 3
        }
        const fail = (change: NeededChange, error: unknown) => {
            if (error instanceof GitHubBudgetExceeded) deferred.push(change)
            else
                failedChanges.push({
                    change,
                    error: error instanceof Error ? error : new Error(String(error)),
                })
        }

        for (const n of [0, 1, 2, 3]) {
            const inPhase = mine.filter((change) => phase(change) === n)
            if (n === 2) {
                await this.fixRepoRoles(inPhase, deferred, fail)
                continue
            }
            for (const change of inPhase) {
                if (this.gh.callsLeft <= 0) deferred.push(change)
                else await this.fix(change).catch((error) => fail(change, error))
            }
        }

        return finish()
    }

    // Checks
    private async checkTeamSetup(
        team: Team,
    ): Promise<{ slug: string | null; leads: string | null; needed: NeededChange[] }> {
        const ids = { teamId: team.id }
        if (this.conflicts(team))
            return { slug: null, leads: null, needed: [this.slugConflict(team)] }

        const slug = team.githubSlug
        const leads = leadsSlugOf(slug)
        const hasTeam = (await this.gh.team(slug)) != null
        const hasLeads = (await this.gh.team(leads)) != null

        const needed: NeededChange[] = []
        if (!hasTeam)
            needed.push(
                this.change(
                    'create_team',
                    team.name,
                    `${team.name} has no GitHub team (${slug})`,
                    ids,
                ),
            )
        if (!hasLeads)
            needed.push(
                this.change(
                    'create_subteam',
                    leads,
                    `${team.name} has no leads subteam (${leads})`,
                    ids,
                ),
            )

        const leadsRepos = new Map(
            (await this.gh.teamRepos(leads)).map((repo) => [lc(repo.name), repo]),
        )
        for (const { name, permission } of await this.gh.teamRepos(slug)) {
            if (permission !== 'push')
                needed.push(
                    this.change('set_team_repo_role', name, `${slug} needs Write on ${name}`, ids),
                )
            if (hasLeads && leadsRepos.get(lc(name))?.permission !== 'admin')
                needed.push(
                    this.change(
                        'set_subteam_repo_role',
                        name,
                        `${leads} needs Admin on ${name}`,
                        ids,
                    ),
                )
            leadsRepos.delete(lc(name))
        }

        for (const { name } of leadsRepos.values()) {
            needed.push(
                this.change(
                    'remove_subteam_repo',
                    name,
                    `${leads} should not access ${name}; ${slug} does not own it`,
                    ids,
                ),
            )
        }
        return { slug: hasTeam ? slug : null, leads: hasLeads ? leads : null, needed }
    }

    /** Reserved teams get repo access from an org role, never from direct repo grants. */
    private async checkReservedTeam(key: ReservedTeamKey): Promise<NeededChange[]> {
        const { slug, orgRole } = this.reservedTeams[key]
        if (!(await this.gh.team(slug)))
            return [
                this.change(
                    `create_${key}_team`,
                    slug,
                    `The ${key} team ${slug} doesn't exist in GitHub`,
                ),
            ]

        const needed: NeededChange[] = []
        const role = await this.gh.orgRole(orgRole)
        if (!role)
            needed.push(
                this.change(
                    'org_role_missing',
                    orgRole,
                    `The "${orgRole}" org role doesn't exist in GitHub, so ${slug} can't be given it`,
                ),
            )
        else if (!role.teams.has(slug))
            needed.push(
                this.change(
                    `set_${key}_org_role`,
                    orgRole,
                    `${slug} needs the "${orgRole}" org role`,
                ),
            )

        for (const { name } of await this.gh.teamRepos(slug)) {
            needed.push(
                this.change(
                    `remove_${key}_repo`,
                    name,
                    `${slug} has direct access to ${name}; reserved teams get repo access from the "${orgRole}" org role only`,
                ),
            )
        }
        return needed
    }

    private async checkMembers(
        slug: string,
        desired: Dictionary,
        known: Dictionary,
        add: GitHubChangeKind,
        remove: GitHubChangeKind,
        ids: Ids = {},
    ): Promise<NeededChange[]> {
        const team = await this.gh.team(slug)
        if (!team) return []

        const needed: NeededChange[] = []
        for (const [login, userId] of desired) {
            // Someone outside the org gets their teams from the invitation; a pending invitee waits.
            const membership = await this.gh.member(login)
            if (!membership || membership.state === 'pending') continue
            const entry = team.members.get(login)
            // GitHub always reports owners as maintainers.
            if (
                entry?.state === 'active' &&
                (entry.role === 'member' || (await this.gh.isOwner(login)))
            )
                continue
            needed.push(
                await this.missing(add, login, userId, `${login} should be in ${slug}`, ids),
            )
        }
        for (const login of team.members.keys()) {
            if (!desired.has(login))
                needed.push(
                    this.stray(
                        remove,
                        login,
                        `${login} is in ${slug} but should not be`,
                        known,
                        ids,
                    ),
                )
        }
        return needed
    }

    private async checkGitHubExists(user: User): Promise<NeededChange[]> {
        const login = user.githubId!
        return (await this.gh.exists(login))
            ? []
            : [
                  this.change('github_user_not_found', login, this.notFound(login), {
                      userId: user.id,
                  }),
              ]
    }

    private async fix(change: NeededChange): Promise<void> {
        const { kind, target } = change
        const [repo, login = target] = target.split('/') // "repo/login" targets
        const team = async () => this.db.getTeam(required(change.teamId, change))
        const slug = async () => {
            const { githubSlug } = await team()
            return kind.includes('subteam') ? leadsSlugOf(githubSlug) : githubSlug
        }
        const reservedTeamKey = kind.includes('_exec_') ? 'exec' : 'leads'

        switch (kind) {
            case 'create_team':
            case 'create_subteam': {
                const created = await this.createTeam(await team())
                if (created.failed) throw new Error(created.changes[0].reason)
                return
            }
            case 'set_team_member':
            case 'set_subteam_member': {
                await this.inviteWithAccess(await this.db.getUser(required(change.userId, change)))
                return this.gh.setTeamMember(await slug(), login)
            }
            case 'delete_extra_team':
                return this.gh.deleteTeam(target)
            case 'remove_team_member':
            case 'remove_subteam_member':
                return this.gh.removeTeamMember(await slug(), login)
            case 'remove_subteam_repo':
                return this.gh.removeTeamRepo(await slug(), target)
            case 'remove_repo_collaborator':
                return this.gh.removeDirect(repo, login)
            case 'create_exec_team':
            case 'create_leads_team': {
                const { slug, name, orgRole } = this.reservedTeams[reservedTeamKey]
                await this.createGitHubTeam(name, slug)
                return this.gh.setTeamOrgRole(slug, orgRole)
            }
            case 'set_exec_org_role':
            case 'set_leads_org_role': {
                const { slug, orgRole } = this.reservedTeams[reservedTeamKey]
                return this.gh.setTeamOrgRole(slug, orgRole)
            }
            case 'remove_exec_repo':
            case 'remove_leads_repo':
                return this.gh.removeTeamRepo(this.reservedTeams[reservedTeamKey].slug, target)
            case 'add_exec_member':
            case 'add_leads_member': {
                await this.inviteWithAccess(await this.db.getUser(required(change.userId, change)))
                return this.gh.setTeamMember(this.reservedTeams[reservedTeamKey].slug, target)
            }
            case 'remove_exec_member':
            case 'remove_leads_member':
                return this.gh.removeTeamMember(this.reservedTeams[reservedTeamKey].slug, target)
            case 'make_org_owner':
            case 'invite_to_org': {
                if (await this.gh.member(target)) {
                    if (kind === 'make_org_owner') await this.gh.setOrgRole(target, 'admin')
                    return
                }
                return this.inviteWithAccess(await this.db.getUser(required(change.userId, change)))
            }
            case 'reinvite_as_member': {
                const user = await this.db.getUser(required(change.userId, change))
                if (
                    user.githubId !== target ||
                    user.execRole != null ||
                    !(await this.keepsOrgAccess(user))
                )
                    throw new StaleNeededChangeError(change)
                const membership = await this.gh.member(target)
                if (membership?.state !== 'pending' || membership.role !== 'admin')
                    throw new StaleNeededChangeError(change)
                await this.gh.removeFromOrg(target)
                return this.inviteWithAccess(user)
            }
            case 'demote_owner':
                return this.gh.setOrgRole(target, 'member')
            case 'remove_org_member':
                return this.gh.removeFromOrg(target)
            default:
                throw new Error(`${kind} can't be fixed automatically`)
        }
    }

    private async fixRepoRoles(
        changes: NeededChange[],
        deferred: NeededChange[],
        fail: (change: NeededChange, error: unknown) => void,
    ): Promise<void> {
        const capacity = Math.max(0, this.gh.callsLeft) * 50
        deferred.push(...changes.slice(capacity))
        changes = changes.slice(0, capacity)
        if (!changes.length) return

        const items: { change: NeededChange; grant: TeamRepoGrant }[] = []
        for (const change of changes) {
            try {
                const { githubSlug } = await this.db.getTeam(required(change.teamId, change))
                const subteam = change.kind === 'set_subteam_repo_role'
                items.push({
                    change,
                    grant: {
                        slug: subteam ? leadsSlugOf(githubSlug) : githubSlug,
                        repo: change.target,
                        permission: subteam ? 'admin' : 'push',
                    },
                })
            } catch (error) {
                fail(change, error)
            }
        }

        let errors: (Error | null)[]
        try {
            errors = await this.gh.setTeamRepos(items.map((item) => item.grant))
        } catch (error) {
            errors = items.map(() => (error instanceof Error ? error : new Error(String(error))))
        }
        errors.forEach((error, i) => {
            if (error) fail(items[i].change, error)
        })
    }

    /** Creates a GitHub team under the slug D1 stores (named to match it if the display name no longer does). */
    private async createGitHubTeam(name: string, slug: string, parent?: string): Promise<void> {
        const created = await this.gh.createTeam(slugOf(name) === slug ? name : slug, slug, parent)
        if (created.slug !== slug)
            throw new Error(`GitHub created slug ${created.slug} instead of ${slug}`)
    }

    private async removeMember(user: User, team: Team): Promise<void> {
        const login = user.githubId!
        if (!(await this.keepsOrgAccess(user))) return this.gh.removeFromOrg(login)

        await this.setMember(team.githubSlug, login, false)
        await this.setMember(leadsSlugOf(team.githubSlug), login, false)
        await this.setMember(this.reservedTeams.leads.slug, login, (await this.leads()).has(login))
    }

    private setMember(slug: string, login: string, member: boolean): Promise<void> {
        return member ? this.gh.setTeamMember(slug, login) : this.gh.removeTeamMember(slug, login)
    }

    // D1 reads are cached for one RPC; autoFix clears them before validation.
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
            exec: { name: exec, slug: slugOf(exec), orgRole: 'all_repo_admin' },
            leads: { name: leads, slug: slugOf(leads), orgRole: 'all_repo_maintain' },
        }
    }

    private conflicts({ githubSlug }: Team): boolean {
        return Object.values(this.reservedTeams).some(
            ({ slug }) => slug === githubSlug || slug === leadsSlugOf(githubSlug),
        )
    }

    private slugConflict(team: Team): NeededChange {
        return this.change(
            'team_slug_conflict',
            team.githubSlug,
            `${team.name}'s stored slug conflicts with a reserved team; correct its githubSlug`,
            { teamId: team.id },
        )
    }

    private teams() {
        return this.once('teams', () => this.db.listTeams())
    }

    private users() {
        return this.once('users', () => this.db.listUsers())
    }

    private assignments(ids: Ids = {}) {
        return this.once('assignments', () => this.db.listTechAssignments()).then((rows) =>
            rows.filter(
                (a) =>
                    (!ids.userId || a.user.id === ids.userId) &&
                    (!ids.teamId || a.teamId === ids.teamId),
            ),
        )
    }

    private async leads(): Promise<Dictionary> {
        return new Map(
            (await this.assignments())
                .filter(({ user, isLead }) => isLead && user.githubId)
                .map(({ user }) => [user.githubId!, user.id]),
        )
    }

    private async keepsOrgAccess({ id, execRole, status }: User): Promise<boolean> {
        if (status !== 'active') return false
        return execRole != null || (await this.assignments()).some(({ user }) => user.id === id)
    }

    private done(changes: NeededChange[]): ServiceResult {
        return { changes, failed: false }
    }

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
            fixable: !infoOf(kind)!.manual,
            blocking: !!infoOf(kind)!.blocking,
        }
    }

    private stray(
        kind: GitHubChangeKind,
        login: string,
        reason: string,
        known: Dictionary,
        ids: Ids = {},
        target = login,
    ): NeededChange {
        const userId = known.get(login)
        return this.change(kind, target, userId ? reason : `${reason} (not in database)`, {
            ...ids,
            userId,
        })
    }

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
            : this.change('github_user_not_found', login, this.notFound(login), { userId })
    }

    /** One org invitation carries all existing desired teams; further changes wait for acceptance. */
    private async inviteWithAccess(user: User): Promise<void> {
        if (!(await this.keepsOrgAccess(user)) || !user.githubId)
            throw new Error('User is not eligible for GitHub access')
        const login = user.githubId
        if (await this.gh.member(login)) return

        const teams = new Map((await this.teams()).map((team) => [team.id, team]))
        const slugs = new Set<string>()
        for (const { teamId, isLead } of await this.assignments({ userId: user.id })) {
            const team = teams.get(teamId)
            if (!team || this.conflicts(team)) continue
            slugs.add(team.githubSlug)
            if (isLead) slugs.add(leadsSlugOf(team.githubSlug)).add(this.reservedTeams.leads.slug)
        }
        if (user.execRole != null) slugs.add(this.reservedTeams.exec.slug)
        await this.gh.invite(login, user.execRole != null ? 'admin' : 'member', [...slugs])
    }

    private async pendingInvite(user: User): Promise<NeededChange[]> {
        const login = user.githubId!
        if ((await this.gh.member(login))?.state !== 'pending') return []
        return [
            this.change(
                'pending_invite',
                login,
                `${login} hasn't accepted their GitHub org invitation; the rest of their access (team memberships, ownership) is applied once they do`,
                { userId: user.id },
            ),
        ]
    }

    private noGithub(user: User): NeededChange {
        return this.change(
            'no_github_account',
            user.name,
            "User does not have a GitHub account set. Please set the user's GitHub account.",
            { userId: user.id },
        )
    }

    private notFound(login: string): string {
        return `Could not find GitHub account '${login}'. Please set the user's GitHub account.`
    }
}

function required<T>(value: T | undefined, change: NeededChange): T {
    if (value === undefined)
        throw new Error(`${change.kind} change for ${change.target} is missing an ID`)
    return value
}
