import { WorkerEntrypoint } from 'cloudflare:workers'
import type { Vertical } from './db/schema'
import { GitHubService } from './github/github-service'
import * as services from './services/all-services'
import type { Env as ServicesEnv } from './services/all-services'
import type { ExecRole, NeededChange } from './services/service'

// The Worker: other Workers call these methods through the MembershipService RPC binding.
// Each action updates D1 and every service (see services/all-services.ts).
// GitHub App credentials are secrets (see README); GITHUB_ORG/GITHUB_EXEC_TEAM are wrangler vars.
export class MembershipService extends WorkerEntrypoint<Env & ServicesEnv> {
    async onboardUser(
        name: string,
        email: string,
        github: string,
        discord: string,
    ): Promise<{ userId: string; neededChanges: NeededChange[] }> {
        return services.onboardUser(this.env, name, email, github, discord)
    }

    async addUserToTeam(
        userId: string,
        teamId: string,
        vertical: Vertical,
        isLead: boolean,
    ): Promise<NeededChange[]> {
        return services.addUserToTeam(this.env, userId, teamId, vertical, isLead)
    }

    async removeUserFromTeam(userId: string, teamId: string): Promise<void> {
        return services.removeUserFromTeam(this.env, userId, teamId)
    }

    async deactivateUser(userId: string): Promise<void> {
        return services.deactivateUser(this.env, userId)
    }

    async makeExec(userId: string, execRole: ExecRole): Promise<NeededChange[]> {
        return services.makeExec(this.env, userId, execRole)
    }

    async removeExec(userId: string, execRole: ExecRole): Promise<void> {
        return services.removeExec(this.env, userId, execRole)
    }

    async createTeam(teamId: string, name: string): Promise<void> {
        return services.createTeam(this.env, teamId, name)
    }

    async deleteTeam(teamId: string): Promise<void> {
        return services.deleteTeam(this.env, teamId)
    }

    /** Checks the team in every service. Changes nothing. */
    async syncTeam(teamId: string): Promise<NeededChange[]> {
        return services.syncTeam(this.env, teamId)
    }

    /** Sets up every user D1 assigns to the team. */
    async syncUsers(teamId: string): Promise<NeededChange[]> {
        return services.syncUsers(this.env, teamId)
    }

    /** Makes the fixable needed changes returned by the other methods. */
    async fixTeam(changes: NeededChange[]): Promise<void> {
        return services.fixTeam(this.env, changes)
    }

    // GitHub-only: repositories and the exec team.

    /** Assigns an org repository to a team (Write for the team, Admin for its dev leads). */
    async assignRepoToTeam(teamId: string, repoName: string): Promise<NeededChange[]> {
        return new GitHubService(this.env).assignRepoToTeam(teamId, repoName)
    }

    /** Removes a repository from its team; it is reported as orphaned until reassigned. */
    async unassignRepo(repoName: string): Promise<void> {
        return new GitHubService(this.env).unassignRepo(repoName)
    }

    /** Reports org repositories assigned to no team. Changes nothing. */
    async auditGithubRepos(): Promise<NeededChange[]> {
        return new GitHubService(this.env).auditRepos()
    }

    /** Checks the exec team's members and repository access. Changes nothing. */
    async syncGithubExecTeam(): Promise<NeededChange[]> {
        return new GitHubService(this.env).syncExecTeam()
    }
}
