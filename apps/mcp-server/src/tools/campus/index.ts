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

/** The `only` vocabulary. */
const ONLY_VENUES = [
    { label: "in person", venue: "inperson" },
    { label: "virtual", venue: "virtual" },
    { label: "hybrid", venue: "hybrid" },
    { label: "venue not stated", venue: "unknown" },
] as const satisfies readonly { label: string; venue: (typeof VENUE_TYPES)[number] }[];

const ONLY_VALUES = [
    ...ONLY_VENUES.map((entry) => entry.label),
    "free food",
    "free admission",
    "on campus",
] as const;

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
            /** Metres from `near`, null without it. What the ranking sorted on. */
            metresAway: z.number().nullable(),
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
            /** Every other start time in the window, when there are any. */
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
    /** The end the caller asked for, when it reached past what this tool reads. */
    requestedTo?: Date;
    /** Set when the caller asked for no end at all. */
    openEnded?: boolean;
}

/** A window's day in Austin, as YYYY-MM-DD. */
function isoOf(at: Date): string {
    const day = austinNow(at);
    const month = String(day.month).padStart(2, "0");
    return `${day.year}-${month}-${String(day.day).padStart(2, "0")}`;
}

/**
 * The last day INSIDE a window, whose `to` is an exclusive midnight.
 *
 * The trim note reached for `toISOString()` instead and named the day AFTER both ends: it told a
 * caller who typed 2027-01-21 that they had asked as far as 2027-01-22, and contradicted the label
 * printed three lines above it.
 */
function lastDayOf(to: Date): string {
    return isoOf(new Date(to.getTime() - 1));
}

/** Turn a phrase into a window in Austin time. */
export function parseWindow(phrase: string | undefined, now = new Date()): Window | null {
    const today = austinNow(now);
    const dayStart = (offset: number) =>
        austinInstant(today.year, today.month, today.day + offset, 0);
    /** A window of whole days. */
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

    // As far ahead as one call can actually read, EXCLUSIVE.  `dayStart(MAX_WINDOW_DAYS)` is the
    // midnight that OPENS the last readable day, so clamping to it threw that whole day away:
    // `after <today+60>` collapsed to a zero-width window and answered "Nothing on UT's calendar"
    // for a day holding 16 events, one of them a basketball game. `outOfRange` admits a start up to
    // day 60 and `daysNeeded` fetches 61 days, so the readable set is days 0 through 60 and the
    // exclusive end is the midnight after day 60.
    const horizon = dayStart(MAX_WINDOW_DAYS + 1);
    /** Clamps a window to the horizon, and remembers what was asked for. */
    const reachable = (from: Date, to: Date, label: (from: Date, to: Date) => string): Window => {
        const start = from < now ? now : from;
        const end = to > horizon ? horizon : to;
        return {
            from: start,
            to: end,
            label: label(start, end),
            ...(to > horizon ? { requestedTo: to } : {}),
        };
    };
    // Trailing punctuation is how a person types and how relayed text arrives: "tonight?" and
    // "Tonight!" were rejected outright.
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
        const sameWeek = today.dayIndex + ahead <= 6;
        const offset = /^next\s/.test(value) && sameWeek ? ahead + 7 : ahead;
        return span(offset, offset + 1, dated(offset));
    }

    // "next 30 days", "next 3 days", "30 days". Bounded by the caller's out-of-range check, so an
    // absurd N gets the same message as a far date.
    const spanDays = /^(?:next\s+|the\s+next\s+)?(\d{1,3})\s*days?$/.exec(value);
    if (spanDays) {
        const days = Number(spanDays[1]);
        if (days < 1) return null;
        // Counted in whole days from TODAY's midnight, not from `now`. From `now` the duration is
        // `days` minus however much of today has gone, so Math.round dropped one from noon onwards:
        // every afternoon, "next 30 days" was labelled "the next 29 days" and "next 2 days" became
        // "the next 1 days". The suite's clock is 09:00, so it could never see it.
        return reachable(now, dayStart(days), (_from, to) => {
            const span = Math.round((to.getTime() - dayStart(0).getTime()) / 86_400_000);
            return `the next ${Math.max(1, span)} days`;
        });
    }

    // "2026-12-01..2026-12-07", "2026-12-01 to 2026-12-07". The end day is
    // INCLUSIVE -- a person asking for the 1st to the 7th means through the
    // 7th, so the window closes at the 8th's midnight.
    const range =
        /^(\d{4}-\d{2}-\d{2})\s*(?:\.\.|-{1,2}>?|to|through|until)\s*(\d{4}-\d{2}-\d{2})$/.exec(
            value,
        );
    if (range) {
        const start = isoDay(range[1]!);
        const end = isoDay(range[2]!);
        if (!start || !end) return null;
        if (end.midnight < start.midnight) return null;
        const to = austinInstant(end.year, end.month, end.day + 1, 0);
        return reachable(
            start.midnight,
            to,
            (from, until) => `${isoOf(from)} to ${lastDayOf(until)}`,
        );
    }

    // "after 2026-12-01", "from 2026-12-01", "2026-12-01 onwards". Runs to the far edge of what one
    // call can serve; the caller trims and says so.
    const open =
        /^(?:after|from|since|starting)\s+(\d{4}-\d{2}-\d{2})$|^(\d{4}-\d{2}-\d{2})\s+(?:onwards?|on)$/.exec(
            value,
        );
    if (open) {
        const day = isoDay(open[1] ?? open[2]!);
        if (!day) return null;
        // Anchored on NOW, not on the named day. Sixty days after the DAY made
        // a wider request return fewer events -- "after 2026-09-24" answered
        // over two days and 29 rows where "after 2026-11-22" found 314 -- and
        // an open end in the past was refused outright, though "from September
        // onwards" is a question about the future.
        // Labelled with its real end, not "onwards": the window IS bounded,
        // and calling it open-ended is what let a reader conclude UT
        // basketball ends in January.
        return {
            ...reachable(
                day.midnight,
                horizon,
                (from, until) => `${isoOf(from)} to ${lastDayOf(until)}`,
            ),
            openEnded: true,
        };
    }

    const single = isoDay(value);
    if (single) {
        const to = austinInstant(single.year, single.month, single.day + 1, 0);
        // Today by its date is still today: open at `now` rather than replaying the morning.
        const from = single.midnight < now && now < to ? now : single.midnight;
        return { from, to, label: value };
    }
    return null;
}

/** One "YYYY-MM-DD", or null. */
function isoDay(
    value: string,
): { year: number; month: number; day: number; midnight: Date } | null {
    const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
    if (!iso) return null;
    const [year, month, day] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
    const midnight = austinInstant(year, month, day, 0);
    const check = austinNow(midnight);
    if (check.year !== year || check.month !== month || check.day !== day) return null;
    return { year, month, day, midnight };
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
                "not that nothing is happening. " +
                'EXAMPLES: everything tomorrow -> {when: "tomorrow"}. ' +
                'Free food this week -> {when: "this week", only: ["free food"]}. ' +
                'CS talks in December -> {when: "2026-12-01..2026-12-31", department: ' +
                '"Computer Science"}. ' +
                'What is on near my building -> {near: "GDC", withinMetres: 600}. ' +
                'Online events for students -> {only: ["virtual", "hybrid"], audiences: ' +
                '["Students"]}. ' +
                'Anything about basketball after finals -> {when: "after 2026-12-12", query: ' +
                '"basketball"}.',
            outputSchema: EVENTS_OUTPUT,
            inputSchema: z
                .object({
                    when: z
                        .string()
                        .optional()
                        .describe(
                            "When to look, as one of these exact forms. " +
                                'RELATIVE: "today" (the default, from now rather than this ' +
                                'morning), "tonight", "tomorrow", "this week" (the next 7 ' +
                                'days), "next week", "weekend". ' +
                                'A WEEKDAY: "friday", "this friday" or "next friday". These ' +
                                "mean the next Friday to come; where that day is still inside " +
                                'this Monday-to-Sunday week, "next friday" is the one after. ' +
                                "Every answer is dated, so read the date rather than relying " +
                                "on which one you asked for. " +
                                'ONE DAY: "2026-11-12". ' +
                                'A RANGE: "2026-12-01..2026-12-07", or the same with "to", ' +
                                '"through" or "until" in place of "..", with both days ' +
                                "included. " +
                                'OPEN-ENDED: "after 2026-12-01", or the same with "from" or ' +
                                '"since", which runs from that day (or today, if it has gone) ' +
                                `to ${MAX_WINDOW_DAYS} days from today. ` +
                                'A COUNT OF DAYS: "next 30 days". ' +
                                `No further than ${MAX_WINDOW_DAYS} days out, and not into the ` +
                                "past. Month names, times of day and anything else are " +
                                "rejected with a message naming these forms.",
                        ),
                    query: z
                        .string()
                        .optional()
                        .describe(
                            "Free text matched against the title, the full description, the " +
                                "location and the room. Several words match in any order. " +
                                "Singular and plural both work. A word of three letters or " +
                                'fewer must match a whole word, so "AI" cannot match "aid". ' +
                                "Tags and departments are matched only by an exact phrase, so " +
                                'that "art history" does not sweep in every Liberal Arts ' +
                                "event. Use this rather than `department` for a subject.",
                        ),
                    categories: z
                        .array(z.string())
                        .optional()
                        .describe(
                            "Keep events in ANY of these. Exact values only: " +
                                `${EVENT_CATEGORIES.join(", ")}. ` +
                                "The departmental calendars publish no category, so this " +
                                "filter cannot reach them at all -- use department or query " +
                                "for those.",
                        ),
                    audiences: z
                        .array(z.string())
                        .optional()
                        .describe(
                            "Keep events for ANY of these. Exact values only: " +
                                `${AUDIENCES.join(", ")}. ` +
                                "Most events name no audience, and the departmental calendars " +
                                "publish none, so this excludes more than it looks like.",
                        ),
                    only: z
                        .array(z.enum(ONLY_VALUES))
                        .optional()
                        .describe(
                            "Keep only events with ALL of these. Venue values are a set, so " +
                                '["virtual", "hybrid"] means either. Values: ' +
                                ONLY_VALUES.map((v) => `"${v}"`).join(", ") +
                                '. "venue not stated" is its own case because the departmental ' +
                                "calendars publish no venue, and those are not assumed in " +
                                'person. "free food" is read off the event text, not a ' +
                                'published field. "on campus" drops road games; events with no ' +
                                "location are kept, since they are unknown rather than away.",
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
                        .describe(
                            "A building code, name or nickname to measure from: " +
                                '"GDC", "the SAC", "PCL", "Gearing 114". Results come back ' +
                                "NEAREST FIRST instead of soonest first, and each row carries " +
                                "its distance. Events with no coordinates are dropped, since " +
                                "they cannot be ranked. Call resolve_ut_location first if you " +
                                "are unsure a name resolves.",
                        ),
                    withinMetres: z
                        .number()
                        .int()
                        .positive()
                        .optional()
                        .describe(
                            `How far from \`near\` to look, in metres. Default ` +
                                `${DEFAULT_NEAR_METRES}. REQUIRES \`near\`; on its own it is ` +
                                "an error. " +
                                "Widen it rather than dropping `near`: the ordering already " +
                                "puts the closest first.",
                        ),
                    limit: z
                        .number()
                        .int()
                        .positive()
                        .max(MAX_ROWS)
                        .optional()
                        .describe(`Rows to return. Default ${DEFAULT_ROWS}, max ${MAX_ROWS}.`),
                })
                // A non-strict schema drops an unknown key and ignores the filter: in dining that
                // meant an allergy filter returning an unfiltered menu.
                .strict(),
        },
        guard(
            async (input: {
                when?: string;
                query?: string;
                categories?: string[];
                audiences?: string[];
                only?: (typeof ONLY_VALUES)[number][];
                department?: string;
                near?: string;
                withinMetres?: number;
                limit?: number;
            }) => {
                const now = new Date();
                const window = parseWindow(input.when, now);
                if (!window) {
                    throw new Error(
                        `Couldn't read when="${input.when}". Use one of: "today", ` +
                            '"tonight", "tomorrow", "this week", "next week", "weekend", a ' +
                            'weekday like "friday" or "next friday", a date like ' +
                            '"2026-11-12", a range like "2026-12-01..2026-12-07", ' +
                            '"after 2026-12-01", or "next 30 days".',
                    );
                }
                const unreachable = outOfRange(window, now);
                if (unreachable) {
                    throw new Error(
                        `Can't answer for ${input.when?.trim() || window.label}: ${unreachable}`,
                    );
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

                // A blank `near` skipped the guard, so the radius was never applied and a 50 m
                // request returned the whole campus.
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
                const only = new Set(input.only ?? []);
                const venues = ONLY_VENUES.filter((v) => only.has(v.label)).map((v) => v.venue);
                const freeFood = only.has("free food");
                const freeAdmission = only.has("free admission");
                const onCampusOnly = only.has("on campus");

                const anchor = near;
                const radius = input.withinMetres ?? DEFAULT_NEAR_METRES;

                const days = daysNeeded(window, now);
                const [central, departments] = await Promise.all([
                    getCalendar(days).then(
                        (value) => ({ ok: true as const, value }),
                        (reason: unknown) => ({ ok: false as const, reason }),
                    ),
                    getDepartmentCalendars(now, days),
                ]);
                // The central calendar is the only one whose failure is fatal: without it there is
                // no answer worth giving.
                if (!central.ok) throw central.reason;
                // `getDepartmentCalendars` settles every source internally, so it resolves even
                // when all of them fail; the fallback that used to sit here was unreachable.
                const extra = departments;
                const calendar = {
                    ...central.value,
                    // byStart compares INSTANTS. Sources write the same moment as "...Z" or
                    // "...-06:00", and a string compare put Law and Cockrell rows six hours out of
                    // place.
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
                    venues: venues.length ? venues : undefined,
                    department: input.department?.trim() || undefined,
                    freeAdmission,
                    onCampusOnly,
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
                if (freeFood) rows = rows.filter(mentionsFreeFood);
                // Collapse before anything is counted or capped.
                let series = collapseSeries(rows);
                let matched = series.map((entry) => entry.event);

                const notes: string[] = [];
                // First, because it frames every count below it.
                if (window.openEnded) {
                    notes.push(
                        `An open end has no limit, but this tool reads ${MAX_WINDOW_DAYS} days ` +
                            `ahead, so this window stops at ${lastDayOf(window.to)}. Anything ` +
                            "later has not been read, rather than not existing.",
                    );
                } else if (window.requestedTo) {
                    notes.push(
                        `You asked as far as ${lastDayOf(window.requestedTo)}, but this tool ` +
                            `reads ${MAX_WINDOW_DAYS} days ahead, so the window stops at ` +
                            `${lastDayOf(window.to)}. Anything later has not been read, rather ` +
                            "than not existing.",
                    );
                }
                if (sourceNote) notes.push(sourceNote);

                const needsWindowCount = Boolean(input.department) || venues.length > 0;
                const inWindowAll = needsWindowCount
                    ? collapseSeries(
                          filterEvents(calendar.events, { from: filters.from, to: filters.to }),
                      ).map((entry) => entry.event)
                    : [];
                const inWindow = input.department ? inWindowAll : [];
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
                const looseProbe =
                    Boolean(looseNote) ||
                    (Boolean(filters.query) &&
                        filterEvents(calendar.events, {
                            from: filters.from,
                            to: filters.to,
                            query: filters.query,
                        }).length === 0);

                // Every "held back" count has to run the WHOLE pipeline the answer ran. `filters`
                // omits freeFood and the radius, which are applied after filterEvents, so a count
                // taken from it promises rows the follow-up call it suggests cannot return. Three
                // notes got this wrong one at a time; this is the single path they now share.
                const heldBack = ({
                    unlabelledOnly,
                    skipFreeFood,
                    ...filter
                }: EventFilters & { unlabelledOnly?: boolean; skipFreeFood?: boolean }): number => {
                    let probe = filterEvents(calendar.events, filter);
                    if (unlabelledOnly) {
                        probe = probe.filter(
                            (event) => !event.categories.length && !event.audiences.length,
                        );
                    }
                    if (freeFood && !skipFreeFood) probe = probe.filter(mentionsFreeFood);
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

                if (venues.length && !venues.includes("unknown")) {
                    const unknown = heldBack({
                        ...filters,
                        venues: ["unknown"],
                        looseQuery: looseProbe,
                    });
                    if (unknown > 0) {
                        notes.push(
                            `${unknown} event(s) matching your other filters do not say whether they are online, so this venue filter excludes them. Pass only: ["venue not stated"] to see those.`,
                        );
                    }
                }

                if (input.categories?.length || input.audiences?.length) {
                    const { categories: _c, audiences: _a, ...others } = filters;
                    let unlabelled = heldBack({
                        ...others,
                        looseQuery: looseProbe,
                        unlabelledOnly: true,
                    });
                    if (unlabelled > 0) {
                        notes.push(
                            `${unlabelled} event(s) in this window publish no category or audience at all, so this filter cannot reach them. Use query, or department where they have one, for those.`,
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
                    const beforeRows = series;
                    const metresFrom = ({ event }: (typeof series)[number]) =>
                        event.latitude !== null && event.longitude !== null
                            ? metresBetween(anchor, {
                                  latitude: event.latitude,
                                  longitude: event.longitude,
                              })
                            : null;
                    series = series.filter((entry) => {
                        const metres = metresFrom(entry);
                        return metres !== null && metres <= radius;
                    });
                    // Nearest first once a place is named, because that is what
                    // the question was. Time order is the tie-break, and it
                    // stays the order everywhere else. Sorted BEFORE the limit
                    // slice, or `limit` would keep the soonest N and then rank
                    // only those -- the nearest event could be cut entirely.
                    series = series
                        .map((entry) => ({ entry, metres: metresFrom(entry) ?? 0 }))
                        .sort(
                            (a, b) =>
                                a.metres - b.metres ||
                                Date.parse(a.entry.event.start) - Date.parse(b.entry.event.start),
                        )
                        .map(({ entry }) => entry);
                    matched = series.map((entry) => entry.event);
                    const dropped = before - series.length;
                    if (dropped > 0) {
                        // Counted apart. Lumping them together said "38 excluded by the radius"
                        // where 32 had no coordinates at all, so widening it could only ever find
                        // 6.
                        const unplaceable = beforeRows.filter(
                            ({ event }) => event.latitude === null || event.longitude === null,
                        ).length;
                        const tooFar = dropped - unplaceable;
                        const parts = [
                            tooFar > 0
                                ? `${tooFar} are outside the ${radius} m radius around ${anchor.code}`
                                : null,
                            unplaceable > 0
                                ? `${unplaceable} publish no coordinates, so they cannot be ` +
                                  "measured either way"
                                : null,
                        ].filter(Boolean);
                        notes.push(
                            `${dropped} event(s) matching your other filters are not shown: ` +
                                `${parts.join(", and ")}.` +
                                (tooFar > 0
                                    ? ` Widening the radius reaches ${tooFar} of them.`
                                    : " Widening the radius would not reach any of them."),
                        );
                    }
                }

                if (anchor && series.length > 1) {
                    notes.push(
                        `Ordered by distance from ${anchor.code}, nearest first, rather than by start time.`,
                    );
                }

                if (series.length === 0) {
                    const alternatives: [string, EventFilters][] = [];
                    if (filters.query) {
                        alternatives.push(["query", { ...filters, query: undefined }]);
                    }
                    if (filters.categories?.length) {
                        alternatives.push(["categories", { ...filters, categories: undefined }]);
                    }
                    if (filters.audiences?.length) {
                        alternatives.push(["audiences", { ...filters, audiences: undefined }]);
                    }
                    if (venues.length) {
                        alternatives.push([
                            `only ${venues.join(" or ")}`,
                            { ...filters, venues: undefined },
                        ]);
                    }
                    if (filters.department) {
                        alternatives.push(["department", { ...filters, department: undefined }]);
                    }
                    if (filters.freeAdmission) {
                        alternatives.push([
                            'only "free admission"',
                            { ...filters, freeAdmission: undefined },
                        ]);
                    }
                    if (filters.onCampusOnly) {
                        alternatives.push([
                            'only "on campus"',
                            { ...filters, onCampusOnly: undefined },
                        ]);
                    }
                    // Through the whole pipeline, so freeFood and the radius count too and the
                    // suggestion can actually be followed.
                    const blame = alternatives
                        .filter(([, without]) => heldBack(without) > 0)
                        .map(([name]) => name);
                    if (freeFood && heldBack({ ...filters, skipFreeFood: true }) > 0) {
                        blame.push('only "free food"');
                    }
                    if (blame.length > 0) {
                        notes.push(
                            `Nothing matched all of your filters. Dropping ${blame.join(" or ")} ` +
                                "would return events in this window.",
                        );
                    }
                }

                // Pushed here, after every filter. The note says "these matched", and freeFood or
                // the radius could empty the answer after it had been decided, leaving it
                // describing nothing.
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

                if (freeFood) {
                    notes.push(
                        'only: ["free food"] is a text match over the title, the full ' +
                            "description and the location text. UT's calendar " +
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
                            'marked NOT on campus. Pass only: ["on campus"] to exclude them.',
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
                        metresAway: metres === null ? null : Math.round(metres),
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
                                  `  ${
                                      [row.locationName, row.room]
                                          .filter((part, i, all) => {
                                              if (!part) return false;
                                              const squash = (v: string) =>
                                                  v.toLowerCase().replace(/[^a-z0-9]/g, "");
                                              const self = squash(part);
                                              return !all.some((other, j) => {
                                                  if (j === i || !other) return false;
                                                  const them = squash(other);
                                                  // Keep the longer of a pair where one contains
                                                  // the other.
                                                  return (
                                                      them.includes(self) &&
                                                      (them.length > self.length || j < i)
                                                  );
                                              });
                                          })
                                          .join(", ") || "location not given"
                                  }` +
                                      (row.buildingCode ? ` [${row.buildingCode}]` : "") +
                                      // The distance too, not just the walk time: it is what the
                                      // rows are ordered by, so a reader can see the ranking.
                                      (row.metresAway !== null
                                          ? ` · ${row.metresAway} m, ~${row.walkMinutes} min walk`
                                          : ""),
                                  // Each segment supplies its own newline. The venue line had none,
                                  // so it glued onto whatever followed it.
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
                                            // Also when it spans days: a series with two showings
                                            // on some of them hid the extras entirely.
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
