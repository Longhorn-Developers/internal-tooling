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
