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
`applicant`), an `isExec` flag, and optional `dateJoined` / `dateLeft` fields
(`YYYY-MM-DD`). Status and vertical values are enforced with CHECK constraints.

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

Import from `src/db/access.ts` and pass the D1 binding first:

```ts
import { getUserById, assignVertical } from './db/access';

const user = await getUserById(this.env.membership_db, userId);
await assignVertical(this.env.membership_db, userId, teamId, 'tech', true); // as lead
```

Available helpers include `createUser`, `updateUser`, `getUserById`,
`getTeamMembers`, `assignVertical`, `removeVertical`, `createTeam`, and `deleteTeam`. Create users and teams before assigning
verticals. `getTeamMembers` returns `{ user, verticals: { vertical, isLead }[] }[]`.
`assignVertical` inserts the assignment or updates `isLead` on an existing one;
assignment/removal helpers return whether a row changed. Database errors reject
the promise.

## Services

Each external service is a subclass of `Service` (`src/services/service.ts`), which declares
the same actions for every service. `src/services/all-services.ts` runs each action on every
service in `allServices` and writes D1, which is the source of truth. The Worker
(`src/index.ts`) exposes them through the `MembershipService` RPC binding:

| Method | Does |
| --- | --- |
| `onboardUser(name, email, github, discord)` | creates an active user; returns `{ userId, neededChanges }` |
| `addUserToTeam(userId, teamId, vertical, isLead)` | assigns the vertical, then sets up access |
| `removeUserFromTeam(userId, teamId)` | removes every vertical on the team and its access |
| `deactivateUser(userId)` | marks the user inactive and removes their access |
| `makeExec(userId, execRole)` / `removeExec(userId, execRole)` | sets `is_exec` and exec access |
| `createTeam(teamId, name)` / `deleteTeam(teamId)` | creates or deletes the team everywhere |
| `syncTeam(teamId)` | checks the team in every service; changes nothing |
| `syncUsers(teamId)` | sets up every user D1 assigns to the team |
| `fixTeam(changes)` | makes the fixable needed changes |

Adds and syncs return `NeededChange[]`. Before changing anything, each service checks that what
it needs exists (e.g. the GitHub team). If not, that service changes nothing and returns what is
missing: `{ service, kind, teamId?, userId?, target, reason, fixable }`. Pass the list to `fixTeam`,
which makes the `fixable` ones; the others need a person (e.g. a wrong `github_id`). Then run the
action, or `syncUsers`, again. Removals never fail over something already missing.

Failed API calls throw a `ServiceError` whose message starts with its code. Actions are
idempotent, so retrying one is safe.

## GitHub

`GitHubService` (`src/github/github-service.ts`) uses the REST client in `src/github/github-api.ts`.

- Every team has a GitHub team, found by the slug of the team's name (e.g. `UT Dining` →
  `ut-dining`). Renaming a team in D1 needs its GitHub team renamed to match.
- GitHub is the source of truth for repositories: a team's repositories are the ones its GitHub
  team has access to. Add or remove them in the GitHub team's settings.
- Active `tech` members are on it: dev leads as maintainers with direct Admin on the team's
  repositories, dev fellows as members. Other verticals get no GitHub access.
- Active execs are on the exec team (`GITHUB_EXEC_TEAM`), which has Admin on every non-archived
  repository. Every exec role gets the same access.
- `onboardUser` invites to the org; `deactivateUser` removes from the org (org owners are only
  taken off LHD's teams).
- Accounts not in D1 are reported, never removed. Org owners never lose access. GitHub teams are
  only deleted by `deleteTeam`.

GitHub-only RPC methods: `auditGithubRepos()` (repositories no team's GitHub team has access to)
and `syncGithubExecTeam()` (checks the exec team).

`syncTeam` reports access D1 doesn't account for: `remove_team_member` (LHD member no longer on
the team) and `remove_repo_admin` (non-lead with direct Admin on one of its repositories) are
fixable; `unknown_account` and `github_user_not_found` need a person.

| Error code | Usually means | Resolve |
| --- | --- | --- |
| `GITHUB_BAD_CREDENTIALS` | wrong or revoked app secrets | fix the secrets |
| `GITHUB_NOT_FOUND` | something was deleted since the check | run `syncTeam`, then `fixTeam` |
| `GITHUB_FORBIDDEN` | the GitHub App lacks a permission | fix the app, then retry |
| `GITHUB_RATE_LIMITED` | too many requests | retry after a few minutes |
| `GITHUB_VALIDATION_FAILED` | GitHub rejected it (e.g. no free seats) | fix in GitHub by hand |
| `GITHUB_UNAVAILABLE` | GitHub outage | retry |
| `GITHUB_ERROR` | anything else | see the message |

Setup: an org owner creates a GitHub App owned by the org (org Settings → Developer settings →
GitHub Apps) with **Organization → Members** and **Repository → Administration** set to read and
write, webhooks off, then installs it on the org with access to all repositories. Each org needs
its own app (e.g. LHD-Staging for testing, Longhorn-Developers for production).

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
```

For local testing, put the same values in `.dev.vars` (gitignored) with `GITHUB_ORG=LHD-Staging`
to override the production org; the key can be quoted across lines or use `\n` escapes.

`GITHUB_ORG` and `GITHUB_EXEC_TEAM` are set in `wrangler.jsonc`.
