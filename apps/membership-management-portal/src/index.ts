import {WorkerEntrypoint} from 'cloudflare:workers'
import {Vertical} from './db/schema'
import { GitHubService } from './github/github-service'
import type {ExecRole, NeededChange, Service} from './service'
import {MembershipDatabase, today} from "./db/access";
import Env = Cloudflare.Env;

// TODO: eventually publish types in repo frontend can import

class InactiveUserError extends Error{
    constructor(public readonly userId: string){
        super(`Attempted to modify an inactive user: ${userId}`);
    }
}

// The Worker: other Workers call these methods through the MembershipService RPC binding.
// Each action updates D1 and every service (see services/all-services.ts).
// GitHub App credentials are secrets (see README); GITHUB_ORG/GITHUB_EXEC_TEAM are wrangler vars.
export class MembershipService extends WorkerEntrypoint<Env> {
    allServices: Service[] = [new GitHubService(this.env, this.db)];

    private async collect(
        run: (service: Service) => Promise<NeededChange[]>,
    ): Promise<NeededChange[]> {
        const needed: NeededChange[] = []
        for (const service of this.allServices) needed.push(...(await run(service)))
        return needed
    }

    private async onEach(run: (service: Service) => Promise<void>): Promise<void> {
        for (const service of this.allServices) await run(service)
    }

    database: MembershipDatabase|undefined = undefined;
    private get db(): MembershipDatabase {
        return (this.database ??= new MembershipDatabase(this.env.membership_db));
    }

    async onboardUser(
        name: string,
        email: string,
        github: string,
        discord: string,
    ): Promise<{ userId: string; neededChanges: NeededChange[] }> {
        // *could* error, but really shouldn't
        const user = await this.db.createUser({
            name,
            email: email.toLowerCase(),
            githubId: github.toLowerCase(),
            discordId: discord.toLowerCase(),
            status: 'active',
        });

        const needed = await this.collect(
            (s) => s.onboardUser(name, email, github, discord))

        return {
            userId: user.id,
            neededChanges: needed.map((change) => ({ ...change, userId: user.id })),
        }
    }

    async addUserToTeam(
        userId: string,
        teamId: string,
        vertical: Vertical,
        isLead: boolean,
    ): Promise<NeededChange[]> {
        // validates the user and team
        const user = await this.db.getUser(userId);
        if (user.status != 'active') throw new InactiveUserError(userId);

        const team = await this.db.getTeam(userId);

        // validates the vertical
        await this.db.assignVertical(userId, teamId, vertical, isLead);

        return this.collect((s) =>
            s.addUserToTeam(user, team, vertical, isLead))
    }

    async removeUserFromTeam(userId: string, teamId: string): Promise<void> {
        // validates the user and team
        const user = await this.db.getUser(userId);
        const team = await this.db.getTeam(userId);

        await this.db.removeUserFromTeam(userId, teamId);

        await this.onEach((s) => s.removeUserFromTeam(user, team))
    }

    async deactivateUser(userId: string): Promise<void> {
        // validates the user
        const user = await this.db.updateUser(userId,
            { status: 'inactive', dateLeft: today() });
        await this.db.removeUserFromAllTeams(userId);

        await this.onEach((s) => s.deactivateUser(user))
    }

    async makeExec(userId: string, execRole: ExecRole): Promise<NeededChange[]> {
        // validates the user and exec role
        const user = await this.db.updateUser(userId,
            { execRole: execRole });

        return this.collect((s) => s.makeExec(user, execRole))
    }

    async removeExec(userId: string): Promise<void> {
        // validates the user
        const {execRole} = await this.db.getUser(userId);
        if (!execRole) return;

        // validates the exec role
        const user = await this.db.updateUser(userId, { execRole: null });

        await this.onEach((s) => s.removeExec(user, execRole))
    }

    async createTeam(name: string): Promise<void> {
        const team = await this.db.createTeam({ name });

        await this.onEach((s) => s.createTeam(team))
    }

    async deleteTeam(teamId: string): Promise<void> {
        const team = await this.db.deleteTeam(teamId)
        if (team == null) return;

        await this.onEach((s) => s.deleteTeam(team))
    }

    /** Checks the team in every service. Changes nothing. */
    async syncTeam(teamId: string): Promise<NeededChange[]> {
        // validates the team
        const team = await this.db.getTeam(teamId);

        return this.collect((s) => s.syncTeam(team))
    }

    /** Sets up every user D1 assigns to the team. */
    async syncUsers(teamId: string): Promise<NeededChange[]> {
        // validates the team
        const team = await this.db.getTeam(teamId);
        const users = (await this.db.getTeamMembers(teamId))
            .map(({ user }) => user)

        return this.collect((s) => s.syncUsers(team, users))
    }

    /** Makes the fixable needed changes returned by the other methods. */
    async autoFix(changes: NeededChange[]): Promise<void> {
        await this.onEach((s) =>
            s.autoFix(changes.filter((change) => change.service === s.name)))
    }

    // GitHub-only: orphaned repositories and the exec team.

    /** Reports org repositories that no team's GitHub team has access to. Changes nothing. */
    async auditGithubRepos(): Promise<NeededChange[]> {
        return new GitHubService(this.env).auditRepos()
    }

    /** Checks the exec team's members and repository access. Changes nothing. */
    async syncGithubExecTeam(): Promise<NeededChange[]> {
        return new GitHubService(this.env).syncExecTeam()
    }
}
