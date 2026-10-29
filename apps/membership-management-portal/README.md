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

Available helpers: `createUser`, `getUserById`, `getTeamMembers`,
`assignVertical`, and `removeVertical`. Create users and teams before assigning
verticals. `getTeamMembers` returns `{ user, verticals: { vertical, isLead }[] }[]`.
`assignVertical` inserts the assignment or updates `isLead` on an existing one;
assignment/removal helpers return whether a row changed. Database errors reject
the promise.

## GitHub sync

D1 is the source of truth; `src/github/sync.ts` makes the GitHub org match it.

- Every team gets a GitHub team (slug saved in `teams.github_team_slug`).
- Active `tech` members are added to it: dev leads as maintainers, dev fellows as members.
- `team_repos` assigns each org repository to one team. The team gets Write and the team's
  dev leads get Admin on its repositories; LHD members who aren't leads lose direct Admin.
- The exec team (`GITHUB_EXEC_TEAM` in `wrangler.jsonc`) has every active user with `is_exec`
  as a member and Admin on every non-archived repository, re-applied on each sync.
- Orphaned repositories (active, non-fork repos in no team) are flagged, not changed.
- Accounts not in D1 are flagged, never removed. Org owners are never stripped of access.

Other Workers call these through the `MembershipService` RPC binding: `assignRepoToTeam`,
`unassignRepo`, `syncGithubTeam`, `syncGithubExecTeam`, `auditGithubRepos`, and `syncGithub`. Each returns
`{ changes, flags }`.

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
