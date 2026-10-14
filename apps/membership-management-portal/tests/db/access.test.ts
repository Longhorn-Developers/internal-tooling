import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';
import { afterEach, before, beforeEach, test } from 'node:test';
import {
  generateSQLiteDrizzleJson,
  generateSQLiteMigration,
} from 'drizzle-kit/api';
import {
  assignPosition,
  createUser,
  getTeamMembers,
  getUserById,
  removePosition,
} from '../../src/db/access';
import type { NewUser } from '../../src/db/access';
import * as schema from '../../src/db/schema';

let statements: string[];
let sqlite: DatabaseSync;
let database: D1Database;

before(async () => {
  const empty = await generateSQLiteDrizzleJson({});
  const current = await generateSQLiteDrizzleJson(schema);
  statements = await generateSQLiteMigration(empty, current);
});

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  for (const statement of statements) sqlite.exec(statement);
  sqlite.exec(`
    INSERT INTO statuses (id, name)
      VALUES ('applicant', 'Applicant'), ('active', 'Active');
    INSERT INTO teams (id, name)
      VALUES ('team-a', 'Team A'), ('team-b', 'Team B');
  `);

  // These helpers use D1's prepare/bind/raw API. Execute its queries in real
  // SQLite so joins, defaults, RETURNING, and constraints are exercised.
  database = {
    prepare(query: string) {
      return {
        bind(...values: SQLInputValue[]) {
          return {
            async raw() {
              const statement = sqlite.prepare(query);
              statement.setReturnArrays(true);
              return statement.all(...values);
            },
          };
        },
      };
    },
  } as unknown as D1Database;
});

afterEach(() => {
  sqlite.close();
});

function userData(id = 'user-a', overrides: Partial<NewUser> = {}): NewUser {
  return {
    id,
    name: id,
    email: `${id}@example.com`,
    githubId: `github-${id}`,
    discordId: `discord-${id}`,
    teamId: 'team-a',
    ...overrides,
  };
}

function hasConstraintError(pattern: RegExp) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof Error);
    assert.ok(error.cause instanceof Error);
    assert.match(error.cause.message, pattern);
    return true;
  };
}

test('creates and retrieves a user with schema defaults', async () => {
  const data = userData();
  const user = await createUser(database, data);
  assert.deepEqual(user, { ...data, statusId: 'applicant', role: 'member' });
  assert.deepEqual(await getUserById(database, user.id), user);
});

test('preserves an explicitly supplied user status and role', async () => {
  const data = userData('user-a', { statusId: 'active', role: 'admin' });
  assert.deepEqual(await createUser(database, data), data);
});

test('returns null for a missing user', async () => {
  assert.equal(await getUserById(database, 'missing'), null);
});

test('rejects duplicate users without overwriting their data', async () => {
  const original = await createUser(database, userData());
  await assert.rejects(
    createUser(database, userData('user-a', { name: 'Replacement' })),
    hasConstraintError(/UNIQUE constraint failed/),
  );
  assert.deepEqual(await getUserById(database, original.id), original);
});

test('rejects user creation with missing team or status references', async () => {
  for (const overrides of [{ teamId: 'missing' }, { statusId: 'missing' }]) {
    await assert.rejects(
      createUser(database, userData('user-a', overrides)),
      hasConstraintError(/FOREIGN KEY constraint failed/),
    );
  }
  assert.equal(await getUserById(database, 'user-a'), null);
});

test('assigns all six positions and makes repeated assignment a no-op', async () => {
  await createUser(database, userData());
  for (const position of schema.positions) {
    assert.equal(await assignPosition(database, 'user-a', 'team-a', position), true);
    assert.equal(await assignPosition(database, 'user-a', 'team-a', position), false);
  }
  const members = await getTeamMembers(database, 'team-a');
  assert.equal(members.length, 1);
  assert.deepEqual(members[0].positions, [...schema.positions].sort());
});

test('groups members by user ID, orders them, and filters by team', async () => {
  const zed = await createUser(database, userData('user-z', { name: 'Zed' }));
  const alexB = await createUser(database, userData('user-b', { name: 'Alex' }));
  const alexA = await createUser(database, userData('user-a', { name: 'Alex' }));
  await assignPosition(database, zed.id, 'team-a', 'design lead');
  await assignPosition(database, alexB.id, 'team-a', 'product lead');
  await assignPosition(database, alexA.id, 'team-a', 'developer lead');
  await assignPosition(database, alexA.id, 'team-a', 'design fellow');
  await assignPosition(database, alexA.id, 'team-b', 'product fellow');

  assert.deepEqual(await getTeamMembers(database, 'team-a'), [
    { user: alexA, positions: ['design fellow', 'developer lead'] },
    { user: alexB, positions: ['product lead'] },
    { user: zed, positions: ['design lead'] },
  ]);
  assert.deepEqual(await getTeamMembers(database, 'team-b'), [
    { user: alexA, positions: ['product fellow'] },
  ]);
});

test('returns an empty list for missing teams or users without assignments', async () => {
  await createUser(database, userData());
  assert.deepEqual(await getTeamMembers(database, 'team-a'), []);
  assert.deepEqual(await getTeamMembers(database, 'missing'), []);
});

test('rejects assignments with missing user or team references', async () => {
  await createUser(database, userData());
  for (const [userId, teamId] of [
    ['missing', 'team-a'],
    ['user-a', 'missing'],
  ]) {
    await assert.rejects(
      assignPosition(database, userId, teamId, 'developer fellow'),
      hasConstraintError(/FOREIGN KEY constraint failed/),
    );
  }
  assert.deepEqual(await getTeamMembers(database, 'team-a'), []);
});

test('rejects unsupported positions at runtime as well as in TypeScript', async () => {
  await createUser(database, userData());
  await assert.rejects(
    // @ts-expect-error Positions outside the supported set are not accepted.
    assignPosition(database, 'user-a', 'team-a', 'unsupported'),
    hasConstraintError(/CHECK constraint failed/),
  );
  assert.deepEqual(await getTeamMembers(database, 'team-a'), []);
});

test('removes only the requested user/team/position assignment', async () => {
  const userA = await createUser(database, userData());
  const userB = await createUser(database, userData('user-b'));
  await assignPosition(database, userA.id, 'team-a', 'developer fellow');
  await assignPosition(database, userA.id, 'team-a', 'product fellow');
  await assignPosition(database, userA.id, 'team-b', 'developer fellow');
  await assignPosition(database, userB.id, 'team-a', 'developer fellow');

  assert.equal(await removePosition(database, userA.id, 'team-a', 'developer fellow'), true);
  assert.equal(await removePosition(database, userA.id, 'team-a', 'developer fellow'), false);
  assert.deepEqual(await getTeamMembers(database, 'team-a'), [
    { user: userA, positions: ['product fellow'] },
    { user: userB, positions: ['developer fellow'] },
  ]);
  assert.deepEqual(await getTeamMembers(database, 'team-b'), [
    { user: userA, positions: ['developer fellow'] },
  ]);
  assert.deepEqual(await getUserById(database, userA.id), userA);
});

test('returns false when removing an assignment that does not exist', async () => {
  assert.equal(await removePosition(database, 'missing', 'missing', 'design lead'), false);
});

test('propagates database failures to the caller', async () => {
  const failingDatabase = {
    prepare() {
      throw new Error('D1 unavailable');
    },
  } as unknown as D1Database;
  await assert.rejects(getUserById(failingDatabase, 'user-a'), /D1 unavailable/);
});
