# MMP test UI

A local-only test frontend for the membership portal. It is never deployed and has no auth: it
only listens on your machine. Run everything from `apps/membership-management-portal`.

```text
browser ──> test-ui (local) ──service binding──> membership-worker (local portal code)
              │  /api/state: getState (users, teams, assignments)
              │  /api/rpc:   allowlisted RPC calls, arguments validated
              └─ public/:    the UI (no build step)

The UI has no database access: everything goes through the service binding, including
`getState`, the portal's read of all users, teams and assignments.
```

It follows the portal's rules: it never writes D1 or calls GitHub itself, it only calls the portal's
actions, syncs and `autoFix`. Syncs are explicit and read-only. After a fix it re-runs the last
sync instead of trusting its own state. Removals are never preselected and always ask for
confirmation. `failedChanges`, `rejected` and deferred changes are shown separately.

Both modes need `.dev.vars` in the portal folder (git-ignored; it is also what `cf-typegen` reads): the **staging** org's GitHub App credentials and
settings (`GITHUB_ORG`, `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, `GITHUB_APP_PRIVATE_KEY`,
`GITHUB_EXEC_TEAM`, `GITHUB_LEADS_TEAM`, `GITHUB_WEBHOOK_SECRET`). `start.sh` stops and prints
where to download it (Notion) if the file is missing.
GitHub writes are real (the `lhd-staging` org).

Both start through `test-ui/start.sh`, which prints what is local and what is remote.

## `pnpm staging`: shared staging database (needs Cloudflare access)

Runs `wrangler dev` with the portal's own `wrangler.jsonc`, whose D1 binding has `remote: true`;
dev resolves it to the staging database through `preview_database_id`. You must be logged in to Cloudflare
(`wrangler login`) with access to the account. Everything runs from your working tree except the
GitHub webhook, which runs on the deployed Cloudflare staging preview. It uses the same staging
D1, so webhook effects show up here after a reload or sync.

## `pnpm staging:local`: local database (no Cloudflare access)

Runs `wrangler dev --local`, which disables the remote binding. Applies migrations to a local D1 on
every start (safe to repeat; the first run asks you to confirm), then starts everything. The local
database starts empty: use **Create all LHD teams** in the Teams panel. It creates every LHD team
that doesn't exist yet through `createTeam`, so it also creates the GitHub teams in `lhd-staging`.

`pnpm staging:local:reset` deletes `.wrangler/state` (the local database and any other local dev
state, including `pnpm dev`'s); the next `pnpm staging:local` recreates it empty.

**The GitHub webhook does not work in this mode.** It only runs on the deployed staging worker,
which uses the shared staging D1, not your local copy. Webhook-driven changes never reach your
database, and your local data is not visible to anyone else. State lives in `.wrangler/state`.

In both modes the UI's service binding resolves to the portal running beside it in the same dev
session. Check the database ID Wrangler prints at startup on the first `pnpm staging` run. The
page header shows which mode you are in.

## What the adapter allows

Only these RPCs, with validated arguments: `onboardUser`, `updateUser`, `addUserToTeam`,
`removeUserFromTeam`, `deactivateUser`, `makeExec`, `removeExec`, `createTeam`, `deleteTeam`,
`syncTeam`, `syncUser`, `syncService`, `syncAll`, `autoFix`. `getState` is the only read.

## Development

`pnpm typecheck:test-ui`. The frontend is plain ES modules in `public/`, so there is nothing to
build.
