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
import {
    AUDIENCES,
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
            freeAdmission: z.boolean(),
            mentionsFreeFood: z.boolean(),
            /** null when there is no location to judge from. */
            onCampus: z.boolean().nullable(),
            /** Days in the window this runs on. >1 is an exhibition or a series. */
            occurrences: z.number(),
            /** Start of its last occurrence in the window, when it runs more than once. */
            lastStart: z.string().nullable(),
            description: z.string().nullable(),
            url: z.string(),
        }),
    ),
});

/**
 * Austin's UTC offset at a given instant, in minutes behind UTC.
 *
 * Central time is UTC-6 in winter and UTC-5 in summer, so a window cannot be
 * built by subtracting a constant. Reading the offset from the zone database is
 * the only way this stays right across the March and November transitions.
 */
function austinOffsetMinutes(at: Date): number {
    const name = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Chicago",
        timeZoneName: "longOffset",
    })
        .formatToParts(at)
        .find((part) => part.type === "timeZoneName")?.value;
    const match = /GMT([+-])(\d{2}):(\d{2})/.exec(name ?? "");
    if (!match) return 360; // CST, the safe assumption if the runtime surprises us
    const sign = match[1] === "-" ? 1 : -1;
    return sign * (Number(match[2]) * 60 + Number(match[3]));
}

/** An instant from an Austin wall-clock reading. */
function austinInstant(year: number, month: number, day: number, hour: number, minute = 0): Date {
    const guess = Date.UTC(year, month - 1, day, hour, minute);
    const first = new Date(guess + austinOffsetMinutes(new Date(guess)) * 60_000);
    // One correction pass: the offset at the guessed instant can differ from the
    // offset at the real one on a DST changeover day.
    return new Date(guess + austinOffsetMinutes(first) * 60_000);
}

const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

export interface Window {
    from: Date;
    to: Date;
    label: string;
}

/**
 * Turn a phrase into a window in Austin time.
 *
 * Returns null rather than guessing, because a window silently reinterpreted is
 * an answer about the wrong day, and the caller cannot tell.
 */
export function parseWindow(phrase: string | undefined, now = new Date()): Window | null {
    const today = austinNow(now);
    const dayStart = (offset: number) =>
        austinInstant(today.year, today.month, today.day + offset, 0);
    const span = (fromOffset: number, toOffset: number, label: string): Window => ({
        from: dayStart(fromOffset),
        to: dayStart(toOffset),
        label,
    });

    const value = (phrase ?? "today").trim().toLowerCase();
    if (!value || value === "today") {
        // From now, not from midnight: nobody asking what is on today wants the
        // lecture that finished this morning.
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
        //
        // `(5 - dayIndex + 7) % 7` is 6 on a Sunday, which is NEXT Saturday:
        // asked on a Sunday the tool reported next weekend's events under the
        // label "this weekend" and missed everything happening that day. On a
        // Sunday the weekend started yesterday, so the window opens now.
        if (today.dayIndex === 6) return { from: now, to: dayStart(1), label: "this weekend" };
        if (today.dayIndex === 5) {
            // Saturday: from now, consistent with "today", rather than from
            // midnight, which would include events that finished this morning.
            return { from: now, to: dayStart(2), label: "this weekend" };
        }
        return span(5 - today.dayIndex, 7 - today.dayIndex, "this weekend");
    }

    const weekday = WEEKDAYS.indexOf(value.replace(/^(next|this|coming)\s+/, ""));
    if (weekday >= 0) {
        const ahead = (weekday - today.dayIndex + 7) % 7;
        // "Monday" said on a Monday means today unless "next" is explicit.
        const offset = ahead === 0 && /^next\s/.test(value) ? 7 : ahead;
        return span(offset, offset + 1, WEEKDAYS[weekday] ?? value);
    }

    const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (iso) {
        const [year, month, day] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
        const from = austinInstant(year, month, day, 0);
        // Reject a date that rolled: "2026-02-30" would otherwise answer about
        // 2 March without saying so.
        const check = austinNow(from);
        if (check.year !== year || check.month !== month || check.day !== day) return null;
        return { from, to: austinInstant(year, month, day + 1, 0), label: value };
    }
    return null;
}

/**
 * Days of calendar to request, from how far the window reaches.
 *
 * Clamped to one day PAST what the tool promises. A window for the last day it
 * advertises closes at the start of the day after, so clamping to
 * MAX_WINDOW_DAYS itself left that final day uncovered: the date 60 days out
 * was accepted and then answered "nothing on UT's calendar" while UT published
 * 10 events on it. One day wide, every day.
 *
 * The extra day is close to free. Measured against the live feed: 60 days is
 * 893 events over 9 pages, 61 days is 903 over 10, against a MAX_PAGES ceiling
 * of 12. So the promise is now one the fetch can actually keep.
 */
function daysNeeded(window: Window, now: Date): number {
    const ms = window.to.getTime() - now.getTime();
    return Math.min(MAX_WINDOW_DAYS + 1, Math.max(1, Math.ceil(ms / 86_400_000) + 1));
}

/**
 * Is the window something one call can actually answer for?
 *
 * A past date, or one past MAX_WINDOW_DAYS, used to come back as a confident
 * "Nothing on UT's calendar 2027-05-01" plus a count of events that were never
 * in that window. The tool had not looked, and said so nowhere.
 */
function outOfRange(window: Window, now: Date): string | null {
    const dayMs = 86_400_000;
    // `<= now`, not `<= now - dayMs`. The day of grace meant YESTERDAY was
    // accepted at every hour: for `when` = yesterday the window closes at
    // today 00:00, which only falls behind `now - 24h` once tomorrow starts.
    // So "what was on yesterday?" came back as 46 finished events presented
    // exactly like upcoming ones, with no note that the day was over. The feed
    // serves no past events, so a window that has already closed cannot be
    // answered whatever the hour.
    if (window.to.getTime() <= now.getTime()) {
        return (
            "that is in the past. UT's calendar feed only serves upcoming events, so this " +
            "tool cannot answer for a date that has gone."
        );
    }
    const ahead = Math.ceil((window.from.getTime() - now.getTime()) / dayMs);
    // The fetch covers MAX_WINDOW_DAYS + 1 days, so every day this refuses is
    // genuinely outside what was read, and every day it admits is covered.
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
                "Find events happening at UT Austin from the university's official calendar. " +
                "Filter by when, by interest category, by who it is for, by department, by " +
                "whether it is in person, and by how close it is to a building. Every event " +
                "comes back with a link, and with coordinates where they can be worked out. " +
                "This covers institutional and departmental events; student club events are " +
                "mostly promoted on social media and are not in this calendar.",
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
                        .describe("Restrict to in-person, virtual or hybrid"),
                    department: z.string().optional().describe('e.g. "Fine Arts", "Libraries"'),
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
                // An unknown key here would be dropped by a non-strict schema and
                // the answer would silently ignore the filter, which in the dining
                // tools meant an allergy filter coming back as an unfiltered menu.
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

                // A blank `near` used to skip the guard below entirely, so the
                // radius was computed and never applied: asking for events
                // within 50 m returned the whole campus with no note.
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

                const calendar = await getCalendar(daysNeeded(window, now));
                const filters: EventFilters = {
                    from: window.from,
                    to: window.to,
                    query: input.query?.trim() || undefined,
                    // Trimmed here so validation above and matching below see
                    // the same strings; they did not, and " Academics" passed
                    // validation then matched nothing.
                    //
                    // `lower()` in extract.ts trims too, deliberately: that
                    // function is exported and a caller who has not been
                    // through this validation still needs the right answer.
                    // Neither is dead code, and mutation testing reports each
                    // as survivable only because the other is there.
                    categories: input.categories?.map((value) => value.trim()),
                    audiences: input.audiences?.map((value) => value.trim()),
                    venue: input.venue,
                    department: input.department?.trim() || undefined,
                    freeAdmission: input.freeAdmission,
                    onCampusOnly: input.onCampusOnly,
                };
                let rows = filterEvents(calendar.events, filters);
                // A three-letter query is held to a whole word, so that "AI"
                // cannot match "aid". When that finds nothing, try again
                // letting it match the start of a longer word -- "bio" reaching
                // "biology" -- and say which way it matched. The answer is then
                // never silently empty and never silently the wrong set.
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
                // Collapse before anything is counted or capped. Localist
                // repeats a multi-day event once per day, so "245 events this
                // week" was really 153, and `limit` was spent on repeats.
                let series = collapseSeries(rows);
                let matched = series.map((entry) => entry.event);

                const notes: string[] = [];
                if (looseNote) notes.push(looseNote);
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
                            `${dropped} event(s) in this window were excluded by the ` +
                                `${radius} m radius around ${anchor.code}, including any with ` +
                                "no coordinates at all.",
                        );
                    }
                }

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

                const out = shownSeries.map(({ event, occurrences, lastStart }) => {
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
                        freeAdmission: event.freeAdmission,
                        mentionsFreeFood: mentionsFreeFood(event),
                        onCampus: onCampus(event),
                        occurrences,
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
                                  `  ${row.room ?? row.locationName ?? "location not given"}` +
                                      (row.buildingCode ? ` [${row.buildingCode}]` : "") +
                                      (row.walkMinutes !== null
                                          ? ` · ~${row.walkMinutes} min walk`
                                          : ""),
                                  (row.occurrences > 1
                                      ? `  runs on ${row.occurrences} days in this window` +
                                        (row.lastStart
                                            ? `, last on ${when(row.lastStart, row.allDay)}`
                                            : "") +
                                        "\n"
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
                          // Counted in the window and collapsed to one row per
                          // event. `calendar.events` is the whole multi-day
                          // fetch in occurrence rows, so it said "the window
                          // held 130 event(s)" for a day holding 45, and 227
                          // for a week holding 105 -- a number that invited the
                          // agent to tell the student the filter was at fault.
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
