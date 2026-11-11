import { WorkerEntrypoint } from 'cloudflare:workers'
import { Vertical } from './db/schema'
import { GitHubService } from './github/github-service'
import { handleGitHubWebhook } from './github/github-webhook'
import type {
    ExecRole,
    FailedServices,
    FixResult,
    NeededChange,
    RPCResult,
    Service,
    ServiceResult,
} from './service'
import { githubSlugOf, MembershipDatabase, slugUnavailable } from './db/access'
import Env = Cloudflare.Env

// TODO: eventually publish types in repo frontend can import

/** The details of a user that can be edited; an empty `githubId` removes it. */
type UserEdits = { name?: string; email?: string; githubId?: string | null; discordId?: string }

const toError = (error: unknown) => (error instanceof Error ? error : new Error(String(error)))

class InactiveUserError extends Error {
    constructor(public readonly userId: string) {
        super(`Attempted to modify an inactive user: ${userId}`)
    }
}

// Public HTTP goes only to the GitHub webhook; MembershipService has no fetch, so its RPC
// methods are reachable only through service bindings.
export default { fetch: handleGitHubWebhook } satisfies ExportedHandler<Env>

// The Worker: other Workers call these methods through the MembershipService RPC binding.
// Each action updates D1 and then runs on every service; every RPC returns the changes the
// services need and the names of those that didn't complete (see RpcResult).
// GitHub App credentials are secrets (see README); GITHUB_ORG/GITHUB_EXEC_TEAM/GITHUB_LEADS_TEAM
// are wrangler vars.
export class MembershipService extends WorkerEntrypoint {
    // instance (so services) per RPC call
    private readonly db = new MembershipDatabase(this.env.membership_db!)
    private readonly allServices: Service[] = [new GitHubService(this.env, this.db)]

    private async run(
        action: (service: Service) => Promise<ServiceResult>,
        services = this.allServices,
    ): Promise<RPCResult> {
        const changes: NeededChange[] = []
        const failedServices: FailedServices = {}
        for (const service of services) {
            try {
                const result = await action(service)
                changes.push(...(result.changes ?? []))
                if (result.failed) failedServices[service.name] = undefined
            } catch (error) {
                failedServices[service.name] = toError(error)
            }
        }
        return { changes: changes.length ? changes : undefined, failedServices }
    }

    async onboardUser(
        name: string,
        email: string,
        github: string | undefined,
        discord: string,
    ): Promise<RPCResult & { userId: string }> {
        // *could* error, but really shouldn't
        const user = await this.db.createUser({
            name,
            email: email.toLowerCase(),
            githubId: github?.toLowerCase(),
            discordId: discord.toLowerCase(),
            status: 'active',
        })

        const result = await this.run((s) =>
            s.onboardUser(user.name, user.email, user.githubId ?? undefined, user.discordId),
        )

        return {
            userId: user.id,
            ...result,
            ...(result.changes
                ? { changes: result.changes.map((change) => ({ ...change, userId: user.id })) }
                : {}),
        }
    }

    /** Changes a user's details; a changed GitHub account moves their access in the services. */
    async updateUser(userId: string, edits: UserEdits): Promise<RPCResult> {
        // validates the user
        const before = await this.db.getUser(userId)

        const data = {
            ...(edits.name !== undefined && { name: edits.name }),
            ...(edits.email !== undefined && { email: edits.email.toLowerCase() }),
            ...(edits.githubId !== undefined && {
                githubId: edits.githubId?.toLowerCase() || null,
            }),
            ...(edits.discordId !== undefined && { discordId: edits.discordId.toLowerCase() }),
        }
        if (!Object.keys(data).length) return { failedServices: {} }

        const after = await this.db.updateUser(userId, data)

        return this.run((s) => s.updateUser(before, after))
    }

    async addUserToTeam(
        userId: string,
        teamId: string,
        vertical: Vertical,
        isLead: boolean,
    ): Promise<RPCResult> {
        // validates the user and team
        const user = await this.db.getUser(userId)
        if (user.status != 'active') throw new InactiveUserError(userId)

        const team = await this.db.getTeam(teamId)

        // validates the vertical
        await this.db.assignVertical(userId, teamId, vertical, isLead)

        return this.run((s) => s.addUserToTeam(user, team, vertical, isLead))
    }

    async removeUserFromTeam(userId: string, teamId: string): Promise<RPCResult> {
        // validates the user and team
        const user = await this.db.getUser(userId)
        const team = await this.db.getTeam(teamId)

        await this.db.removeUserFromTeam(userId, teamId)

        return this.run((s) => s.removeUserFromTeam(user, team))
    }

    async deactivateUser(userId: string): Promise<RPCResult> {
        // validates the user
        const user = await this.db.deactivateUser(userId)

        return this.run((s) => s.deactivateUser(user))
    }

    async makeExec(userId: string, execRole: ExecRole): Promise<RPCResult> {
        // validates the user and exec role
        const user = await this.db.updateUser(userId, { execRole: execRole })

        return this.run((s) => s.makeExec(user, execRole))
    }

    async removeExec(userId: string): Promise<RPCResult> {
        // validates the user
        const { execRole } = await this.db.getUser(userId)
        if (!execRole) return { failedServices: {} }

        // validates the exec role
        const user = await this.db.updateUser(userId, { execRole: null })

        return this.run((s) => s.removeExec(user, execRole))
    }

    async createTeam(name: string): Promise<RPCResult> {
        const slug = githubSlugOf(name)
        if (
            slugUnavailable(
                slug,
                [this.env.GITHUB_EXEC_TEAM, this.env.GITHUB_LEADS_TEAM].map(githubSlugOf),
            )
        ) {
            throw new Error(`Invalid or reserved GitHub team slug: ${slug}`)
        }
        const team = await this.db.createTeam({ name })

        return this.run((s) => s.createTeam(team))
    }

    async deleteTeam(teamId: string): Promise<RPCResult> {
        const team = await this.db.deleteTeam(teamId)
        if (team == null) return { failedServices: {} }

        return this.run((s) => s.deleteTeam(team))
    }

    /** Reports how the team differs from D1 in every service. Changes nothing. */
    async syncTeam(teamId: string): Promise<RPCResult> {
        // validates the team
        const team = await this.db.getTeam(teamId)

        return this.run((s) => s.syncTeam(team))
    }

    /** Reports how one user differs from D1 in every service. Changes nothing. */
    async syncUser(userId: string): Promise<RPCResult> {
        // validates the user
        const user = await this.db.getUser(userId)

        return this.run((s) => s.syncUser(user))
    }

    /** Audits all modeled state in one service. Changes nothing. */
    async syncService(service: string): Promise<RPCResult> {
        const found = this.allServices.find((s) => s.name === service)
        if (!found) throw new Error(`Unknown service: ${service}`)

        return this.run((s) => s.syncService(), [found])
    }

    /** Runs syncService on every service. */
    async syncAll(): Promise<RPCResult> {
        return this.run((s) => s.syncService())
    }

    /**
     * Makes the fixable changes; `changes` are those deferred (resubmit them), `failedChanges`
     * those that errored, and `rejected` those that need a person or aren't supported.
     */
    async autoFix(changes: NeededChange[]): Promise<FixResult> {
        const result: FixResult = { failedServices: {}, failedChanges: [], rejected: [] }
        result.rejected.push(
            ...changes.filter((change) => !this.allServices.some((s) => s.name === change.service)),
        )
        const deferred: NeededChange[] = []
        for (const s of this.allServices) {
            try {
                const next = await s.autoFix(changes.filter((change) => change.service === s.name))
                deferred.push(...(next.changes ?? []))
                result.failedChanges.push(...next.failedChanges)
                result.rejected.push(...next.rejected)
                if (next.failed) result.failedServices[s.name] = undefined
            } catch (error) {
                result.failedServices[s.name] = toError(error)
            }
        }
        if (deferred.length) result.changes = deferred
        return result
    }
}
