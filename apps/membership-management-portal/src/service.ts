import type { Vertical } from './db/schema'
import {MembershipDatabase, Team, User} from "./db/access";
import Env = Cloudflare.Env;

export const execRoles = [
    'President',
    'Product Director',
    'SWE Director',
    'Communications Director',
    'Membership Director',
    'UX Design Director',
] as const
export type ExecRole = (typeof execRoles)[number]

/**
 * Something a service needs before it can finish an action, e.g. a missing GitHub team.
 * Services return these instead of making partial changes. Pass them to fixTeam to make the
 * fixable ones; the rest need a person (e.g. a wrong github_id in D1).
 */
export type NeededChange = {
    service: string // Service.name of the service that reported it
    kind: string // service-specific, e.g. "create_team"
    teamId?: string // D1 team it is for
    userId?: string // D1 user it is for
    target: string // what is missing or wrong, e.g. a GitHub team slug or repository name
    reason: string // human-readable
    fixable: boolean // whether fixTeam can make it
}

/**
 * A failed call to an external service. `code` is also the start of the message, since only
 * the message survives Workers RPC.
 */
export class ServiceError extends Error {
    constructor(
        public service: string,
        public code: string,
        public retryable: boolean, // whether retrying can work without changing anything first
        message: string,
    ) {
        super(`${code}: ${message}`)
    }
}

/**
 * One external service (GitHub, Discord, ...) kept in sync with D1. Every service implements
 * all of these; services/all-services.ts runs each action on every service.
 *
 * Services only read D1; all-services.ts writes it.
 *
 * - Actions that return NeededChange[] check first and change nothing if anything is missing.
 * - Removals are best-effort: anything already gone is skipped.
 * - Failed API calls throw ServiceError. Actions are idempotent, so re-running one is safe.
 */
export abstract class Service {
    abstract readonly name: string

    constructor(protected readonly env: Env, protected readonly db: MembershipDatabase) {}

    abstract addUserToTeam(
        user: User,
        team: Team,
        vertical: Vertical,
        isLead: boolean,
    ): Promise<NeededChange[]>

    abstract removeUserFromTeam(user: User, team: Team): Promise<void>

    abstract onboardUser(
        name: string,
        email: string,
        github: string,
        discord: string,
    ): Promise<NeededChange[]>

    abstract deactivateUser(user: User): Promise<void>

    abstract makeExec(user: User, execRole: ExecRole): Promise<NeededChange[]>

    abstract removeExec(user: User, execRole: ExecRole): Promise<void>

    abstract createTeam(team: Team): Promise<void>

    abstract deleteTeam(team: Team): Promise<void>

    /** Checks that the team is set up in this service. Changes nothing. */
    abstract syncTeam(team: Team): Promise<NeededChange[]>

    /** Sets up each user's access to the team as D1 says, after checking the team is set up. */
    abstract syncUsers(team: Team, users: User[]): Promise<NeededChange[]>

    /** Makes the fixable changes reported by this service; others are ignored. */
    abstract autoFix(changes: NeededChange[]): Promise<void>
}
