import type { Team, TeamUser, User } from '../db/access'
import { execRoles, verticalNames } from '../db/schema'
import type { ExecRole, Vertical } from '../db/schema'

export const MEMBER_ROLE = 'Members'
export const LEAD_ROLE = 'Leads'
export const FELLOW_ROLE = 'Fellows'
export const EXEC_BOARD_ROLE = 'Executive Board'
export const norm = (name: string) => name.trim().toLowerCase()
export type Wanted = Array<[name: string, shouldHave: boolean]>
export const verticalLabel = (vertical: Vertical) => vertical[0].toUpperCase() + vertical.slice(1)
export const execLeadVertical: Partial<Record<ExecRole, Vertical>> = {
    'Product Director': 'product',
    'SWE Director': 'technical',
    'UX Design Director': 'design',
}

export const roleNames = {
    verticalRank: (v: Vertical, lead: boolean) =>
        `${verticalLabel(v)} ${lead ? 'Leads' : 'Fellows'}`,
    teamVertical: (name: string, v: Vertical) => `${name} | ${verticalLabel(v)}`.slice(0, 100),
}
export const teamRoleNames = (team: Team) => [
    team.name,
    ...verticalNames.map((v) => roleNames.teamVertical(team.name, v)),
]
export const rankRoleNames = () => [
    LEAD_ROLE,
    FELLOW_ROLE,
    ...verticalNames.flatMap((v) => [
        roleNames.verticalRank(v, true),
        roleNames.verticalRank(v, false),
    ]),
]
export const managedNames = (teams: Team[]) =>
    new Set(
        [
            MEMBER_ROLE,
            EXEC_BOARD_ROLE,
            ...execRoles,
            ...rankRoleNames(),
            ...teams.flatMap(teamRoleNames),
        ].map(norm),
    )
export const hasEnded = (user: User) => user.status === 'inactive' || user.status === 'alum'
export const isLeadOf = (rows: TeamUser[], teamId: string) =>
    rows.some((r) => r.teamId === teamId && r.isLead)
export const wantedNames = (wanted: Wanted) => wanted.filter(([, yes]) => yes).map(([name]) => name)
export const withAssignment = (rows: TeamUser[], row: TeamUser) => [
    ...rows.filter((r) => r.teamId !== row.teamId || r.vertical !== row.vertical),
    row,
]

export function groupRows(assignments: TeamUser[]) {
    const grouped = new Map<string, TeamUser[]>()
    for (const row of assignments) {
        const rows = grouped.get(row.userId) ?? []
        rows.push(row)
        grouped.set(row.userId, rows)
    }
    return grouped
}

export function execWanted(role: ExecRole): Wanted {
    const vertical = execLeadVertical[role]
    return [
        [EXEC_BOARD_ROLE, true],
        [role, true],
        ...(vertical
            ? ([
                  [LEAD_ROLE, true],
                  [roleNames.verticalRank(vertical, true), true],
              ] as Wanted)
            : []),
    ]
}

export function execKeep(user: User) {
    const vertical = !hasEnded(user) && user.execRole ? execLeadVertical[user.execRole] : undefined
    return new Set(vertical ? [LEAD_ROLE, roleNames.verticalRank(vertical, true)].map(norm) : [])
}

function teamEntries(team: Team, rows: TeamUser[]): Wanted {
    const assignments = rows.filter((r) => r.teamId === team.id)
    return [
        [team.name, assignments.length > 0],
        ...verticalNames.map((v): [string, boolean] => [
            roleNames.teamVertical(team.name, v),
            assignments.some((r) => r.vertical === v),
        ]),
    ]
}

/** Shared ranks follow ALL assignments, not just the team being changed. */
function rankEntries(rows: TeamUser[], keep: Set<string>): Wanted {
    return [
        [LEAD_ROLE, rows.some((r) => r.isLead) || keep.has(norm(LEAD_ROLE))],
        [FELLOW_ROLE, rows.some((r) => !r.isLead)],
        ...verticalNames.flatMap((v): Wanted => [
            [
                roleNames.verticalRank(v, true),
                rows.some((r) => r.vertical === v && r.isLead) ||
                    keep.has(norm(roleNames.verticalRank(v, true))),
            ],
            [roleNames.verticalRank(v, false), rows.some((r) => r.vertical === v && !r.isLead)],
        ]),
    ]
}

export const teamScopeWanted = (team: Team, rows: TeamUser[], keep: Set<string>): Wanted => [
    ...teamEntries(team, rows),
    ...rankEntries(rows, keep),
]

export function fullWanted(user: User, rows: TeamUser[], teams: Team[]): Wanted {
    const ended = hasEnded(user)
    const live = ended ? [] : rows
    const exec = ended ? null : user.execRole
    return [
        ...(ended || user.status === 'active' ? ([[MEMBER_ROLE, !ended]] as Wanted) : []),
        ...teams.flatMap((team) => teamEntries(team, live)),
        ...rankEntries(live, execKeep(user)),
        [EXEC_BOARD_ROLE, !!exec],
        ...execRoles.map((role): [string, boolean] => [role, role === exec]),
    ]
}
