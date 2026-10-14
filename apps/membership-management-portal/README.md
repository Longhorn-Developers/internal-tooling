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

## Database access helpers

Import the helpers from `src/db/access.ts` and pass the worker's D1 binding,
`this.env.membership_db`, as the first argument:

```ts
import { getUserById, assignPosition } from './db/access';

// Inside a MembershipService method:
const user = await getUserById(this.env.membership_db, userId);
if (!user) {
  throw new Error(`User ${userId} not found`);
}

const added = await assignPosition(
  this.env.membership_db,
  user.id,
  teamId,
  'developer fellow',
);
```

| Helper | Result |
| --- | --- |
| `getUserById(database, userId)` | A `User`, or `null` if missing. |
| `createUser(database, data)` | The created `User`, including schema defaults. Duplicate IDs or invalid references throw. |
| `getTeamMembers(database, teamId)` | `{ user, positions }[]`, with one entry per person, ordered by name and ID; positions are sorted alphabetically. Empty or missing teams return `[]`. |
| `assignPosition(database, userId, teamId, position)` | `true` when inserted, or `false` when already assigned. Invalid references or positions throw. |
| `removePosition(database, userId, teamId, position)` | `true` when removed, or `false` when the assignment was missing. |

`User`, `NewUser`, and `TeamMembership` types are derived from the schema.
The `Position` type restricts assignments to the six supported positions.
Database errors reject the helpers' promises so callers can handle failures.

Apply the schema migrations and seed referenced teams/statuses before using the
helpers. In particular, the default user status requires a status with ID
`applicant`. User creation still requires the legacy `teamId` field; it does not
create a position assignment. Call `assignPosition` separately to populate
`team_memberships`, which is the source for `getTeamMembers`.

Run the helper tests with Node.js 24 or newer:

```sh
npm test
```

The tests generate SQL from the schema and run the D1 Drizzle adapter against an
in-memory SQLite database; they do not access the deployed database.
