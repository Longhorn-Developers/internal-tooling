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
 * Something a service reports: an entity an action needs that doesn't exist, a setup problem,
 * or drift a sync found. Pass them to autoFix to make the fixable ones; the rest need a person
 * (e.g. a wrong github_id in D1).
 */
export type NeededChange = {
    service: string // Service.name of the service that reported it
    kind: string // service-specific, e.g. "create_team"
    teamId?: string // D1 team it is for
    userId?: string // D1 user it is for
    target: string // what is missing or wrong, e.g. a GitHub team slug or repository name
    reason: string // human-readable
    fixable: boolean // whether autoFix can make it
    blocking: boolean // an action can't run until it's fixed: a required entity is missing
}

/** A change autoFix could not make, with the error thrown. */
export type FailedChange = { change: NeededChange; error: Error }

/** What a service returns for one action. `failed` means it didn't run (or finish). */
export type ServiceResult = { changes: NeededChange[]; failed: boolean }

/** What a service's autoFix returns; `changes` are those it deferred, to resubmit. */
export type FixServiceResult = ServiceResult & { failedChanges: FailedChange[] }

/** Services that didn't complete, by name. The error is there if the service threw one. */
export type FailedServices = { [service: string]: Error | undefined }

/** What every RPC returns: every service's changes, and the services that didn't complete. */
export type RPCResult = { changes?: NeededChange[]; failedServices: FailedServices }

export type FixResult = RPCResult & { failedChanges: FailedChange[] }

/** A failed call to an external service; its fields survive Workers RPC. */
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
 * all of these; index.ts runs each action on every service.
 *
 * Services only read D1; index.ts writes it.
 *
 * - Actions first check the entities they need. If a required one doesn't exist they change
 *   nothing and return it as a blocking change with `failed: true`. Entities that exist but
 *   aren't set up right come back as non-blocking changes, and the action still runs. They never
 *   check memberships; the syncs do.
 * - Syncs only report what differs from D1 (`failed` stays false); autoFix makes the changes.
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
    ): Promise<ServiceResult>

    abstract removeUserFromTeam(user: User, team: Team): Promise<ServiceResult>

    abstract onboardUser(
        name: string,
        email: string,
        github: string | undefined,
        discord: string,
    ): Promise<ServiceResult>

    abstract deactivateUser(user: User): Promise<ServiceResult>

    abstract makeExec(user: User, execRole: ExecRole): Promise<ServiceResult>

    abstract removeExec(user: User, execRole: ExecRole): Promise<ServiceResult>

    abstract createTeam(team: Team): Promise<ServiceResult>

    abstract deleteTeam(team: Team): Promise<ServiceResult>

    /** Reports how the team differs from D1. Changes nothing. */
    abstract syncTeam(team: Team): Promise<ServiceResult>

    /** Reports what no single team covers (groups, org-wide access). Changes nothing. */
    abstract syncService(): Promise<ServiceResult>

    /** Bounded fixes; failures and deferred work returned. */
    abstract autoFix(changes: NeededChange[]): Promise<FixServiceResult>
}
