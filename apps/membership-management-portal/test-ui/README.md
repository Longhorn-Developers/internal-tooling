# MMP test UI

A test frontend for the membership portal. Everyone who tests against staging shares one database
and one GitHub org (`lhd-staging`), so nobody's data drifts from anybody else's.

```text
local   (pnpm staging)
  browser ──> test-ui worker ──ctx.exports (real RPC)──> bundled portal ──┐ STAGING_DB_URL
                                                                           ▼
deployed (pnpm staging:deploy, one worker, no login)    /api/sql
  browser ──> test-ui worker ──ctx.exports (real RPC)──> bundled portal ──> staging D1
                 └─ /api/sql: raw SQL on the staging D1 for local runs (bearer token)
                 └─ /github:  the staging GitHub webhook
```

The test UI wraps `MembershipService` (`test-ui/src/worker.ts`): where `STAGING_DB_URL` is set it swaps
`env.membership_db` for a shim that sends the SQL to the deployed worker. The portal's own code
knows nothing about it.

It follows the portal's rules: it never writes D1 or calls GitHub itself, it only calls the portal's
actions, syncs and `autoFix`. Syncs are explicit and read-only. After a fix it re-runs the last
sync instead of trusting its own state. Removals are never preselected and always ask for
confirmation. `failedChanges`, `rejected` and deferred changes are shown separately.

## Running it locally

1. Download two files from Notion (the link is printed if either is missing):
   `.dev.vars` in `apps/membership-management-portal` (the staging GitHub App credentials) and
   `test-ui/.dev.vars` (`STAGING_DB_URL` and `STAGING_DB_TOKEN`). They're separate so the shared
   database settings stay out of the portal's generated types.
2. `pnpm staging`.

`pnpm staging` runs `wrangler dev --local -e staging` on the test UI's worker, under the portal's own
`wrangler.jsonc` with `--assets` for the UI and both env files passed with `--env-file`. The empty
`env.staging` there has no D1 binding, so no local database is created, and `--local` means no
Cloudflare login is needed. It runs your working-tree portal code against the shared staging
database through the deployed worker's `/api/sql`, and GitHub writes are real (`lhd-staging`).
The terminal summary says what is local and what is remote.

Each query is one HTTPS round trip, so big syncs are slower than a real binding.

## How the pieces tell where they are running

Nothing detects "local" or "production". Each piece turns on only where its configuration exists:

| Piece | Active when |
| --- | --- |
| Shared-database shim (in `MembershipService`'s wrapper) | there is no `membership_db` binding: the local `staging` env |
| `/api/sql` | there is a `membership_db` binding (the deployed worker) and `STAGING_DB_TOKEN` is set; otherwise 404 |

The production `membership-worker` has none of this code, so none of it runs there.

## Deploying the staging worker

The deployed worker is `mmp-test-ui-staging` (`test-ui/wrangler.jsonc`). It's the only
deployed piece: the portal is bundled into it. In the dashboard, set its variables and secrets to
the **staging** org's values (`GITHUB_*`, `STAGING_DB_TOKEN`) and attach a custom domain. The UI has
no login, so anyone with the URL can use it; the only things it can reach are the staging database
and the `lhd-staging` org. `/api/sql` needs its token and `/github` a valid GitHub signature.
Then `pnpm staging:deploy`, and point the staging GitHub webhook at `/github`.

`STAGING_DB_URL` is `https://<that domain>/api/sql`, and `STAGING_DB_TOKEN` is the same secret on both sides.
The token grants raw read and write on the staging database, so share it only through the Notion
`test-ui/.dev.vars` download.

## What the adapter allows

Only these RPCs, with validated arguments: `onboardUser`, `updateUser`, `addUserToTeam`,
`removeUserFromTeam`, `deactivateUser`, `makeExec`, `removeExec`, `createTeam`, `deleteTeam`,
`syncTeam`, `syncUser`, `syncService`, `syncAll`, `autoFix`. `getState` is the only read.

## Development

`pnpm typecheck:test-ui`. The frontend is plain ES modules in `public/`, so there is nothing to
build.
