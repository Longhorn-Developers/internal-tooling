import { WorkerEntrypoint } from 'cloudflare:workers'
import {
    assignRepoToTeam,
    auditRepos,
    syncAll,
    syncExecTeam,
    syncTeam,
    unassignRepoFromTeam,
} from './github/sync'
import type { Env as SyncEnv, SyncReport } from './github/sync'

// GitHub App credentials are secrets (see README); GITHUB_ORG/GITHUB_EXEC_TEAM are wrangler vars.
export class MembershipService extends WorkerEntrypoint<Env & SyncEnv> {
    /** Assigns an org repository to a team and applies Write for the team and Admin for its dev leads. */
    async assignRepoToTeam(teamId: string, repoName: string): Promise<SyncReport> {
        return assignRepoToTeam(this.env, teamId, repoName)
    }

    /** Removes a repository from its team; it is reported as orphaned until reassigned. */
    async unassignRepo(repoName: string): Promise<SyncReport> {
        return unassignRepoFromTeam(this.env, repoName)
    }

    /** Creates or updates one team's GitHub team, members, maintainers, and repo permissions. */
    async syncGithubTeam(teamId: string): Promise<SyncReport> {
        return syncTeam(this.env, teamId)
    }

    /** Syncs the exec team: active execs as members, Admin on every non-archived repository. */
    async syncGithubExecTeam(): Promise<SyncReport> {
        return syncExecTeam(this.env)
    }

    /** Flags orphaned repositories without changing anything. */
    async auditGithubRepos(): Promise<SyncReport> {
        return auditRepos(this.env)
    }

    /** Syncs every project team and the exec team, then flags orphaned repositories. */
    async syncGithub(): Promise<SyncReport> {
        return syncAll(this.env)
    }
}
