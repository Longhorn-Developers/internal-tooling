```txt
npm install
npm run dev
```

```txt
npm run deploy
```

[For generating/synchronizing types based on your Worker configuration run](https://developers.cloudflare.com/workers/wrangler/commands/#types):

```txt
npm run cf-typegen
```

# Membership Management Portal

Run the offline reconciliation and in-memory SQLite tests with `pnpm test` (Node 24+).

## Purpose

LHD frequently has new members joining in that need access to software and old members graduating that should be removed from said software. This portal attempts to ease this process of editing permissions for, adding, or removing members of LHD.

## Scope

Currently, we plan to manage accounts for Linear, Figma, Discord, Notion, and Github. This is all software in which users have external accounts and are added into the club's group. What's currently outside of our scope is software the club uses such as Cloudflare and any future SSO.

## Database

The D1 database has three tables: `users`, `teams`, and `team_users`. Users can
belong to multiple teams, with one or more verticals (`product`, `tech`,
`design`) per team. Each assignment has an `isLead` flag, so a vertical can have
co-leads, but a user is either a lead or not within one team and vertical. Users
have a `status` (`applicant`, `active`, `inactive`, `alum`; defaults to
`active`), an optional `execRole`, and optional `dateJoined` / `dateLeft` fields
(`YYYY-MM-DD`). Status and vertical values are enforced with CHECK constraints.

Teams store a unique, non-null `githubSlug`, generated on insertion and independent of
their display names. GitHub IDs (nullable) and Discord IDs are unique; email uniqueness
uses `lower(email)`. Names are not unique. User creation and editing trim identities and
lowercase email and GitHub IDs; an empty GitHub ID becomes null. Team creation rejects
empty slugs, slugs ending in `-leads` (reserved for each team's GitHub leads subteam; a CHECK
constraint enforces this too), and slugs that equal, or whose subteam slug equals, the exec or
leads group's slug.

Run these commands from this app's directory to initialize remote D1 using the
database binding in `wrangler.jsonc`. No `.env` file is needed with Wrangler login:

```sh
npm install
npx wrangler login
npm run db:migrate
```

The initial migration creates the tables. Wrangler tracks applied migrations,
so rerunning is safe.

After changing `src/db/schema.ts`, run `npm run db:generate`, review and commit
the generated SQL and `drizzle/meta` files, then run `npm run db:migrate`.
The deployed Worker accesses D1 through `this.env.membership_db`.

## Database access helpers

Use `MembershipDatabase` from `src/db/access.ts` with the D1 binding:

```ts
import { MembershipDatabase } from './db/access';

const db = new MembershipDatabase(this.env.membership_db);
const user = await db.getUser(userId);
await db.assignVertical(userId, teamId, 'tech', true); // as lead
```

Available helpers include `createUser`, `updateUser`, `getUser`,
`getTeamMembers`, `assignVertical`, `removeVertical`, `createTeam`, and `deleteTeam`. Create users and teams before assigning
verticals. `getTeamMembers` returns `{ user, verticals: { vertical, isLead }[] }[]`.
`assignVertical` inserts the assignment or updates `isLead` on an existing one;
assignment/removal helpers return no value. Database errors reject the promise.

## Services

Each external service is a subclass of `Service` (`src/service.ts`), which declares
the same actions for every service. `src/index.ts` runs each action on every
service in `allServices` after writing D1, which is always the source of truth. Failed
external operations do not roll back D1: run sync and apply its current corrections to recover.
The Worker
(`src/index.ts`) exposes them through the `MembershipService` RPC binding:

| Method | Does |
| --- | --- |
| `onboardUser(name, email, github, discord)` | creates an active user; also returns `userId` |
| `addUserToTeam(userId, teamId, vertical, isLead)` | assigns the vertical, then sets up access |
| `removeUserFromTeam(userId, teamId)` | removes every vertical on the team and its access |
| `deactivateUser(userId)` | atomically marks the user inactive and removes D1 assignments, then removes external access |
| `updateUser(userId, { name?, email?, githubId?, discordId? })` | edits the user; a changed or removed `githubId` moves their GitHub access (the old account is removed from the org, the new one set up) |
| `makeExec(userId, execRole)` / `removeExec(userId)` | sets the exec role and exec access |
| `createTeam(name)` / `deleteTeam(teamId)` | creates or deletes the team everywhere |
| `syncTeam(teamId)` | reports how the team differs from D1 in every service; changes nothing |
| `syncUser(userId)` | reports how one user differs from D1 in every service; changes nothing |
| `syncService(service)` / `syncAll()` | comprehensively audits all modeled state in one or every service; changes nothing |
| `autoFix(changes)` | attempts up to 10 valid changes per service; also returns `failedChanges: FailedChange[]`, `rejected: NeededChange[]` (manual or unsupported; never attempted), and the deferred changes as `changes` |

Every RPC returns `RPCResult`: `{ changes?: NeededChange[], failedServices: { [service]: Error? } }`
(`src/service.ts`). A service that didn't complete is a key in `failedServices`; its value is the
error if the service threw one, and undefined if it was blocked by a missing entity. Services
return `ServiceResult`, `{ changes: NeededChange[], failed: boolean }`. A `NeededChange` is
`{ service, kind, teamId?, userId?, target, reason, fixable, blocking }`.

Before an action changes anything, each service checks the entities it needs:

- A required entity that doesn't exist (a team, a group, the user's account) comes back as a
  `blocking` change. The service then changes nothing and is listed in `failedServices`.
- An entity that exists but isn't set up right (e.g. missing a repository role) comes back as an
  non-blocking change, and the action still runs and counts as completed.
- Memberships are never checked by actions; the syncs report them. Syncs and `autoFix` don't
  gate anything: a sync's `changes` are drift, almost all `fixable`.

Pass `changes` to `autoFix`, which makes the `fixable` ones; the others need a person (e.g. a
wrong `github_id`) and come back in `rejected`, never attempted. Only `failedChanges` mark a
service as failed (`failedServices`); deferred and rejected changes are just returned. Only some kinds are `blocking` (below); let the user choose which of the rest
to pass. A change with no `userId` is for an account that isn't in D1.
Unknown kinds and service names are also rejected, not silently discarded or treated as stale.
Every selected fix is validated once, up front, against fresh D1 reads and the per-RPC GitHub
snapshot, before anything is written. A correction no longer justified (or selected twice) is
returned as a `StaleNeededChangeError` in `failedChanges`, including already-completed removals.
Stale and duplicate selections do not consume the ten valid-fix slots.
A selection that an earlier fix in the same call happens to satisfy (an invitation covering a
team membership) is not a failure. Resubmit the changes `autoFix` returns (they
were deferred); a request-budget guard can defer work before ten changes finish. Completed
writes are not rolled back if a later write fails.

Failed API calls throw a `ServiceError` (fields `service`, `code`, `retryable`; GitHub's adds
`status`) whose message starts with its code. Its fields survive Workers RPC, and `autoFix`
returns the thrown error itself in each `failedChanges` entry. Recover failed actions by syncing
current state, not by replaying an old RPC or correction.

## GitHub

`GitHubService` uses `GitHubOrg` in `src/github/github-api.ts`: an Octokit-backed, per-RPC
snapshot of members, invitations, teams, repository permissions and direct collaborators.
GraphQL reads are paginated; pending org invitation roles come from REST. The first read or write that needs it loads the snapshot; later reads use memory.
Writes skip unchanged state and update the snapshot only after remote success. Team repository
grants are batched with GraphQL, falling back to REST for rejected mutations. Partial successes
update only their own entries. Other writes use REST.

- Every team has a GitHub team identified by its stored `githubSlug` (initially e.g.
  `UT Dining` → `ut-dining`). Changing the D1 display name does not change its identity.
  When recreating a missing team after a display-name change, its stored slug is used as
  the GitHub name if necessary to preserve that identity.
- GitHub is the source of truth for repositories: a team's repositories are the ones its GitHub
  team has access to. Add or remove them in the GitHub team's settings.
- The team has Write on its repositories. Every active `tech` member, lead or not, is a plain
  member of it. Each team also has a child GitHub team, `<githubSlug>-leads` ("<name> Leads"),
  holding exactly the team's tech leads, with Admin on the same repositories. Team slugs ending
  in `-leads` are rejected so the two never collide. Other verticals get no GitHub access.
  When the parent drops a repository, sync reports a non-blocking, fixable `remove_subteam_repo`
  for any access its leads subteam retains. Applying it removes only that subteam's grant;
  other teams' access stays intact.
- Repositories have team access only: any direct collaborator is reported as
  `remove_repo_collaborator`. (The leads subteam's parent link is set on creation, not audited.)
- Every active tech lead of any team is also on the org-wide leads group, which has Maintain on every
  repository, including archived repositories and forks.
- Every active exec is on the exec team, which has Admin on every repository, and
  is an org owner. Every exec role gets the same access. An exec who also leads a team gets all
  of it; owners get no exemptions.
- `GITHUB_EXEC_TEAM` and `GITHUB_LEADS_TEAM` are team *names*: slugified to find the team, used
  as-is to create it.
- Org membership follows active tech assignments: active users with a tech assignment (and active execs) are in the
  org, nobody else. Joining a tech team invites them; leaving their last tech assignment, losing
  exec with no tech assignment, or being deactivated removes them (owners too). `onboardUser`
  only checks the account exists.
- Only org invitations are ever sent, never repository invitations. New users get one
  `POST /orgs/{org}/invitations` with their org role and all existing teams D1 assigns them
  (including leads subteams and the leads and exec groups when applicable). GitHub doesn't document
  adding someone with a pending invitation to another team, so nothing else is sent until they
  accept: further team memberships and ownership wait. Actions and `syncUser`/`syncService` report that
  as a non-blocking `pending_invite` (needs the invitee); once they accept, the webhook (or the
  next sync and `autoFix`) applies the rest. An invitation's role can't be changed through the API, so an exec
  invited as a member is made an owner after they accept; `removeExec` on a pending owner cancels
  and re-invites them as a member.
- A pending owner invitation for a non-exec is reported as the fixable, non-blocking
  `reinvite_as_member`. The fix checks their current role, cancels the invitation and sends a
  member invitation including their current teams. This is not atomic: if sending fails after
  cancellation, a new sync reports the missing invitation; the old correction is stale.
- Invitations expire after 7 days, and an org can send only 50 per 24 hours (500 once it is a
  month old or on a paid plan; GitHub answers `GITHUB_VALIDATION_FAILED`). An expired invitation
  is just a missing member again, so the next sync reports `invite_to_org`; run the syncs
  periodically, and spread a large first import over days if the org is new.
- Access beyond this is reported by the syncs. Changes for accounts not in D1 have no `userId`.
  Every GitHub team outside the stored D1 slugs and the two reserved groups produces a
  selectable `delete_extra_team` in service-wide sync only; user/team sync never offers
  whole-team deletion. Nothing is deleted just by syncing.

What actions require: `addUserToTeam` needs the team's GitHub team, the user's GitHub account and
(for a lead) the team's leads subteam and the leads group; `makeExec` needs the exec team and the
account; `onboardUser` needs the account. A missing one is a `blocking` change (`create_team`,
`create_subteam`, `create_{exec,leads}_team`, `github_user_not_found`, `team_slug_conflict`) and the
action doesn't run. Blocking depends only on the kind; an action just doesn't check what it doesn't
need, so adding a fellow never reports `create_subteam`. Every other kind is non-blocking, including the repository roles a team,
subteam or group lacks (`set_team_repo_role`, `set_subteam_repo_role`, `set_{exec,leads}_repo_role`).

All sync scopes use one read-only audit. `syncTeam` includes only the chosen team's setup (team and
subteam), memberships, every direct grant on its attached repositories, and account/invitation
issues affecting its active tech members. It excludes other teams' memberships, reserved-group
setup and org-wide corrections.
`syncUser` includes the user's desired and extra memberships, org role, direct
grants, related team setup and required group setup. `syncService("github")` audits every D1
team and relevant account, both reserved groups, all org memberships/invitations, every extra
GitHub team and every direct repository grant, including owners, archived repos and forks.
Orphan repositories remain informational: attach them manually rather than guessing a team.
After an account replacement or team deletion, use service-wide sync to find access belonging
to identities no longer represented in D1. A sync failure is not a clean bill of health;
inspect `failedServices`. Snapshots are not atomic with concurrent external edits.

GitHub account existence is checked only for active users. Inactive users' remaining access is
still reported for removal; an unwanted owner is removed rather than also being offered a demotion.

When a user accepts their
org invitation the webhook runs `addUserToTeam` for each of their tech teams and `makeExec` if
they're an exec. That also covers teams, roles or an exec role changed while they were pending
(an invitation's own role can't change). A blocking change fails that action, to be fixed later,
and a user who shouldn't be in the org is only reported (`remove_org_member`).

Change kinds: `create_team`, `create_subteam`, `delete_extra_team`, `set_team_member`,
`remove_team_member`, `set_subteam_member`, `remove_subteam_member`, `set_team_repo_role`,
`set_subteam_repo_role`, `remove_subteam_repo`, `remove_repo_collaborator`, `create_{exec,leads}_team`,
`set_{exec,leads}_repo_role`, `add_{exec,leads}_member`, `remove_{exec,leads}_member`,
`make_org_owner`, `demote_owner`, `invite_to_org`, `reinvite_as_member`, `remove_org_member` are fixable;
`github_user_not_found`, `no_github_account`, `pending_invite`, `orphan_repo`, `team_slug_conflict` need a person.
A change's `target` is a login, repository, or team name, or `repo/login` for per-user
repository access.

| Error code | Usually means | Resolve |
| --- | --- | --- |
| `GITHUB_BAD_CREDENTIALS` | wrong or revoked app secrets | fix the secrets |
| `GITHUB_NOT_FOUND` | something was deleted since the check | run `syncTeam`, then `autoFix` |
| `GITHUB_FORBIDDEN` | the GitHub App lacks a permission | fix the app, then retry |
| `GITHUB_RATE_LIMITED` | too many requests | retry after a few minutes |
| `GITHUB_VALIDATION_FAILED` | GitHub rejected it (e.g. no free seats, or the daily invitation limit) | fix in GitHub by hand, or wait |
| `GITHUB_UNAVAILABLE` | GitHub outage | retry |
| `GITHUB_ERROR` | anything else | see the message |

Setup: an org owner creates a GitHub App owned by the org (org Settings → Developer settings →
GitHub Apps) with **Organization → Members** and **Repository → Administration** set to read and
write and the webhook below, then installs it on the org with access to all repositories. Each org
needs its own app (e.g. LHD-Staging for testing, Longhorn-Developers for production).

Webhook: set the app's webhook URL to `https://webhook.longhorndevelopers.org/mmp-github`
(`webhook.staging.…` for staging), choose a secret, store it as `GITHUB_WEBHOOK_SECRET`, and
subscribe the app to the **Organization** event. On `member_added` (an org invitation was
accepted) the Worker re-applies the user's team, repository and owner access
(`GitHubService.onJoinedOrg`), after replying `202` since GitHub gives up after 10 seconds.
Deliveries are rejected unless their `X-Hub-Signature-256` matches. This is the Worker's only HTTP
surface; the RPC methods are on `MembershipService`, reachable only through service bindings.
GitHub doesn't redeliver failed deliveries, so `syncAll` and `autoFix` remain the backstop.

GitHub downloads the private key as PKCS#1, but Workers only accept PKCS#8, so convert it once:

```sh
openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in app.private-key.pem -out app-pkcs8.pem
```

Then store the app ID, installation ID (the number at the end of the installation's settings
URL), and converted key as secrets:

```sh
pnpm exec wrangler secret put GITHUB_APP_ID
pnpm exec wrangler secret put GITHUB_APP_INSTALLATION_ID
pnpm exec wrangler secret put GITHUB_APP_PRIVATE_KEY < app-pkcs8.pem
pnpm exec wrangler secret put GITHUB_WEBHOOK_SECRET
```

For local testing, put the same values in `.dev.vars` (gitignored) with `GITHUB_ORG=LHD-Staging`
to override the production org; the key can be quoted across lines or use `\n` escapes.

`GITHUB_ORG`, `GITHUB_EXEC_TEAM` and `GITHUB_LEADS_TEAM` are set in `wrangler.jsonc`.
