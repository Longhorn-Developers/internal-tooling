import {
    assignVertical,
    createTeam as createTeamRow,
    createUser,
    deleteTeam as deleteTeamRow,
    getTeamMembers,
    removeVertical,
    updateUser,
} from '../db/access'
import { verticalNames } from '../db/schema'
import type { Vertical } from '../db/schema'
import { GitHubService } from '../github/github-service'
import type { Env as GitHubEnv } from '../github/github-service'
import type { ExecRole, NeededChange, Service } from './service'

// Every service's bindings, vars, and secrets.
export type Env = GitHubEnv

/** Every service kept in sync with D1. Add new services here. */
export function allServices(env: Env): Service[] {
    return [new GitHubService(env)]
}

// Each action below writes D1 (the source of truth) first, except deleteTeam, then runs on every
// service. A service that returns needed changes made none of its own; fix them with fixTeam,
// then run the action (or syncUsers) again.

async function collect(
    env: Env,
    run: (service: Service) => Promise<NeededChange[]>,
): Promise<NeededChange[]> {
    const needed: NeededChange[] = []
    for (const service of allServices(env)) needed.push(...(await run(service)))
    return needed
}

async function onEach(env: Env, run: (service: Service) => Promise<void>): Promise<void> {
    for (const service of allServices(env)) await run(service)
}

const today = () => new Date().toISOString().slice(0, 10)

function requireUpdated<T>(row: T | null, userId: string): T {
    if (!row) throw new Error(`User ${userId} not found`)
    return row
}

/** Creates an active user and sets up their accounts. */
export async function onboardUser(
    env: Env,
    name: string,
    email: string,
    github: string,
    discord: string,
): Promise<{ userId: string; neededChanges: NeededChange[] }> {
    const user = await createUser(env.membership_db, {
        id: crypto.randomUUID(),
        name,
        email,
        githubId: github,
        discordId: discord,
        status: 'active',
        dateJoined: today(),
    })
    const needed = await collect(env, (s) => s.onboardUser(name, email, github, discord))
    return {
        userId: user.id,
        neededChanges: needed.map((change) => ({ ...change, userId: user.id })),
    }
}

export async function addUserToTeam(
    env: Env,
    userId: string,
    teamId: string,
    vertical: Vertical,
    isLead: boolean,
): Promise<NeededChange[]> {
    await assignVertical(env.membership_db, userId, teamId, vertical, isLead)
    return collect(env, (s) => s.addUserToTeam(userId, teamId, vertical, isLead))
}

/** Removes the user from every vertical of the team. */
export async function removeUserFromTeam(env: Env, userId: string, teamId: string): Promise<void> {
    for (const vertical of verticalNames) {
        await removeVertical(env.membership_db, userId, teamId, vertical)
    }
    await onEach(env, (s) => s.removeUserFromTeam(userId, teamId))
}

/** Marks the user inactive (their team assignments are kept) and removes their access. */
export async function deactivateUser(env: Env, userId: string): Promise<void> {
    requireUpdated(
        await updateUser(env.membership_db, userId, { status: 'inactive', dateLeft: today() }),
        userId,
    )
    await onEach(env, (s) => s.deactivateUser(userId))
}

// D1 only records whether a user is an exec, not which role, so callers pass the role.
export async function makeExec(
    env: Env,
    userId: string,
    execRole: ExecRole,
): Promise<NeededChange[]> {
    requireUpdated(await updateUser(env.membership_db, userId, { isExec: true }), userId)
    return collect(env, (s) => s.makeExec(userId, execRole))
}

export async function removeExec(env: Env, userId: string, execRole: ExecRole): Promise<void> {
    requireUpdated(await updateUser(env.membership_db, userId, { isExec: false }), userId)
    await onEach(env, (s) => s.removeExec(userId, execRole))
}

export async function createTeam(env: Env, teamId: string, name: string): Promise<void> {
    await createTeamRow(env.membership_db, { id: teamId, name })
    await onEach(env, (s) => s.createTeam(teamId))
}

/** Removes the team from every service, then deletes it and its assignments from D1. */
export async function deleteTeam(env: Env, teamId: string): Promise<void> {
    await onEach(env, (s) => s.deleteTeam(teamId))
    await deleteTeamRow(env.membership_db, teamId)
}

export async function syncTeam(env: Env, teamId: string): Promise<NeededChange[]> {
    return collect(env, (s) => s.syncTeam(teamId))
}

/** Syncs every user D1 assigns to the team. */
export async function syncUsers(env: Env, teamId: string): Promise<NeededChange[]> {
    const userIds = (await getTeamMembers(env.membership_db, teamId)).map(({ user }) => user.id)
    return collect(env, (s) => s.syncUsers(teamId, userIds))
}

/** Gives each service the changes it reported. */
export async function fixTeam(env: Env, changes: NeededChange[]): Promise<void> {
    await onEach(env, (s) => s.fixTeam(changes.filter((change) => change.service === s.name)))
}
