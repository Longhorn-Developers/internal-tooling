import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { teamMemberships, users } from './schema';
import type { Position } from './schema';

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type TeamMembership = typeof teamMemberships.$inferSelect;

export type TeamMember = {
  user: User;
  positions: Position[];
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
 * Lists users with explicit position assignments, grouping each user's positions.
 * Returns [] for a team with no assignments or a team that does not exist.
 * The legacy users.teamId field does not create a position assignment.
 */
export async function getTeamMembers(
  database: D1Database,
  teamId: string,
): Promise<TeamMember[]> {
  const assignments = await drizzle(database)
    .select({ user: users, position: teamMemberships.position })
    .from(teamMemberships)
    .innerJoin(users, eq(teamMemberships.userId, users.id))
    .where(eq(teamMemberships.teamId, teamId))
    .orderBy(users.name, users.id, teamMemberships.position)
    .all();

  const members = new Map<string, TeamMember>();
  for (const { user, position } of assignments) {
    const member = members.get(user.id);
    if (member) {
      member.positions.push(position);
    } else {
      members.set(user.id, { user, positions: [position] });
    }
  }

  return [...members.values()];
}

/**
 * Returns true for a new assignment, or false if it already exists.
 * Missing users/teams and invalid positions reject the promise.
 */
export async function assignPosition(
  database: D1Database,
  userId: string,
  teamId: string,
  position: Position,
): Promise<boolean> {
  const assignment = await drizzle(database)
    .insert(teamMemberships)
    .values({ userId, teamId, position })
    .onConflictDoNothing({
      target: [
        teamMemberships.userId,
        teamMemberships.teamId,
        teamMemberships.position,
      ],
    })
    .returning({ userId: teamMemberships.userId })
    .get();

  return assignment !== undefined;
}

/** Returns true if the assignment was removed, or false if it did not exist. */
export async function removePosition(
  database: D1Database,
  userId: string,
  teamId: string,
  position: Position,
): Promise<boolean> {
  const assignment = await drizzle(database)
    .delete(teamMemberships)
    .where(and(
      eq(teamMemberships.userId, userId),
      eq(teamMemberships.teamId, teamId),
      eq(teamMemberships.position, position),
    ))
    .returning({ userId: teamMemberships.userId })
    .get();

  return assignment !== undefined;
}
