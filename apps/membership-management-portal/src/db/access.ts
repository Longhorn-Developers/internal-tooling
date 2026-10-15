import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { teamUsers, users, verticalNames, verticals } from './schema';
import type { Vertical } from './schema';

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type TeamUser = typeof teamUsers.$inferSelect;
export type VerticalRecord = typeof verticals.$inferSelect;

export type TeamMember = {
  user: User;
  verticals: Vertical[];
};

/** Returns null when the user does not exist. */
export async function getUserById(
  database: D1Database,
  userId: string,
): Promise<User | null> {
  const user = await drizzle(database)
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .get();

  return user ?? null;
}

/** Creates a user; duplicate IDs and invalid references reject the promise. */
export async function createUser(
  database: D1Database,
  data: NewUser,
): Promise<User> {
  const user = await drizzle(database)
    .insert(users)
    .values(data)
    .returning()
    .get();

  if (!user) {
    throw new Error(`User ${data.id} was not created`);
  }

  return user;
}

/**
 * Lists users with explicit vertical assignments, grouping each user's verticals.
 * Returns [] for a team with no assignments or a team that does not exist.
 */
export async function getTeamMembers(
  database: D1Database,
  teamId: string,
): Promise<TeamMember[]> {
  const assignments = await drizzle(database)
    .select({ user: users, vertical: verticals.name })
    .from(teamUsers)
    .innerJoin(users, eq(teamUsers.userId, users.id))
    .innerJoin(verticals, eq(teamUsers.verticalId, verticals.id))
    .where(eq(teamUsers.teamId, teamId))
    .orderBy(users.name, users.id, verticals.name)
    .all();

  const members = new Map<string, TeamMember>();
  for (const { user, vertical } of assignments) {
    const member = members.get(user.id);
    if (member) {
      member.verticals.push(vertical);
    } else {
      members.set(user.id, { user, verticals: [vertical] });
    }
  }

  return [...members.values()];
}

/**
 * Returns true for a new assignment, or false if it already exists.
 * Missing users/teams and invalid verticals reject the promise.
 */
export async function assignVertical(
  database: D1Database,
  userId: string,
  teamId: string,
  vertical: Vertical,
): Promise<boolean> {
  const db = drizzle(database);
  const record = await findVertical(database, vertical);
  if (!record) {
    throw new Error(`Vertical "${vertical}" is not initialized; run npm run db:migrate first`);
  }

  const assignment = await db
    .insert(teamUsers)
    .values({ userId, teamId, verticalId: record.id })
    .onConflictDoNothing({
      target: [
        teamUsers.teamId,
        teamUsers.userId,
        teamUsers.verticalId,
      ],
    })
    .returning({ userId: teamUsers.userId })
    .get();

  return assignment !== undefined;
}

/** Returns true if the assignment was removed, or false if it did not exist. */
export async function removeVertical(
  database: D1Database,
  userId: string,
  teamId: string,
  vertical: Vertical,
): Promise<boolean> {
  const record = await findVertical(database, vertical);
  if (!record) return false;

  const assignment = await drizzle(database)
    .delete(teamUsers)
    .where(and(
      eq(teamUsers.userId, userId),
      eq(teamUsers.teamId, teamId),
      eq(teamUsers.verticalId, record.id),
    ))
    .returning({ userId: teamUsers.userId })
    .get();

  return assignment !== undefined;
}

async function findVertical(
  database: D1Database,
  vertical: Vertical,
): Promise<VerticalRecord | undefined> {
  if (!verticalNames.includes(vertical)) {
    throw new Error(`Unsupported vertical: ${vertical}`);
  }

  return drizzle(database)
    .select()
    .from(verticals)
    .where(eq(verticals.name, vertical))
    .get();
}
