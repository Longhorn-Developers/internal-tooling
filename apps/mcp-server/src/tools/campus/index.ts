import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { austinNow } from "../dining/extract.ts";
import {
    ALL_BUILDINGS,
    buildingUrl,
    isNonPhysicalLocation,
    metresBetween,
    resolveBuilding,
    suggestBuildings,
    walkMinutes,
    type UtBuilding,
} from "./buildings.ts";
import { getDepartmentCalendars } from "./providers.ts";
import {
    AUDIENCES,
    austinInstant,
    byStart,
    EVENT_CATEGORIES,
    MAX_WINDOW_DAYS,
    VENUE_TYPES,
    collapseSeries,
    filterEvents,
    getCalendar,
    mentionsFreeFood,
    onCampus,
    type EventFilters,
} from "./extract.ts";

const textWith = <T>(body: string, structuredContent: T) => ({
    content: [{ type: "text" as const, text: body }],
    structuredContent,
});

/** Answer with a readable message instead of throwing at the client. */
const guard =
    <A>(
        run: (args: A) => Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }>,
    ) =>
    async (args: A) => {
        try {
            return await run(args);
        } catch (error) {
            return {
                content: [{ type: "text" as const, text: (error as Error).message }],
                isError: true,
            };
        }
    };

const MAX_ROWS = 40;
const DEFAULT_ROWS = 15;
const DEFAULT_NEAR_METRES = 400;

const LOCATION_OUTPUT = z.object({
    query: z.string(),
    resolved: z.boolean(),
    physical: z.boolean(),
    building: z
        .object({
            code: z.string(),
            name: z.string(),
            address: z.string(),
            latitude: z.number(),
            longitude: z.number(),
            precision: z.string(),
            officialUrl: z.string(),
        })
        .nullable(),
    matchedBy: z.string().nullable(),
    distance: z
        .object({
            from: z.string(),
            metres: z.number(),
            walkMinutes: z.number(),
            estimate: z.boolean(),
        })
        .nullable(),
    suggestions: z.array(z.object({ code: z.string(), name: z.string() })),
    notes: z.array(z.string()),
});

const EVENTS_OUTPUT = z.object({
    window: z.object({ from: z.string(), to: z.string(), timezone: z.string() }),
    matched: z.number(),
    shown: z.number(),
    coverage: z.object({
        feedCoordinates: z.number(),
        resolvedFromBuilding: z.number(),
        noCoordinates: z.number(),
    }),
    notes: z.array(z.string()),
    events: z.array(
        z.object({
            /** Pre-formatted in Austin time, so a client needn't redo the conversion. */
            when: z.string(),
            title: z.string(),
            start: z.string(),
            end: z.string().nullable(),
            allDay: z.boolean(),
            locationName: z.string().nullable(),
            room: z.string().nullable(),
            buildingCode: z.string().nullable(),
            latitude: z.number().nullable(),
            longitude: z.number().nullable(),
            coordinateSource: z.string().nullable(),
            walkMinutes: z.number().nullable(),
            venue: z.string(),
            categories: z.array(z.string()),
            audiences: z.array(z.string()),
            departments: z.array(z.string()),
            /** Which calendar this came from, since they cover different things. */
            source: z.string(),
            freeAdmission: z.boolean(),
            mentionsFreeFood: z.boolean(),
            /** null when there is no location to judge from. */
            onCampus: z.boolean().nullable(),
            /** Days in the window this runs on. >1 is an exhibition or a series. */
            occurrences: z.number(),
            /** Start of its last occurrence in the window, when it runs more than once. */
            lastStart: z.string().nullable(),
            /**
             * Every other start time in the window, when there are any.
             *
             * Same-day only at first, which hid the extra showings of a series
             * that also spans days. `lastStart` is a member of this too.
             *
             * A second showing used to be dropped: "Buena Vista Social Club"
             * plays Bass Concert Hall at 2pm and 8pm and only the matinee was
             * reported.
             */
            alsoAt: z.array(z.string()),
            description: z.string().nullable(),
            url: z.string(),
        }),
    ),
});

const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

export interface Window {
    from: Date;
    to: Date;
    label: string;
}

/** Turn a phrase into a window in Austin time. */
export function parseWindow(phrase: string | undefined, now = new Date()): Window | null {
    const today = austinNow(now);
    const dayStart = (offset: number) =>
        austinInstant(today.year, today.month, today.day + offset, 0);
    /**
     * A window of whole days.
     *
     * A span that starts TODAY opens at `now`, which is what "today" already
     * did: asked at 22:11 for "wednesday", the midnight start returned 56
     * events of which 31 had already finished, with nothing saying so.
     */
    const span = (fromOffset: number, toOffset: number, label: string): Window => ({
        from: fromOffset === 0 ? now : dayStart(fromOffset),
        to: dayStart(toOffset),
        label,
    });

    /** "Friday, Nov 20", so the answer names the day it chose. */
    const dated = (offset: number): string => {
        const at = dayStart(offset);
        return new Intl.DateTimeFormat("en-US", {
            timeZone: "America/Chicago",
            weekday: "long",
            month: "short",
            day: "numeric",
        }).format(at);
    };

    // Trailing punctuation is how a person types and how relayed text
    // arrives: "tonight?" and "Tonight!" were rejected outright.
    const value = (phrase ?? "today")
        .trim()
        .toLowerCase()
        .replace(/[?!.,;:]+$/, "")
        .trim();
    if (!value || value === "today") {
        // From now, not midnight: this morning's lecture is over.
        return { from: now, to: dayStart(1), label: "today" };
    }
    if (value === "tonight" || value === "this evening") {
        const evening = austinInstant(today.year, today.month, today.day, 17);
        return { from: now > evening ? now : evening, to: dayStart(1), label: "tonight" };
    }
    if (value === "tomorrow") return span(1, 2, "tomorrow");
    if (value === "this week") return { from: now, to: dayStart(7), label: "the next 7 days" };
    if (value === "next week") return span(7, 14, "next week");
    if (value === "weekend" || value === "this weekend") {
        // dayIndex is 0 = Monday, so Saturday is 5 and Sunday is 6.
        if (today.dayIndex === 6) return { from: now, to: dayStart(1), label: "this weekend" };
        if (today.dayIndex === 5) {
            // Saturday: from now, consistent with "today".
            return { from: now, to: dayStart(2), label: "this weekend" };
        }
        return span(5 - today.dayIndex, 7 - today.dayIndex, "this weekend");
    }

    const weekday = WEEKDAYS.indexOf(value.replace(/^(next|this|coming)\s+/, ""));
    if (weekday >= 0) {
        const ahead = (weekday - today.dayIndex + 7) % 7;
        // "next friday" means the one after this coming Friday. A flat +7
        // overshot whenever the named day is EARLIER in the week than today:
        // `ahead` has already crossed into next week, so asked on a Thursday
        // "next monday" landed on the 30th instead of the 23rd. Only add a
        // week when the target is still inside this Monday-to-Sunday week.
        const sameWeek = today.dayIndex + ahead <= 6;
        const offset = /^next\s/.test(value) && sameWeek ? ahead + 7 : ahead;
        return span(offset, offset + 1, dated(offset));
    }

    const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (iso) {
        const [year, month, day] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
        const midnight = austinInstant(year, month, day, 0);
        // Reject a date that rolled: "2026-02-30" would otherwise answer about 2 March without saying so.
        const check = austinNow(midnight);
        if (check.year !== year || check.month !== month || check.day !== day) return null;
        const to = austinInstant(year, month, day + 1, 0);
        // Today by its date is still today: open at `now` rather than replaying
        // the morning.
        const from = midnight < now && now < to ? now : midnight;
        return { from, to, label: value };
    }
    return null;
}

/** Days of calendar to request, from how far the window reaches. */
function daysNeeded(window: Window, now: Date): number {
    const ms = window.to.getTime() - now.getTime();
    return Math.min(MAX_WINDOW_DAYS + 1, Math.max(1, Math.ceil(ms / 86_400_000) + 1));
}

/** Is the window something one call can actually answer for?. */
function outOfRange(window: Window, now: Date): string | null {
    const dayMs = 86_400_000;
    // `<= now`, not `<= now - dayMs`.
    if (window.to.getTime() <= now.getTime()) {
        return (
            "that is in the past. UT's calendar feed only serves upcoming events, so this " +
            "tool cannot answer for a date that has gone."
        );
    }
    const ahead = Math.ceil((window.from.getTime() - now.getTime()) / dayMs);
    // The fetch covers MAX_WINDOW_DAYS + 1 days, so what this refuses is unread.
    if (ahead > MAX_WINDOW_DAYS) {
        return (
            `that is ${ahead} days out and this tool reads the next ${MAX_WINDOW_DAYS} days, ` +
            "so it has not looked that far. Ask again nearer the date."
        );
    }
    return null;
}

function describeBuilding(building: UtBuilding) {
    return {
        code: building.code,
        name: building.name,
        address: building.address,
        latitude: building.latitude,
        longitude: building.longitude,
        precision: building.precision,
        officialUrl: buildingUrl(building.code),
    };
}

/** "Fri, Nov 7, 7:30 PM" in Austin time, which is the only time zone anyone means. */
function when(startIso: string, allDay: boolean): string {
    const start = new Date(startIso);
    if (!Number.isFinite(start.getTime())) return startIso;
    const date = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Chicago",
        weekday: "short",
        month: "short",
        day: "numeric",
    }).format(start);
    if (allDay) return `${date}, all day`;
    const time = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Chicago",
        hour: "numeric",
        minute: "2-digit",
    }).format(start);
    return `${date}, ${time}`;
}

export function registerCampusTools(server: McpServer) {
    server.registerTool(
        "resolve_ut_location",
        {
            title: "Resolve a UT campus location",
            description:
                "Turn a UT building code, room reference or nickname into a name, address and " +
                'coordinates. Handles what students actually write: "GSB 2.126", "WEL 2.224", ' +
                '"the SAC", "Welch Hall", "Gearing 114", and the dining names J2, JCL and Kins. ' +
                "Pass relativeTo for the distance and a walking-time estimate between two places. " +
                "Online, Zoom and TBA are reported as having no physical location rather than as " +
                "a failure. Use this whenever an answer needs to say where something is.",
            outputSchema: LOCATION_OUTPUT,
            inputSchema: z
                .object({
                    location: z
                        .string()
                        .describe('Building code, room reference or name, e.g. "GDC 2.216"'),
                    relativeTo: z
                        .string()
                        .optional()
                        .describe('Second location, for distance and walk time, e.g. "PCL"'),
                })
                .strict(),
        },
        guard(async ({ location, relativeTo }: { location: string; relativeTo?: string }) => {
            const query = location.trim();
            if (!query) {
                return textWith("Give a building code, room reference or name.", {
                    query: location,
                    resolved: false,
                    physical: false,
                    building: null,
                    matchedBy: null,
                    distance: null,
                    suggestions: [],
                    notes: ["Empty location."],
                });
            }

            const hit = resolveBuilding(query);
            const physical = !isNonPhysicalLocation(query);
            const notes: string[] = [];

            if (!hit) {
                const suggestions = physical ? suggestBuildings(query) : [];
                const body = !physical
                    ? `"${query}" is not a physical place, so it has no coordinates. ` +
                      "That is the correct answer for an online or unscheduled event."
                    : suggestions.length
                      ? `No UT building matched "${query}". Closest by code or name: ` +
                        `${suggestions.map((b) => `${b.code} (${b.name})`).join(", ")}.`
                      : `No UT building matched "${query}". There are ${ALL_BUILDINGS.length} ` +
                        "buildings on main campus; this may be off campus or a nickname that is " +
                        "not in the alias table.";
                return textWith(body, {
                    query,
                    resolved: false,
                    physical,
                    building: null,
                    matchedBy: null,
                    distance: null,
                    suggestions: suggestions.map((b) => ({ code: b.code, name: b.name })),
                    notes: physical ? [] : ["Not a physical location."],
                });
            }

            const { building, matchedBy } = hit;
            if (building.precision !== "marker") {
                notes.push(
                    building.precision === "geocoded"
                        ? "Coordinate is geocoded from the street address, so it is approximate."
                        : "Coordinate is the building footprint centre, not an entrance.",
                );
            }
            if (matchedBy === "room-reference" || matchedBy === "short-name") {
                notes.push(
                    `Matched on ${matchedBy === "short-name" ? "a shortened name" : "a room reference"}, ` +
                        "so this is the building, not the room.",
                );
            }

            let distance: {
                from: string;
                metres: number;
                walkMinutes: number;
                estimate: boolean;
            } | null = null;
            if (relativeTo?.trim()) {
                const other = resolveBuilding(relativeTo);
                if (!other) {
                    notes.push(`Could not resolve relativeTo "${relativeTo}", so no distance.`);
                } else {
                    const metres = Math.round(metresBetween(other.building, building));
                    distance = {
                        from: other.building.code,
                        metres,
                        walkMinutes: walkMinutes(metres),
                        estimate: true,
                    };
                    notes.push(
                        "Walking time is a straight-line estimate with a detour allowance, not " +
                            "a routed path.",
                    );
                }
            }

            const lines = [
                `${building.code} — ${building.name}`,
                building.address,
                `${building.latitude}, ${building.longitude} (${building.precision})`,
                distance
                    ? `${distance.metres} m from ${distance.from}, about a ${distance.walkMinutes} minute walk`
                    : "",
                buildingUrl(building.code),
                ...notes.map((note) => `NOTE: ${note}`),
            ].filter(Boolean);

            return textWith(lines.join("\n"), {
                query,
                resolved: true,
                physical: true,
                building: describeBuilding(building),
                matchedBy,
                distance,
                suggestions: [],
                notes,
            });
        }),
    );

    server.registerTool(
        "find_events",
        {
            title: "Find UT campus events",
            description:
                "Find events happening at UT Austin from the university's central calendar. " +
                "Filter by when, by interest category, by who it is for, by department, by " +
                "whether it is in person, and by how close it is to a building. Every event " +
                "comes back with a link, and with coordinates where they can be worked out. " +
                "COVERAGE: UT's central calendar, which skews to arts, student affairs and " +
                "HR, plus four departmental ones that publish nothing to it -- Computer " +
                "Science, the School of Law, McCombs and Cockrell engineering. Each event " +
                "says which `source` it came from, and `department` is set for the " +
                "departmental ones. Moody, Nursing, Fine Arts, Liberal Arts, Texas Global " +
                "and the iSchool are not read, and student club events are mostly on social " +
                "media or HornsLink. An empty answer means nothing matched these calendars, " +
                "not that nothing is happening.",
            outputSchema: EVENTS_OUTPUT,
            inputSchema: z
                .object({
                    when: z
                        .string()
                        .optional()
                        .describe(
                            '"today" (default), "tonight", "tomorrow", "this week", ' +
                                '"weekend", a weekday, or "2026-11-12"',
                        ),
                    query: z
                        .string()
                        .optional()
                        .describe(
                            "Match the title, the full description, tags, department or location. " +
                                "A word of three letters or fewer has to match as a whole word.",
                        ),
                    categories: z
                        .array(z.string())
                        .optional()
                        .describe(`Any of: ${EVENT_CATEGORIES.join(", ")}`),
                    audiences: z
                        .array(z.string())
                        .optional()
                        .describe(`Who it is for. Any of: ${AUDIENCES.join(", ")}`),
                    venue: z
                        .enum(VENUE_TYPES)
                        .optional()
                        .describe(
                            "Restrict to in-person, virtual, hybrid, or unknown. Some " +
                                "departmental calendars publish no venue, and those are " +
                                '"unknown" rather than assumed in person.',
                        ),
                    department: z
                        .string()
                        .optional()
                        .describe(
                            'e.g. "Computer Science", "School of Law", "McCombs", ' +
                                '"Cockrell", "Fine Arts". The first four read that ' +
                                "department's own calendar; the rest come from the central " +
                                "one, where " +
                                "about half the events carry no department at all. Prefer " +
                                "query for a subject.",
                        ),
                    near: z
                        .string()
                        .optional()
                        .describe('Only events near this building, e.g. "GDC" or "the SAC"'),
                    withinMetres: z
                        .number()
                        .int()
                        .positive()
                        .optional()
                        .describe(`Radius for near. Default ${DEFAULT_NEAR_METRES}.`),
                    freeFood: z
                        .boolean()
                        .optional()
                        .describe(
                            "Only events whose text says food is provided. A text heuristic, " +
                                "not a field the calendar publishes.",
                        ),
                    freeAdmission: z
                        .boolean()
                        .optional()
                        .describe("Only events the calendar marks as free to attend"),
                    onCampusOnly: z
                        .boolean()
                        .optional()
                        .describe(
                            "Drop events known to be away from Austin, such as road games. " +
                                "Events with no location are kept, since they are unknown " +
                                "rather than away.",
                        ),
                    limit: z
                        .number()
                        .int()
                        .positive()
                        .max(MAX_ROWS)
                        .optional()
                        .describe(`Rows to return. Default ${DEFAULT_ROWS}, max ${MAX_ROWS}.`),
                })
                // A non-strict schema drops an unknown key and ignores the filter: in
                // dining that meant an allergy filter returning an unfiltered menu.
                .strict(),
        },
        guard(
            async (input: {
                when?: string;
                query?: string;
                categories?: string[];
                audiences?: string[];
                venue?: (typeof VENUE_TYPES)[number];
                department?: string;
                near?: string;
                withinMetres?: number;
                freeFood?: boolean;
                freeAdmission?: boolean;
                onCampusOnly?: boolean;
                limit?: number;
            }) => {
                const now = new Date();
                const window = parseWindow(input.when, now);
                if (!window) {
                    throw new Error(
                        `Couldn't read when="${input.when}". Try "today", "tonight", ` +
                            '"tomorrow", "this week", "weekend", a weekday, or "2026-11-12".',
                    );
                }
                const unreachable = outOfRange(window, now);
                if (unreachable) {
                    throw new Error(`Can't answer for ${window.label}: ${unreachable}`);
                }

                const badCategories = (input.categories ?? []).filter(
                    (value) =>
                        !EVENT_CATEGORIES.some(
                            (known) => known.toLowerCase() === value.trim().toLowerCase(),
                        ),
                );
                if (badCategories.length) {
                    throw new Error(
                        `Unknown categor${badCategories.length > 1 ? "ies" : "y"}: ` +
                            `${badCategories.join(", ")}. Valid values are ` +
                            `${EVENT_CATEGORIES.join(", ")}.`,
                    );
                }
                const badAudiences = (input.audiences ?? []).filter(
                    (value) =>
                        !AUDIENCES.some(
                            (known) => known.toLowerCase() === value.trim().toLowerCase(),
                        ),
                );
                if (badAudiences.length) {
                    throw new Error(
                        `Unknown audience(s): ${badAudiences.join(", ")}. Valid values are ` +
                            `${AUDIENCES.join(", ")}.`,
                    );
                }

                // A blank `near` skipped the guard, so the radius was never applied
                // and a 50 m request returned the whole campus.
                if (input.near !== undefined && !input.near.trim()) {
                    throw new Error(
                        'near was empty. Give a building, e.g. "GDC" or "the SAC", or leave it out.',
                    );
                }
                if (input.withinMetres !== undefined && !input.near?.trim()) {
                    throw new Error(
                        "withinMetres only means something with near. Give the building to " +
                            "measure from, or drop withinMetres.",
                    );
                }

                let near: UtBuilding | null = null;
                if (input.near?.trim()) {
                    const hit = resolveBuilding(input.near);
                    if (!hit) {
                        throw new Error(
                            `Couldn't resolve near="${input.near}" to a UT building, so the ` +
                                "radius filter can't be applied. Call resolve_ut_location to " +
                                "check the name.",
                        );
                    }
                    near = hit.building;
                }
                // Bound to a const so it narrows inside the closures below.
                const anchor = near;
                const radius = input.withinMetres ?? DEFAULT_NEAR_METRES;

                // Two sources, settled independently. The central calendar
                // carries almost no departmental activity: cross-checked for
                // one week, 23 of 23 CS events were absent from it. Neither
                // source failing may take the other's answer down.
                const days = daysNeeded(window, now);
                const [central, departments] = await Promise.all([
                    getCalendar(days).then(
                        (value) => ({ ok: true as const, value }),
                        (reason: unknown) => ({ ok: false as const, reason }),
                    ),
                    getDepartmentCalendars(now, days),
                ]);
                // The central calendar is the only one whose failure is fatal:
                // without it there is no answer worth giving.
                if (!central.ok) throw central.reason;
                // `getDepartmentCalendars` settles every source internally, so
                // it resolves even when all of them fail; the fallback that
                // used to sit here was unreachable.
                const extra = departments;
                const calendar = {
                    ...central.value,
                    // byStart compares INSTANTS. Sources write the same moment
                    // as "...Z" or "...-06:00", and a string compare put Law
                    // and Cockrell rows six hours out of place.
                    events: [...central.value.events, ...extra.events].sort(byStart),
                };
                const sourceNote = extra.failed.length
                    ? `${extra.failed.join(", ")} did not answer, so some events are missing here.`
                    : null;
                const filters: EventFilters = {
                    from: window.from,
                    to: window.to,
                    query: input.query?.trim() || undefined,
                    // Trimmed so validation and matching see the same strings.
                    categories: input.categories?.map((value) => value.trim()),
                    audiences: input.audiences?.map((value) => value.trim()),
                    venue: input.venue,
                    department: input.department?.trim() || undefined,
                    freeAdmission: input.freeAdmission,
                    onCampusOnly: input.onCampusOnly,
                };
                let rows = filterEvents(calendar.events, filters);
                // A three-letter query is held to a whole word, so that "AI" cannot match "aid".
                const looseNote =
                    input.query && rows.length === 0
                        ? (() => {
                              const retry = filterEvents(calendar.events, {
                                  ...filters,
                                  looseQuery: true,
                              });
                              if (!retry.length) return null;
                              rows = retry;
                              return `Nothing matched "${input.query}" as a whole word, so these matched it as the start of a longer word.`;
                          })()
                        : null;
                if (input.freeFood) rows = rows.filter(mentionsFreeFood);
                // Collapse before anything is counted or capped.
                let series = collapseSeries(rows);
                let matched = series.map((entry) => entry.event);

                const notes: string[] = [];
                if (sourceNote) notes.push(sourceNote);

                // A department that matches nothing is the tool's most
                // misleading empty answer: asked for "Computer Science" it said
                // "Nothing on UT's calendar", and the agent reported that there
                // are no CS events at UT this week. There were 23 that week, on
                // the department's own calendar. So say what this field holds.
                // Collapsed, or this counts occurrence rows and reports 170
                // events in a window the line above calls 96.
                const needsWindowCount = Boolean(input.department) || Boolean(input.venue);
                const inWindowAll = needsWindowCount
                    ? collapseSeries(
                          filterEvents(calendar.events, { from: filters.from, to: filters.to }),
                      ).map((entry) => entry.event)
                    : [];
                const inWindow = input.department ? inWindowAll : [];
                // The DEPARTMENT has to be what emptied the list. Gating on
                // "the answer is empty" fired for the venue, query, freeFood
                // and freeAdmission filters too, so the tool told a student
                // there are no law events this week while listing "School of
                // Law" among the departments present in the same sentence.
                const departmentMatched = input.department
                    ? filterEvents(inWindow, { department: input.department }).length
                    : 0;
                if (input.department && matched.length === 0 && departmentMatched === 0) {
                    const present = [
                        ...new Set(inWindow.flatMap((event) => event.departments)),
                    ].sort();
                    const withNone = inWindow.filter((event) => !event.departments.length).length;
                    notes.push(
                        `No event in this window is tagged with a department matching "${input.department}". ` +
                            `${withNone} of ${inWindow.length} events here carry no department at all, and the ones that do are: ` +
                            `${present.join("; ") || "none"}. ` +
                            "Departments other than Computer Science, Law, McCombs and Cockrell keep their own calendar that is not read here, so " +
                            "try `query` instead, and treat this as 'not in the central calendar' rather than 'not happening'.",
                    );
                }
                // Every "held back" count has to run the WHOLE pipeline the
                // answer ran. `filters` omits freeFood and the radius, which
                // are applied after filterEvents, so a count taken from it
                // promises rows the follow-up call it suggests cannot return.
                // Three notes got this wrong one at a time; this is the single
                // path they now share.
                const heldBack = ({
                    unlabelledOnly,
                    ...filter
                }: EventFilters & { unlabelledOnly?: boolean }): number => {
                    let probe = filterEvents(calendar.events, filter);
                    if (unlabelledOnly) {
                        probe = probe.filter(
                            (event) =>
                                event.source !== "calendar.utexas.edu" &&
                                !event.categories.length &&
                                !event.audiences.length,
                        );
                    }
                    if (input.freeFood) probe = probe.filter(mentionsFreeFood);
                    let series = collapseSeries(probe);
                    if (anchor) {
                        series = series.filter(
                            ({ event }) =>
                                event.latitude !== null &&
                                event.longitude !== null &&
                                metresBetween(anchor, {
                                    latitude: event.latitude,
                                    longitude: event.longitude,
                                }) <= radius,
                        );
                    }
                    return series.length;
                };

                if (input.venue && input.venue !== "unknown") {
                    // Counted against the user's OTHER filters, not the whole
                    // window. A window-wide count told someone asking for
                    // virtual CS events that 5 rows were held back, and
                    // following the advice returned none of them: all five were
                    // McCombs rows the department filter excluded anyway.
                    // `looseQuery` too, so a loose answer gets a loose probe.
                    const unknown = heldBack({
                        ...filters,
                        venue: "unknown",
                        looseQuery: Boolean(looseNote),
                    });
                    if (unknown > 0) {
                        notes.push(
                            `${unknown} event(s) matching your other filters do not say whether they are online, so this venue filter excludes them. Pass venue "unknown" to see those.`,
                        );
                    }
                }

                if (input.categories?.length || input.audiences?.length) {
                    // Against the user's OTHER filters, not the bare window:
                    // counting the window claimed 33 rows were unreachable on a
                    // call that had narrowed itself to 14 of them, then 30 on a
                    // freeFood call where exactly 1 was reachable.
                    const { categories: _c, audiences: _a, ...others } = filters;
                    const unlabelled = heldBack({
                        ...others,
                        looseQuery: Boolean(looseNote),
                        unlabelledOnly: true,
                    });
                    if (unlabelled > 0) {
                        notes.push(
                            `${unlabelled} event(s) in this window come from a departmental calendar that publishes no category or audience, so this filter cannot reach them. Use department or query for those.`,
                        );
                    }
                }

                if (input.department && matched.length === 0 && departmentMatched > 0) {
                    notes.push(
                        `${departmentMatched} event(s) in this window are from "${input.department}", but the other filters removed all of them. Drop a filter rather than reading this as "nothing is happening".`,
                    );
                }

                if (anchor) {
                    const before = series.length;
                    series = series.filter(
                        ({ event }) =>
                            event.latitude !== null &&
                            event.longitude !== null &&
                            metresBetween(anchor, {
                                latitude: event.latitude,
                                longitude: event.longitude,
                            }) <= radius,
                    );
                    matched = series.map((entry) => entry.event);
                    const dropped = before - series.length;
                    if (dropped > 0) {
                        notes.push(
                            `${dropped} event(s) matching your other filters were excluded by the ` +
                                `${radius} m radius around ${anchor.code}, including any with ` +
                                "no coordinates at all.",
                        );
                    }
                }

                // Pushed here, after every filter. The note says "these
                // matched", and freeFood or the radius could empty the answer
                // after it had been decided, leaving it describing nothing.
                if (looseNote && series.length > 0) notes.push(looseNote);

                const limit = input.limit ?? DEFAULT_ROWS;
                const shownSeries = series.slice(0, limit);
                const shown = shownSeries.map((entry) => entry.event);

                const coverage = {
                    feedCoordinates: matched.filter((e) => e.coordinateSource === "feed").length,
                    resolvedFromBuilding: matched.filter((e) => e.coordinateSource === "building")
                        .length,
                    noCoordinates: matched.filter((e) => e.coordinateSource === null).length,
                };

                if (input.freeFood) {
                    notes.push(
                        "freeFood is a text match over the title, the full description and the location text. UT's calendar " +
                            "has no free-food field, so this finds events that say food is " +
                            "provided and will miss any that do not mention it.",
                    );
                }
                if (coverage.resolvedFromBuilding > 0) {
                    notes.push(
                        `${coverage.resolvedFromBuilding} event(s) had no coordinates in the ` +
                            "feed; those were resolved from the location text to a building, so " +
                            "they point at the building rather than the room.",
                    );
                }
                const away = matched.filter((event) => onCampus(event) === false).length;
                if (away > 0) {
                    notes.push(
                        `${away} of these are away from Austin, such as road games, and are ` +
                            "marked NOT on campus. Pass onCampusOnly to exclude them.",
                    );
                }
                if (coverage.noCoordinates > 0 && !anchor) {
                    notes.push(
                        `${coverage.noCoordinates} event(s) have no usable location, so they ` +
                            "cannot be placed on a map.",
                    );
                }
                if (matched.length > shown.length) {
                    notes.push(
                        `Showing ${shown.length} of ${matched.length}. Narrow the window or ` +
                            "add filters.",
                    );
                }
                if (calendar.truncated) {
                    notes.push(
                        "UT's calendar has more events than one call reads; results near the " +
                            "end of a long window may be incomplete.",
                    );
                }

                const out = shownSeries.map(({ event, occurrences, lastStart, starts }) => {
                    const metres =
                        anchor && event.latitude !== null && event.longitude !== null
                            ? metresBetween(anchor, {
                                  latitude: event.latitude,
                                  longitude: event.longitude,
                              })
                            : null;
                    return {
                        when: when(event.start, event.allDay),
                        title: event.title,
                        start: event.start,
                        end: event.end,
                        allDay: event.allDay,
                        locationName: event.locationName,
                        room: event.room,
                        buildingCode: event.buildingCode,
                        latitude: event.latitude,
                        longitude: event.longitude,
                        coordinateSource: event.coordinateSource,
                        walkMinutes: metres === null ? null : walkMinutes(metres),
                        venue: event.venue,
                        categories: event.categories,
                        audiences: event.audiences,
                        departments: event.departments,
                        source: event.source,
                        freeAdmission: event.freeAdmission,
                        mentionsFreeFood: mentionsFreeFood(event),
                        onCampus: onCampus(event),
                        occurrences,
                        // Every extra start in the window, not only the kept
                        // day's: a series running several days with two
                        // showings on some of them hid the extras in both the
                        // prose and the data.
                        alsoAt: starts.filter((t) => t !== event.start),
                        lastStart,
                        description: event.description,
                        url: event.url,
                    };
                });

                const body = shown.length
                    ? [
                          `${matched.length} event(s) ${window.label}` +
                              (anchor ? ` within ${radius} m of ${anchor.code}` : "") +
                              `, showing ${shown.length}:`,
                          "",
                          ...out.map((row) =>
                              [
                                  `${row.when} — ${row.title}`,
                                  // Both parts when they differ. Printing only
                                  // the room gave lines like "2.106", and for a
                                  // Pickle-campus event "2.102" while discarding
                                  // "JJ Pickle Campus ROC BLDG. 196".
                                  `  ${
                                      [row.locationName, row.room]
                                          // Drops a part that merely RESTATES
                                          // the other: an exact-match filter
                                          // left "WCP 2.112 2.112" and 59 rows
                                          // of "Benson Latin American
                                          // Collection Nettie Lee Benson
                                          // Latin American Collection, ...".
                                          .filter((part, i, all) => {
                                              if (!part) return false;
                                              const squash = (v: string) =>
                                                  v.toLowerCase().replace(/[^a-z0-9]/g, "");
                                              const self = squash(part);
                                              return !all.some((other, j) => {
                                                  if (j === i || !other) return false;
                                                  const them = squash(other);
                                                  // Keep the longer of a pair
                                                  // where one contains the other.
                                                  return (
                                                      them.includes(self) &&
                                                      (them.length > self.length || j < i)
                                                  );
                                              });
                                          })
                                          .join(", ") || "location not given"
                                  }` +
                                      (row.buildingCode ? ` [${row.buildingCode}]` : "") +
                                      (row.walkMinutes !== null
                                          ? ` · ~${row.walkMinutes} min walk`
                                          : ""),
                                  // Each segment supplies its own newline. The
                                  // venue line had none, so it glued onto
                                  // whatever followed it.
                                  (row.venue === "virtual"
                                      ? "  online\n"
                                      : row.venue === "hybrid"
                                        ? "  hybrid\n"
                                        : row.venue === "unknown"
                                          ? "  no venue given; this calendar does not say whether it is online\n"
                                          : "") +
                                      (row.occurrences > 1
                                          ? `  runs on ${row.occurrences} days in this window` +
                                            (row.lastStart
                                                ? `, last on ${when(row.lastStart, row.allDay)}`
                                                : "") +
                                            // Also when it spans days: a
                                            // series with two showings on some
                                            // of them hid the extras entirely.
                                            (row.alsoAt.length > row.occurrences - 1
                                                ? ", and more than once on some days"
                                                : "") +
                                            "\n"
                                          : row.alsoAt.length
                                            ? // One day, more than one showing: the
                                              // later time was invisible before.
                                              `  also at ${row.alsoAt
                                                  .map((t) => when(t, row.allDay))
                                                  .join(", ")}\n`
                                            : "") +
                                      `  ${row.categories.join(", ") || "uncategorised"}` +
                                      (row.freeAdmission ? " · free admission" : "") +
                                      (row.mentionsFreeFood ? " · says food provided" : "") +
                                      (row.onCampus === false ? " · NOT on campus" : ""),
                                  `  ${row.url}`,
                              ].join("\n"),
                          ),
                          ...notes.map((note) => `\nNOTE: ${note}`),
                      ].join("\n")
                    : [
                          `Nothing on UT's calendar ${window.label}` +
                              (anchor ? ` within ${radius} m of ${anchor.code}` : "") +
                              ".",
                          // Counted in the window and collapsed to one row per event.
                          `The window held ${
                              collapseSeries(
                                  filterEvents(calendar.events, {
                                      from: filters.from,
                                      to: filters.to,
                                  }),
                              ).length
                          } event(s) before the other filters.`,
                          ...notes.map((note) => `NOTE: ${note}`),
                      ].join("\n");

                return textWith(body, {
                    window: {
                        from: window.from.toISOString(),
                        to: window.to.toISOString(),
                        timezone: "America/Chicago",
                    },
                    matched: matched.length,
                    shown: shown.length,
                    coverage,
                    notes,
                    events: out,
                });
            },
        ),
    );
}
