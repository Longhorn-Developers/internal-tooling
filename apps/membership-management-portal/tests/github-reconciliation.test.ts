import assert from 'node:assert/strict'
import test from 'node:test'
import type { Team, User } from '../src/db/access'
import type { NeededChange } from '../src/service'
import { GitHubService, StaleNeededChangeError } from '../src/github/github-service'

function fixture() {
    const user = (id: string, fields: Partial<User> = {}): User => ({
        id, name: id, email: `${id}@example.com`, githubId: id, discordId: id,
        status: 'active', execRole: null, dateJoined: null, dateLeft: null, ...fields,
    })
    const users = [user('lead'), user('fellow'), user('exec', { execRole: 'President' }), user('inactive', { status: 'inactive' })]
    const teams: Team[] = [{ id: 'one', name: 'Display name', githubSlug: 'stored-slug' }]
    const assignments = [
        { user: users[0], teamId: 'one', isLead: true },
        { user: users[1], teamId: 'one', isLead: false },
    ]
    const member = (role = 'member', state = 'active') => ({ role, state })
    const members = new Map(users.slice(0, 3).map((u) => [u.id, member(u.execRole ? 'admin' : 'member')]))
    const remote = (role: string) => ({ members: new Map<string, ReturnType<typeof member>>(), repos: new Map([['repo', role], ['archive', role], ['fork', role]]) })
    const ghTeams = new Map([
        ['stored-slug', remote('push')], ['exec', remote('admin')], ['leads', remote('maintain')],
    ])
    ghTeams.get('stored-slug')!.members.set('lead', member('maintainer'))
    ghTeams.get('stored-slug')!.members.set('fellow', member())
    ghTeams.get('exec')!.members.set('exec', member('maintainer'))
    ghTeams.get('leads')!.members.set('lead', member())
    const repos = ['repo', 'archive', 'fork'].map((name) => ({ name, archived: name === 'archive', fork: name === 'fork' }))
    const direct = new Map(repos.map((r) => [r.name, new Map([['lead', 'admin']])]))
    const writes: string[] = []
    const db = {
        listUsers: async () => users,
        listTeams: async () => teams,
        listTechAssignments: async () => assignments.filter((a) => a.user.status === 'active'),
        getTeamMembers: async (id: string) => assignments.filter((a) => a.teamId === id).map((a) => ({ user: a.user, verticals: [{ vertical: 'tech', isLead: a.isLead }] })),
        getTeam: async (id: string) => { const t = teams.find((t) => t.id === id); if (!t) throw new Error('Missing team'); return t },
        getUser: async (id: string) => { const u = users.find((u) => u.id === id); if (!u) throw new Error('Missing user'); return u },
    }
    const gh = {
        callsLeft: 100,
        ensureAccounts: async () => {},
        exists: async (login: string) => login !== 'missing',
        member: async (login: string) => members.get(login),
        isOwner: async (login: string) => members.get(login)?.role === 'admin',
        orgLogins: async (role: string) => [...members].filter(([,m]) => m.role === role && m.state === 'active').map(([l]) => l),
        pendingLogins: async () => [...members].filter(([,m]) => m.state === 'pending').map(([l]) => l),
        team: async (slug: string) => ghTeams.get(slug),
        teams: async () => [...ghTeams.keys()],
        teamRepos: async (slug: string) => [...(ghTeams.get(slug)?.repos ?? [])].map(([name, permission]) => ({ name, permission })),
        repos: async () => repos,
        collaborators: async (repo: string) => direct.get(repo) ?? new Map(),
        setTeamMember: async (slug: string, login: string, role: string) => { writes.push(`team:${slug}:${login}`); ghTeams.get(slug)!.members.set(login, member(role)) },
        removeTeamMember: async (slug: string, login: string) => { writes.push(`remove-team:${slug}:${login}`); ghTeams.get(slug)?.members.delete(login) },
        setOrgRole: async (login: string, role: string) => { writes.push(`owner:${login}:${role}`); members.set(login, member(role)) },
        removeFromOrg: async (login: string) => { writes.push(`remove-org:${login}`); members.delete(login) },
        grantDirectAdmin: async (repo: string, login: string) => { writes.push(`admin:${repo}:${login}`); direct.get(repo)!.set(login, 'admin') },
        removeDirect: async (repo: string, login: string) => { writes.push(`remove-direct:${repo}:${login}`); direct.get(repo)?.delete(login) },
        deleteTeam: async (slug: string) => { writes.push(`delete:${slug}`); ghTeams.delete(slug) },
        createTeam: async (name: string, slug: string) => { writes.push(`create:${slug}`); ghTeams.set(slug, remote('push')); return { slug, name } },
        setTeamRepos: async (grants: { slug: string; repo: string; permission: string }[]) => grants.map((g) => {
            writes.push(`grant:${g.slug}:${g.repo}`); ghTeams.get(g.slug)!.repos.set(g.repo, g.permission); return null
        }),
        invite: async (login: string, role: string) => { writes.push(`invite:${login}:${role}`); members.set(login, member(role, 'pending')) },
    }
    const service = () => {
        const s = new GitHubService({ GITHUB_EXEC_TEAM: 'Exec', GITHUB_LEADS_TEAM: 'Leads' } as Cloudflare.Env, db as never)
        Object.assign(s, { gh })
        return s
    }
    const find = async (kind: string, target?: string) => {
        const change = (await service().syncService()).changes.find((c) => c.kind === kind && (!target || c.target === target))
        assert.ok(change, `Expected ${kind} ${target ?? ''}`)
        return change
    }
    const stale = async (change: NeededChange) => {
        const before = writes.length
        const r = await service().autoFix([change])
        assert.equal(r.failedChanges.length, 1)
        assert.ok(r.failedChanges[0].error instanceof StaleNeededChangeError)
        assert.equal(writes.length, before)
    }
    return { users, teams, assignments, member, members, ghTeams, direct, writes, service, find, stale, user, repos, gh }
}

test('clean scopes use stored slugs and never write', async () => {
    const f = fixture()
    assert.deepEqual((await f.service().syncService()).changes, [])
    assert.deepEqual((await f.service().syncTeam(f.teams[0])).changes, [])
    assert.deepEqual((await f.service().syncUser(f.users[0])).changes, [])
    f.teams[0].name = 'An entirely different display name'
    assert.deepEqual((await f.service().syncService()).changes, [])
    assert.equal(f.writes.length, 0)
})

test('all direct grants, archived repos, forks and owners are audited', async () => {
    const f = fixture()
    f.direct.get('archive')!.set('outsider', 'admin')
    f.direct.get('fork')!.set('exec', 'admin')
    f.direct.get('repo')!.delete('lead')
    const r = await f.service().syncService()
    for (const target of ['archive/outsider', 'fork/exec']) assert.ok(r.changes.some((c) => c.kind === 'remove_repo_collaborator' && c.target === target))
    assert.ok(r.changes.some((c) => c.kind === 'grant_repo_admin' && c.target === 'repo/lead'))
    assert.equal(f.writes.length, 0)
})

test('extra teams are selectable deletions, but adopted teams are protected', async () => {
    const f = fixture()
    f.ghTeams.set('extra', { members: new Map(), repos: new Map() })
    const change = await f.find('delete_extra_team', 'extra')
    f.teams.push({ id: 'two', name: 'Adopted', githubSlug: 'extra' })
    await f.stale(change)
    f.teams.pop()
    const r = await f.service().autoFix([change])
    assert.equal(r.failed, false)
    assert.equal(f.ghTeams.has('extra'), false)
})

test('all scopes report required accounts and related group setup', async () => {
    const f = fixture()
    f.users[2].githubId = null
    f.ghTeams.get('leads')!.repos.set('repo', 'pull')
    f.direct.get('archive')!.set('outsider', 'pull')
    const all = (await f.service().syncService()).changes
    assert.ok(all.some((c) => c.kind === 'no_github_account' && c.userId === 'exec'))
    for (const r of [await f.service().syncUser(f.users[0]), await f.service().syncTeam(f.teams[0])]) {
        assert.ok(r.changes.some((c) => c.kind === 'set_leads_repo_role'))
    }
    assert.ok((await f.service().syncTeam(f.teams[0])).changes.some((c) => c.target === 'archive/outsider'))
    assert.equal(f.writes.length, 0)
})

test('stale ownership, invitations, removals and repo attachment fixes cannot override D1', async () => {
    const f = fixture()
    f.members.get('exec')!.role = 'member'
    const promote = await f.find('make_org_owner', 'exec')
    f.users[2].execRole = null
    await f.stale(promote)

    f.members.delete('fellow')
    const invite = await f.find('invite_to_org', 'fellow')
    f.users[1].status = 'inactive'
    await f.stale(invite)

    f.members.set('fellow', f.member())
    const remove = await f.find('remove_org_member', 'fellow')
    f.users[1].status = 'active'
    await f.stale(remove)

    f.ghTeams.get('stored-slug')!.repos.set('repo', 'pull')
    const grant = await f.find('set_team_repo_role', 'repo')
    f.ghTeams.get('stored-slug')!.repos.delete('repo')
    await f.stale(grant)
})

test('fixes revalidate D1 within the same instance and reject duplicate completed work', async () => {
    const f = fixture()
    f.members.get('exec')!.role = 'member'
    const s = f.service()
    const change = (await s.syncService()).changes.find((c) => c.kind === 'make_org_owner')!
    f.users[2].execRole = null
    const result = await s.autoFix([change])
    assert.ok(result.failedChanges[0].error instanceof StaleNeededChangeError)
    assert.equal(f.writes.length, 0)

    f.direct.get('repo')!.set('outsider', 'push')
    const cleanup = await f.find('remove_repo_collaborator', 'repo/outsider')
    const r = await f.service().autoFix([cleanup, cleanup])
    assert.equal(f.writes.length, 1)
    assert.ok(r.failedChanges[0].error instanceof StaleNeededChangeError)
})

test('pending non-exec owner invitations are repaired; stale fixes are failures', async () => {
    const f = fixture()
    f.members.set('fellow', f.member('admin', 'pending'))
    const change = await f.find('reinvite_as_member', 'fellow')
    const r = await f.service().autoFix([change])
    assert.equal(r.failed, false)
    assert.deepEqual(f.members.get('fellow'), f.member('member', 'pending'))
    await f.stale(change)
})

test('service sync is the recovery path for D1-first deletion and account replacement', async () => {
    const f = fixture()
    f.teams.length = 0
    f.assignments.length = 0
    f.users[0].githubId = 'replacement'
    const changes = (await f.service().syncService()).changes
    assert.ok(changes.some((c) => c.kind === 'delete_extra_team' && c.target === 'stored-slug'))
    assert.ok(changes.some((c) => c.kind === 'remove_org_member' && c.target === 'lead'))
    assert.ok(changes.some((c) => c.kind === 'remove_repo_collaborator' && c.target === 'repo/lead'))
})

test('batch validation and loading errors preserve per-change failure reporting', async () => {
    const f = fixture()
    f.ghTeams.get('stored-slug')!.repos.set('repo', 'pull')
    const change = await f.find('set_team_repo_role', 'repo')
    f.gh.setTeamRepos = async () => { throw new Error('Request failed') }
    const r = await f.service().autoFix([change])
    assert.equal(r.failedChanges.length, 1)
    assert.equal(r.failedChanges[0].error.message, 'Request failed')
})

test('every fix kind rejects a selection after its discrepancy is resolved', async () => {
    const kinds = new Set<string>()
    const scenarios = [
        (f: ReturnType<typeof fixture>) => { f.ghTeams.clear() },
        (f: ReturnType<typeof fixture>) => {
            f.members.clear()
            for (const team of f.ghTeams.values()) team.members.clear()
        },
        (f: ReturnType<typeof fixture>) => {
            f.ghTeams.set('extra', { members: new Map(), repos: new Map() })
            for (const team of f.ghTeams.values()) {
                team.members.set('outsider', f.member())
                team.repos.set('repo', 'pull')
            }
            f.members.set('outsider', f.member('admin'))
            f.members.set('unwanted', f.member())
            f.members.get('exec')!.role = 'member'
            f.direct.get('repo')!.delete('lead')
            f.direct.get('archive')!.set('outsider', 'push')
        },
        (f: ReturnType<typeof fixture>) => { f.members.set('fellow', f.member('admin', 'pending')) },
    ]
    for (const scenario of scenarios) {
        const drifted = fixture()
        scenario(drifted)
        for (const change of (await drifted.service().syncService()).changes.filter((c) => c.fixable)) {
            kinds.add(change.kind)
            await fixture().stale(change)
        }
    }
    assert.equal(kinds.size, 20)
})

test('team scope includes unknown associated accounts and undeserved owners need removal too', async () => {
    const f = fixture()
    f.members.set('outsider', f.member('admin'))
    f.ghTeams.get('stored-slug')!.members.set('outsider', f.member())
    const changes = (await f.service().syncTeam(f.teams[0])).changes
    for (const kind of ['remove_team_member', 'demote_owner', 'remove_org_member']) {
        assert.ok(changes.some((c) => c.kind === kind && c.target === 'outsider'), kind)
    }
    assert.equal(f.writes.length, 0)
})

test('recreating a renamed D1 team preserves its stored slug', async () => {
    const f = fixture()
    f.teams[0].name = 'Renamed display name'
    f.ghTeams.delete('stored-slug')
    let createdName = ''
    const create = f.gh.createTeam
    f.gh.createTeam = async (name, slug) => { createdName = name; return create(name, slug) }
    const result = await f.service().autoFix([await f.find('create_team')])
    assert.equal(result.failed, false)
    assert.equal(createdName, 'stored-slug')
    assert.ok(f.ghTeams.has('stored-slug'))
})

test('sync validates stored accounts even without current GitHub entitlement', async () => {
    const f = fixture()
    f.users[3].githubId = 'missing'
    const changes = (await f.service().syncUser(f.users[3])).changes
    assert.ok(changes.some((c) => c.kind === 'github_user_not_found' && c.userId === 'inactive'))
    assert.equal(f.writes.length, 0)
})

test('team sync validates group permissions on its repos even when it has no leads or execs', async () => {
    const f = fixture()
    f.assignments[0].isLead = false
    f.ghTeams.get('leads')!.members.clear()
    f.ghTeams.get('exec')!.repos.set('archive', 'pull')
    f.ghTeams.get('leads')!.repos.set('fork', 'pull')
    const changes = (await f.service().syncTeam(f.teams[0])).changes
    assert.ok(changes.some((c) => c.kind === 'set_exec_repo_role' && c.target === 'archive'))
    assert.ok(changes.some((c) => c.kind === 'set_leads_repo_role' && c.target === 'fork'))
    assert.equal(f.writes.length, 0)
})

test('batch selections reject duplicates and stale entries without blocking valid grants', async () => {
    const f = fixture()
    f.ghTeams.get('stored-slug')!.repos.set('repo', 'pull')
    f.ghTeams.get('stored-slug')!.repos.set('archive', 'pull')
    const valid = await f.find('set_team_repo_role', 'repo')
    const stale = await f.find('set_team_repo_role', 'archive')
    f.ghTeams.get('stored-slug')!.repos.delete('archive')
    const result = await f.service().autoFix([valid, valid, stale])
    assert.equal(f.writes.length, 1)
    assert.equal(result.failedChanges.length, 2)
    assert.ok(result.failedChanges.every((failure) => failure.error instanceof StaleNeededChangeError))
    assert.equal(f.ghTeams.get('stored-slug')!.repos.has('archive'), false)
})

test('request limits defer work rather than silently reporting success', async () => {
    const f = fixture()
    f.direct.get('repo')!.set('outsider', 'push')
    const change = await f.find('remove_repo_collaborator', 'repo/outsider')
    f.gh.callsLeft = 0
    const result = await f.service().autoFix([change])
    assert.equal(result.failed, true)
    assert.deepEqual(result.changes, [change])
    assert.deepEqual(result.failedChanges, [])
    assert.equal(f.writes.length, 0)
})
