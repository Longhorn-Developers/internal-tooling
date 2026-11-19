import type { McpServer } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { resetCache } from "../src/shared";
import {
    ALL_BUILDINGS,
    isNonPhysicalLocation,
    metresBetween,
    resolveBuilding,
    toPrecision,
    walkMinutes,
} from "../src/tools/campus/buildings";
import {
    MAX_WINDOW_DAYS,
    byStart,
    collapseSeries,
    filterEvents,
    getCalendar,
    mentionsFreeFood,
    normalizeEvent,
    onCampus,
    type CampusEvent,
} from "../src/tools/campus/extract";
import { parseWindow, registerCampusTools } from "../src/tools/campus";
import { CAMPUS_NOW, fixture, stubFetch, type FetchLog } from "./fixtures";
import {
    CS_SOURCE,
    getCsCalendar,
    monthsSpanned,
    parseFeedDescriptions,
    parseMonth,
    parseRooms,
} from "../src/tools/campus/cs";
import {
    getDepartmentCalendars,
    icsInstant,
    parseIcs,
    parseLiveWhale,
    parseWordPress,
    unfoldIcs,
} from "../src/tools/campus/providers";

type LocationStructured = {
    query: string;
    resolved: boolean;
    physical: boolean;
    building: { code: string; name: string; latitude: number; precision: string } | null;
    matchedBy: string | null;
    distance: { from: string; metres: number; walkMinutes: number } | null;
    suggestions: { code: string }[];
    notes: string[];
};

type EventsStructured = {
    window: { from: string; to: string };
    matched: number;
    shown: number;
    coverage: { feedCoordinates: number; resolvedFromBuilding: number; noCoordinates: number };
    notes: string[];
    events: {
        when: string;
        title: string;
        start: string;
        buildingCode: string | null;
        latitude: number | null;
        coordinateSource: string | null;
        walkMinutes: number | null;
        venue: string;
        categories: string[];
        audiences: string[];
        freeAdmission: boolean;
        mentionsFreeFood: boolean;
        onCampus: boolean | null;
        occurrences: number;
        lastStart: string | null;
        allDay: boolean;
        end: string | null;
        departments: string[];
        source: string;
        description: string | null;
    }[];
};

type ToolResult = {
    content: { type: string; text: string }[];
    structuredContent?: unknown;
    isError?: boolean;
};

type Registered = {
    config: {
        outputSchema?: { parse: (value: unknown) => unknown };
        // The call has to go through the input schema: one that drops what it
        // does not recognise is invisible from inside the handler.
        inputSchema?: {
            safeParse: (value: unknown) => {
                success: boolean;
                data?: unknown;
                error?: { message: string };
            };
        };
    };
    handler: (args: Record<string, unknown>, extra: unknown) => Promise<ToolResult>;
};

const tools = new Map<string, Registered>();
registerCampusTools({
    registerTool: (name: string, config: Registered["config"], handler: Registered["handler"]) =>
        tools.set(name, { config, handler }),
} as unknown as McpServer);

/** Drives a tool the way the server does: through its input schema, then its handler. */
async function call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    const tool = tools.get(name);
    if (!tool) throw new Error(`No such tool: ${name}`);
    let input = args;
    if (tool.config.inputSchema) {
        const checked = tool.config.inputSchema.safeParse(args);
        if (!checked.success) {
            return {
                isError: true,
                content: [{ type: "text", text: checked.error?.message ?? "invalid arguments" }],
            };
        }
        input = checked.data as Record<string, unknown>;
    }
    const result = await tool.handler(input, {});
    // A declared outputSchema is a promise to the client, so hold the handler to it.
    if (tool.config.outputSchema && result.structuredContent && !result.isError) {
        tool.config.outputSchema.parse(result.structuredContent);
    }
    return result;
}

const location = async (args: Record<string, unknown>) => {
    const result = await call("resolve_ut_location", args);
    return { ...result, data: result.structuredContent as LocationStructured };
};

const events = async (args: Record<string, unknown> = {}) => {
    const result = await call("find_events", args);
    return { ...result, data: result.structuredContent as EventsStructured };
};

let log: FetchLog;

beforeEach(() => {
    resetCache();
    log = stubFetch();
    vi.useFakeTimers();
    vi.setSystemTime(CAMPUS_NOW);
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe("building data", () => {
    it("has every building on campus and inside campus bounds", () => {
        expect(ALL_BUILDINGS.length).toBeGreaterThan(190);
        for (const building of ALL_BUILDINGS) {
            expect(building.latitude).toBeGreaterThan(29.5);
            expect(building.latitude).toBeLessThan(31);
            expect(building.longitude).toBeGreaterThan(-98.5);
            expect(building.longitude).toBeLessThan(-96.5);
        }
    });

    it("measures a known distance across campus to the metre", () => {
        // Pinned, not bounded. A loose range let the haversine be halved and
        // the detour factor dropped with the suite still green.
        const d = (a: string, b: string) =>
            metresBetween(resolveBuilding(a)!.building, resolveBuilding(b)!.building);
        expect(d("GDC", "PCL")).toBeCloseTo(421.4, 0);
        expect(d("WCP", "PCL")).toBeCloseTo(298.1, 0);
        expect(d("GDC", "GRE")).toBeCloseTo(253.0, 0);
        // Symmetric, and zero to itself.
        expect(d("PCL", "GDC")).toBeCloseTo(d("GDC", "PCL"), 6);
        expect(d("GDC", "GDC")).toBeCloseTo(0, 6);
    });

    it("converts distance to walking minutes with a detour allowance", () => {
        // 1.4 m/s with a 1.3 detour factor. Without pinning these, both the
        // pace and the factor could be changed silently.
        expect(walkMinutes(421.4)).toBe(7);
        expect(walkMinutes(298.1)).toBe(5);
        expect(walkMinutes(253.0)).toBe(4);
        // 1.0 (no detour allowance) would give 5, not 7, at 421 m.
        expect(walkMinutes(421.4)).not.toBe(5);
    });

    it("never reports zero walking minutes, because arriving still takes a moment", () => {
        expect(walkMinutes(0)).toBe(1);
    });
});

describe("resolveBuilding", () => {
    it("resolves a bare code", () => {
        expect(resolveBuilding("GDC")?.building.code).toBe("GDC");
        expect(resolveBuilding("gdc")?.building.code).toBe("GDC");
    });

    it("resolves a room reference", () => {
        expect(resolveBuilding("WEL 2.224")?.building.code).toBe("WEL");
        expect(resolveBuilding("GSB 2.126")?.building.code).toBe("GSB");
    });

    it("resolves the nicknames students actually use", () => {
        expect(resolveBuilding("the SAC")?.building.code).toBe("WCP");
    });

    // Each of these is a string UT's calendar publishes with no coordinate,
    // which resolved to nothing before the alias table covered it. The row
    // counts are from a 60-day pull measured 2026-11-09.
    it("resolves a venue inside a building", () => {
        expect(resolveBuilding("Cactus Cafe")?.building.code).toBe("UNB"); // 20 rows
        expect(resolveBuilding("Shirley Bird Perry Ballroom")?.building.code).toBe("UNB");
        expect(resolveBuilding("James Turrell Skyspace")?.building.code).toBe("WCP");
    });

    it("resolves a building the feed names differently from UT's data", () => {
        // TSC was in buildings.json the whole time. The city prefix athletics
        // rows add, plus CTR against Center, meant no path reached it.
        const swimming = resolveBuilding("Austin, Texas, Lee and Joe Jamail Texas Swimming Center");
        expect(swimming?.building.code).toBe("TSC"); // 16 rows
        expect(resolveBuilding("Texas Swimming Center")?.building.code).toBe("TSC");
    });

    it("resolves SEAY, which is not SEA", () => {
        // SEA is on the ambiguous-code list, so it only matches when it leads
        // the string, and "SEAY" is a different token either way.
        expect(resolveBuilding("SEAY Library - Room 4.244")?.building.code).toBe("SEA"); // 6 rows
    });

    it("resolves the stadium and the Tower by the names people write", () => {
        expect(resolveBuilding("Austin, Texas, DKR-Texas Memorial Stadium")?.building.code).toBe(
            "STD",
        );
        expect(resolveBuilding("The University of Texas at Austin Tower")?.building.code).toBe(
            "MAI",
        );
        expect(resolveBuilding("South Mall")?.building.code).toBe("MAI");
    });

    it("still refuses an away game", () => {
        // The remaining unresolved rows are road games, and resolving them to
        // anything on campus would be worse than refusing.
        for (const away of [
            "Athens, Ga., Dan Magill Tennis Complex",
            "Lincoln, Neb., Sid and Hazel Dillon Tennis Center",
            "Baton Rouge, La., Tiger Stadium",
            "College Station, Texas, Kyle Field",
        ]) {
            expect(resolveBuilding(away)).toBeNull();
        }
        expect(resolveBuilding("Student Activity Center")?.building.code).toBe("WCP");
        expect(resolveBuilding("Texas Union")?.building.code).toBe("UNB");
        expect(resolveBuilding("UT Tower")?.building.code).toBe("MAI");
    });

    it("resolves the dining names, so dining and events agree on a place", () => {
        // The dining tools speak J2/JCL/Kins; nothing else on this server does,
        // and without these a dining answer cannot be placed on a map.
        expect(resolveBuilding("J2")?.building.code).toBe("JES");
        expect(resolveBuilding("JCL")?.building.code).toBe("JES");
        expect(resolveBuilding("Kins")?.building.code).toBe("KIN");
        expect(resolveBuilding("Jester")?.building.code).toBe("JES");
    });

    it("does not read an ambiguous code out of an English word", () => {
        // AND is Andrews Residence Hall. This must be Jester, not Andrews.
        expect(resolveBuilding("Jester and Gregory Gym")?.building.code).not.toBe("AND");
        // TOWER inside a longer string is a floor, not the UT Tower.
        const hit = resolveBuilding('"HQ" Room, Floor 1 North Tower, EER Building');
        expect(hit?.building.code).toBe("EER");
    });

    it("does not put an off-campus address inside a campus building", () => {
        // EDUCATION is unique to the Engineering Education and Research Center,
        // so a name-token match alone sent this marine lab 200 miles into EER.
        const hit = resolveBuilding(
            "Patton Center for Marine Science Education 855 E. Cotter Ave. Port Aransas",
        );
        // `not.toBe("EER")` alone passed for any other wrong building too.
        expect(hit).toBeNull();
    });

    it("resolves a surname and room number with no building type", () => {
        const hit = resolveBuilding("Gearing 114");
        expect(hit?.matchedBy).toBe("room-reference");
    });

    it("keeps the AT&T Conference Center findable despite the ampersand", () => {
        expect(resolveBuilding("AT&T Conference Center")).not.toBeNull();
    });

    it("resolves a code in parentheses even where the code is an English word", () => {
        // UT's own feed writes this. ART is in AMBIGUOUS_CODES and sits at
        // token 5, so the leading-word rule rejected it and the whole string
        // resolved to nothing.
        expect(resolveBuilding("Art Building (ART)")?.building.code).toBe("ART");
        expect(resolveBuilding("Visual Arts Center, Art Building (ART)")?.building.code).toBe(
            "ART",
        );
        expect(resolveBuilding("Ann Hartness Reading Room (SRH 1.106)")?.building.code).toBe("SRH");
    });

    it("resolves a name that is mostly a street number", () => {
        expect(resolveBuilding("2400 Nueces")?.building.code).toBe("N24");
    });

    it("treats online and unscheduled locations as absent, not unrecognised", () => {
        // "N/A" was the miss: normalize() turns "/" into a space, so the raw
        // list entry was unreachable and it fell through to the suggestion
        // path, offering five buildings for a string meaning "unknown".
        for (const value of ["Online", "Zoom", "TBA", "TBD", "Virtual", "N/A", "Off-Campus", ""]) {
            expect(isNonPhysicalLocation(value)).toBe(true);
            expect(resolveBuilding(value)).toBeNull();
        }
        expect(isNonPhysicalLocation("GDC 2.216")).toBe(false);
    });
});

describe("resolve_ut_location", () => {
    it("answers with the building, its address and a coordinate", async () => {
        const { data, content } = await location({ location: "GDC 2.216" });
        expect(data.resolved).toBe(true);
        expect(data.building?.code).toBe("GDC");
        expect(data.building?.precision).toBe("marker");
        expect(content[0]?.text).toContain("GATES DELL COMPLEX");
        expect(content[0]?.text).toContain("utdirect.utexas.edu");
    });

    it("reports a non-physical location as a correct answer, not a failure", async () => {
        const { data, isError } = await location({ location: "Zoom" });
        expect(isError).toBeFalsy();
        expect(data.resolved).toBe(false);
        expect(data.physical).toBe(false);
        expect(data.notes.join(" ")).toContain("Not a physical location");
    });

    it("suggests candidates when nothing matches", async () => {
        const { data } = await location({ location: "WE" });
        expect(data.resolved).toBe(false);
        expect(data.physical).toBe(true);
        expect(data.suggestions.length).toBeGreaterThan(0);
        expect(data.suggestions.some((s) => s.code.startsWith("WE"))).toBe(true);
    });

    it("gives a distance and a walk estimate for two places", async () => {
        const { data, content } = await location({ location: "GDC", relativeTo: "PCL" });
        expect(data.distance?.from).toBe("PCL");
        expect(data.distance?.metres).toBeGreaterThan(0);
        expect(data.distance?.walkMinutes).toBeGreaterThan(0);
        expect(content[0]?.text).toContain("minute walk");
        // The estimate must announce itself as one.
        expect(data.notes.join(" ")).toContain("estimate");
    });

    it("still answers the main question when relativeTo cannot be resolved", async () => {
        const { data } = await location({ location: "GDC", relativeTo: "Hogwarts" });
        expect(data.resolved).toBe(true);
        expect(data.distance).toBeNull();
        expect(data.notes.join(" ")).toContain("relativeTo");
    });

    it("says when a coordinate is the building centre rather than a marker", async () => {
        const loose = ALL_BUILDINGS.find((b) => b.precision !== "marker");
        // Guard rather than assume: if UT's data ever becomes all-marker this
        // test should stop asserting, not start failing for the wrong reason.
        if (!loose) return;
        const { data } = await location({ location: loose.code });
        expect(data.notes.join(" ")).toMatch(/approximate|footprint/);
    });

    it("rejects an unknown argument to resolve_ut_location instead of ignoring it", async () => {
        const result = await call("resolve_ut_location", { locations: "GDC" });
        expect(result.isError).toBe(true);
    });

    it("does not reach the network at all", async () => {
        await location({ location: "GDC" });
        expect(log).toHaveLength(0);
    });
});

describe("parseWindow", () => {
    it("starts today's window at now, not at midnight", () => {
        const window = parseWindow("today", CAMPUS_NOW)!;
        expect(window.from.getTime()).toBe(CAMPUS_NOW.getTime());
    });

    it("reads tonight as the evening, and tomorrow as the whole day", () => {
        expect(parseWindow("tonight", CAMPUS_NOW)?.label).toBe("tonight");
        const tomorrow = parseWindow("tomorrow", CAMPUS_NOW)!;
        expect(tomorrow.to.getTime() - tomorrow.from.getTime()).toBe(86_400_000);
    });

    it("reads a weekday as the next one, and today when it is today", () => {
        // CAMPUS_NOW is a Monday.
        expect(parseWindow("monday", CAMPUS_NOW)?.label).toBe("monday");
        const monday = parseWindow("monday", CAMPUS_NOW)!;
        const nextMonday = parseWindow("next monday", CAMPUS_NOW)!;
        expect(nextMonday.from.getTime() - monday.from.getTime()).toBe(7 * 86_400_000);
    });

    it("reads this weekend as the coming Saturday and Sunday", () => {
        // CAMPUS_NOW is a Monday, so Saturday is 5 days out.
        const weekend = parseWindow("weekend", CAMPUS_NOW)!;
        expect(weekend.from.toISOString()).toBe("2026-11-14T06:00:00.000Z");
        expect(weekend.to.toISOString()).toBe("2026-11-16T06:00:00.000Z");
    });

    it("reads this weekend on a Saturday or Sunday as the one in progress", () => {
        // `(5 - dayIndex + 7) % 7` is 6 on a Sunday, which is NEXT Saturday:
        // asked on a Sunday the tool reported next weekend and missed today.
        const sunday = new Date("2026-11-15T16:00:00Z"); // 10:00 CST, a Sunday
        const onSunday = parseWindow("this weekend", sunday)!;
        expect(onSunday.from.getTime()).toBe(sunday.getTime());
        expect(onSunday.to.toISOString()).toBe("2026-11-16T06:00:00.000Z");

        const saturday = new Date("2026-11-14T16:00:00Z");
        const onSaturday = parseWindow("this weekend", saturday)!;
        expect(onSaturday.from.getTime()).toBe(saturday.getTime());
        expect(onSaturday.to.toISOString()).toBe("2026-11-16T06:00:00.000Z");
    });

    it("reads this week as now until midnight seven days out", () => {
        // Not a 7x24h span: it starts at `now`, like "today", so a lecture
        // that finished this morning is not in it.
        const week = parseWindow("this week", CAMPUS_NOW)!;
        expect(week.from.getTime()).toBe(CAMPUS_NOW.getTime());
        expect(week.to.toISOString()).toBe("2026-11-16T06:00:00.000Z");
    });

    it("starts tonight in the evening, not at midnight", () => {
        const morning = new Date("2026-11-09T15:00:00Z"); // 09:00 CST
        const tonight = parseWindow("tonight", morning)!;
        // 17:00 CST is 23:00 UTC.
        expect(tonight.from.toISOString()).toBe("2026-11-09T23:00:00.000Z");
    });

    it("reads an ISO date", () => {
        const window = parseWindow("2026-11-12", CAMPUS_NOW)!;
        expect(window.to.getTime() - window.from.getTime()).toBe(86_400_000);
    });

    it("refuses a date that would silently roll into the next month", () => {
        // "2026-02-30" as a Date rolls to 2 March and would answer about the
        // wrong day without saying so.
        expect(parseWindow("2026-02-30", CAMPUS_NOW)).toBeNull();
    });

    it("refuses a phrase it does not understand rather than guessing", () => {
        expect(parseWindow("whenever", CAMPUS_NOW)).toBeNull();
        expect(parseWindow("next quarter", CAMPUS_NOW)).toBeNull();
    });

    it("builds windows in Central time, not UTC", () => {
        // Midnight in Austin on 10 November 2026 (CST) is 06:00 UTC. A window
        // built in UTC would be six hours out and would answer about the wrong
        // evening for anything after 18:00.
        const tomorrow = parseWindow("tomorrow", CAMPUS_NOW)!;
        expect(tomorrow.from.toISOString()).toBe("2026-11-10T06:00:00.000Z");
    });
});

describe("normalizeEvent", () => {
    it("returns one row per occurrence, not per event", () => {
        const rows = normalizeEvent({
            event: {
                id: 1,
                title: "Weekly seminar",
                event_instances: [
                    { event_instance: { id: 11, start: "2026-11-09T17:00:00-06:00" } },
                    { event_instance: { id: 12, start: "2026-11-16T17:00:00-06:00" } },
                    { event_instance: { id: 13, start: "2026-11-23T17:00:00-06:00" } },
                ],
            },
        });
        expect(rows).toHaveLength(3);
        expect(rows.map((r) => r.instanceId)).toEqual([11, 12, 13]);
    });

    it("drops an event with no instances rather than inventing a date", () => {
        expect(normalizeEvent({ event: { id: 1, title: "No date", event_instances: [] } })).toEqual(
            [],
        );
    });

    it("reads Localist's string coordinates as numbers and rejects zero", () => {
        const [withCoords] = normalizeEvent({
            event: {
                id: 2,
                title: "Has coords",
                geo: { latitude: "30.286256", longitude: "-97.732996" },
                event_instances: [
                    { event_instance: { id: 21, start: "2026-11-09T12:00:00-06:00" } },
                ],
            },
        });
        expect(withCoords?.latitude).toBeCloseTo(30.286256);
        expect(withCoords?.coordinateSource).toBe("feed");

        const [atNullIsland] = normalizeEvent({
            event: {
                id: 3,
                title: "Zeroes are not a place",
                geo: { latitude: "0", longitude: "0" },
                event_instances: [
                    { event_instance: { id: 31, start: "2026-11-09T12:00:00-06:00" } },
                ],
            },
        });
        expect(atNullIsland?.coordinateSource).not.toBe("feed");
    });

    it("backfills a coordinate from the room reference when the feed has none", () => {
        const [row] = normalizeEvent({
            event: {
                id: 4,
                title: "Reading group",
                location_name: "The University of Texas at Austin",
                room_number: "Ann Hartness Reading Room (SRH 1.106)",
                geo: { latitude: null, longitude: null },
                event_instances: [
                    { event_instance: { id: 41, start: "2026-11-09T12:00:00-06:00" } },
                ],
            },
        });
        // The room names a building where the location name does not.
        expect(row?.buildingCode).toBe("SRH");
        expect(row?.coordinateSource).toBe("building");
    });
});

describe("normalizeEvent text cleanup", () => {
    const one = (title: string, description?: string) =>
        normalizeEvent({
            event: {
                id: 9,
                title,
                description_text: description,
                event_instances: [
                    { event_instance: { id: 91, start: "2026-11-09T12:00:00-06:00" } },
                ],
            },
        })[0];

    it("keeps real UTF-8 punctuation intact", () => {
        // UT serves curly quotes and accents correctly, and they must survive:
        // this is the common case and the reason not to be aggressive above.
        const row = one("Russell Lee’s Pedagogical Legacy", "Café — a talk");
        expect(row?.title).toBe("Russell Lee’s Pedagogical Legacy");
        expect(row?.description).toBe("Café — a talk");
    });

    it("strips a replacement character if a bad byte ever reaches us", () => {
        // Not present in UT's feed today. `res.text()` substitutes U+FFFD for
        // anything it cannot decode, and a black diamond in an answer is worse
        // than a missing glyph.
        const row = one("Bad�byte", "Also�here");
        expect(row?.title).toBe("Badbyte");
        expect(row?.description).toBe("Alsohere");
    });

    it("returns null for a description that was only whitespace", () => {
        expect(one("Title", "   ")?.description).toBeNull();
    });
});

/**
 * A complete CampusEvent, so tests can override just the field under test.
 *
 * `searchText` is derived from the overrides unless one is given, the same way
 * `normalizeEvent` builds it. A hardcoded empty string here would make every
 * query and free-food test pass against a field the real code never sees.
 */
function makeEvent(over: Partial<CampusEvent> = {}): CampusEvent {
    const base: CampusEvent = {
        id: 1,
        instanceId: 1,
        title: "T",
        description: null,
        searchText: "",
        start: "2026-11-09T12:00:00-06:00",
        end: null,
        allDay: false,
        locationName: null,
        room: null,
        address: null,
        latitude: null,
        longitude: null,
        coordinateSource: null,
        buildingCode: null,
        venue: "inperson",
        categories: [],
        audiences: [],
        departments: [],
        tags: [],
        canceled: false,
        freeAdmission: false,
        ticketCost: null,
        streamUrl: null,
        url: "https://calendar.utexas.edu/event/1",
        photoUrl: null,
        source: "calendar.utexas.edu",
        ...over,
    };
    if (over.searchText !== undefined) return base;
    return {
        ...base,
        searchText: [
            base.title,
            base.description ?? "",
            ...base.tags,
            ...base.departments,
            base.locationName ?? "",
            base.room ?? "",
        ]
            .filter(Boolean)
            .join("\n")
            .toLowerCase(),
    };
}

describe("filterEvents window semantics", () => {
    const at = (start: string, end: string | null, allDay = false): CampusEvent =>
        makeEvent({ start, end, allDay });

    const tue = {
        from: new Date("2026-11-10T06:00:00Z"),
        to: new Date("2026-11-11T06:00:00Z"),
    };

    it("keeps a multi-day run on every day it covers", () => {
        const exhibition = at("2026-11-09T10:00:00-06:00", "2026-11-17T17:00:00-06:00");
        expect(filterEvents([exhibition], tue)).toHaveLength(1);
    });

    it("drops an all-day event from the following day", () => {
        // Its assumed end is the instant the next day starts, which is not an
        // overlap. With a `<` comparison every all-day event showed up twice.
        const allDay = at("2026-11-09T00:00:00-06:00", null, true);
        expect(filterEvents([allDay], tue)).toHaveLength(0);
        expect(
            filterEvents([allDay], {
                from: new Date("2026-11-09T06:00:00Z"),
                to: new Date("2026-11-10T06:00:00Z"),
            }),
        ).toHaveLength(1);
    });

    it("drops an event whose date cannot be read, rather than placing it anywhere", () => {
        expect(filterEvents([at("not a date", null)], tue)).toHaveLength(0);
    });
});

describe("onCampus", () => {
    it("calls a coordinate on campus", () => {
        expect(onCampus(makeEvent({ latitude: 30.2862, longitude: -97.7365 }))).toBe(true);
    });

    it("keeps the Pickle Research Campus on campus", () => {
        // About 10 km north. It is UT, and a 3 km radius would have excluded it.
        expect(onCampus(makeEvent({ latitude: 30.3885, longitude: -97.7249 }))).toBe(true);
    });

    it("calls another state off campus, by coordinate", () => {
        // Weston, Florida: a real UT tennis fixture on UT's own calendar.
        expect(onCampus(makeEvent({ latitude: 26.1003, longitude: -80.3997 }))).toBe(false);
    });

    it("calls another state off campus from the location text alone", () => {
        expect(
            onCampus(
                makeEvent({ locationName: "Lincoln, Neb., Sid and Hazel Dillon Tennis Center" }),
            ),
        ).toBe(false);
        expect(
            onCampus(makeEvent({ locationName: "Pensacola, Fla., Ashton Brosnaham Complex" })),
        ).toBe(false);
    });

    it("does not mistake a Texas location for an away game", () => {
        expect(onCampus(makeEvent({ locationName: "Austin, Tex., Gregory Gym" }))).not.toBe(false);
        expect(onCampus(makeEvent({ locationName: "GDC 2.216" }))).not.toBe(false);
    });

    it("says unknown rather than guessing when there is no location", () => {
        expect(onCampus(makeEvent())).toBeNull();
    });
});

describe("mentionsFreeFood", () => {
    const of = (title: string, description: string | null = null) =>
        makeEvent({ title, description });

    it("matches a promise of food", () => {
        expect(mentionsFreeFood(of("Panel", "Free pizza for attendees"))).toBe(true);
        expect(mentionsFreeFood(of("Panel", "Lunch will be provided."))).toBe(true);
        expect(mentionsFreeFood(of("Panel", "Refreshments served afterwards"))).toBe(true);
        expect(mentionsFreeFood(of("Panel", "Complimentary breakfast"))).toBe(true);
    });

    it("does not match a seminar that merely happens at lunchtime", () => {
        // Every midday talk mentions lunch; that is not a free lunch.
        expect(mentionsFreeFood(of("Lunch seminar", "Join us over lunch to discuss."))).toBe(false);
        expect(mentionsFreeFood(of("Brown bag lunch", "Bring your own lunch."))).toBe(false);
        expect(mentionsFreeFood(of("Dinner etiquette workshop", null))).toBe(false);
    });
});

describe("collapseSeries", () => {
    const day = (n: number) =>
        makeEvent({ id: 7, instanceId: 700 + n, start: `2026-11-${10 + n}T10:00:00-06:00` });

    it("returns one row per event, not one per day it runs", () => {
        const collapsed = collapseSeries([day(0), day(1), day(2)]);
        expect(collapsed).toHaveLength(1);
        expect(collapsed[0]?.occurrences).toBe(3);
    });

    it("keeps the earliest occurrence and reports the last", () => {
        const collapsed = collapseSeries([day(0), day(1), day(2)]);
        expect(collapsed[0]?.event.start).toBe("2026-11-10T10:00:00-06:00");
        expect(collapsed[0]?.lastStart).toBe("2026-11-12T10:00:00-06:00");
    });

    it("leaves distinct events alone and reports no run", () => {
        const collapsed = collapseSeries([makeEvent({ id: 1 }), makeEvent({ id: 2 })]);
        expect(collapsed).toHaveLength(2);
        expect(collapsed.map((c) => c.occurrences)).toEqual([1, 1]);
        expect(collapsed.map((c) => c.lastStart)).toEqual([null, null]);
    });
});

describe("cancelled events", () => {
    it("is read off the feed's status field", () => {
        const [live] = normalizeEvent({
            event: {
                id: 1,
                title: "On",
                status: "live",
                event_instances: [
                    { event_instance: { id: 1, start: "2026-11-09T12:00:00-06:00" } },
                ],
            },
        });
        const [off] = normalizeEvent({
            event: {
                id: 2,
                title: "Off",
                status: "canceled",
                event_instances: [
                    { event_instance: { id: 2, start: "2026-11-09T12:00:00-06:00" } },
                ],
            },
        });
        expect(live?.canceled).toBe(false);
        expect(off?.canceled).toBe(true);
    });

    it("treats a missing status as live rather than cancelled", () => {
        const [row] = normalizeEvent({
            event: {
                id: 3,
                title: "No status",
                event_instances: [
                    { event_instance: { id: 3, start: "2026-11-09T12:00:00-06:00" } },
                ],
            },
        });
        expect(row?.canceled).toBe(false);
    });

    it("is excluded from results by default and included on request", () => {
        const window = {
            from: new Date("2026-11-09T06:00:00Z"),
            to: new Date("2026-11-10T06:00:00Z"),
        };
        const off = makeEvent({ canceled: true, start: "2026-11-09T12:00:00-06:00" });
        expect(filterEvents([off], window)).toHaveLength(0);
        expect(filterEvents([off], { ...window, includeCanceled: true })).toHaveLength(1);
    });
});

describe("find_events", () => {
    /** Asserts over every row AND that there was a row, so a fail-closed bug cannot pass. */
    const expectAll = <T>(rows: T[], check: (row: T) => void) => {
        expect(rows.length).toBeGreaterThan(0);
        for (const row of rows) check(row);
    };

    it("reads every page, because page.total counts pages not events", async () => {
        const { data } = await events({ when: "this week", limit: 40 });
        const calls = log.filter((entry) => entry.url.includes("calendar.utexas.edu"));
        expect(calls).toHaveLength(2);
        expect(data.matched).toBeGreaterThan(10);
    });

    it("asks UT for only as many days as the window needs", async () => {
        await events({ when: "today" });
        const first = log.find((entry) => entry.url.includes("calendar.utexas.edu"))!;
        const days = Number(new URL(first.url).searchParams.get("days"));
        // A regression that always asked for one day, or always for 60, would
        // otherwise ship green: the fixture answers regardless of this value.
        expect(days).toBeLessThanOrEqual(2);

        resetCache();
        log.length = 0;
        await events({ when: "this week" });
        const wide = log.find((entry) => entry.url.includes("calendar.utexas.edu"))!;
        expect(Number(new URL(wide.url).searchParams.get("days"))).toBeGreaterThan(6);
    });

    it("sends pp, not per_page, so one page is 100 events", async () => {
        await events({ when: "today" });
        const url = new URL(log.find((e) => e.url.includes("calendar.utexas.edu"))!.url);
        expect(url.searchParams.get("pp")).toBe("100");
        expect(url.searchParams.get("per_page")).toBeNull();
    });

    it("collapses a multi-day run into one row with a day count", async () => {
        // The fixture holds real repeated rows: Localist emits a multi-day
        // event once per day, which inflated both the count and the row list.
        const raw = await getCalendar(30);
        // Pick an id the feed really does repeat, rather than assuming titles
        // are unique: two distinct UT Energy Symposium events share a title.
        const counts = new Map<number, number>();
        for (const event of raw.events) counts.set(event.id, (counts.get(event.id) ?? 0) + 1);
        const repeatedId = [...counts].find(([, n]) => n > 1)?.[0];
        expect(repeatedId).toBeDefined();
        const repeatedTitle = raw.events.find((event) => event.id === repeatedId)!.title;

        const { data, content } = await events({ when: "this week", limit: 40 });
        const appearances = data.events.filter((event) => event.title === repeatedTitle);
        expect(appearances).toHaveLength(1);
        expect(appearances[0]?.occurrences).toBeGreaterThan(1);
        expect(content[0]?.text).toContain("runs on");
        // The run line is its own line; it used to run into the category line.
        const runLine = content[0]!.text.split("\n").find((line) => line.includes("runs on"));
        expect(runLine).toBeDefined();
        expect(runLine).not.toMatch(/Arts & Humanities|uncategorised/);
    });

    it("counts events, not rows", async () => {
        const raw = await getCalendar(30);
        const rowCount = raw.events.length;
        const distinct = new Set(raw.events.map((event) => event.id)).size;
        // Guard the premise: if the fixture ever loses its repeats this test
        // should be fixed, not quietly pass.
        expect(distinct).toBeLessThan(rowCount);
        const { data } = await events({ when: "this week", limit: 40 });
        expect(data.matched).toBeLessThanOrEqual(distinct);
    });

    it("does not return a cancelled event as if it were happening", async () => {
        const raw = await getCalendar(30);
        const cancelled = raw.events.filter((event) => event.canceled);
        expect(cancelled.length).toBeGreaterThan(0);
        const { data } = await events({ when: "this week", limit: 40 });
        for (const title of cancelled.map((event) => event.title)) {
            expect(data.events.map((event) => event.title)).not.toContain(title);
        }
    });

    it("decodes HTML entities in the title it shows and the query it matches", async () => {
        const raw = await getCalendar(30);
        // The feed really does serve "E+E Film &amp; Media Committee Meeting".
        const withEntity = raw.events.filter((event) => /&(amp|quot|#\d+);/.test(event.title));
        expect(withEntity).toHaveLength(0);
        const ampersand = raw.events.find((event) => event.title.includes(" & "));
        expect(ampersand).toBeDefined();

        const { data } = await events({ when: "this week", query: "&", limit: 40 });
        expect(data.matched).toBeGreaterThan(0);
        expectAll(data.events, (event) => expect(event.title).not.toMatch(/&amp;|&quot;/));
    });

    it("lists what is on today, from now rather than from midnight", async () => {
        const { data, content } = await events({ limit: 40 });
        expect(content[0]?.text).toContain("today");
        expectAll(data.events, (event) =>
            expect(Date.parse(event.start)).toBeLessThan(Date.parse(data.window.to)),
        );
    });

    it("narrows to a single day for tomorrow", async () => {
        const { data } = await events({ when: "tomorrow", limit: 40 });
        expectAll(data.events, (event) => {
            const start = Date.parse(event.start);
            // Same rule the filter uses: an all-day event runs to the end of
            // its day, a timed one with no end is assumed to last an hour.
            const end = event.end
                ? Date.parse(event.end)
                : start + (event.allDay ? 86_400_000 : 3_600_000);
            expect(end).toBeGreaterThan(Date.parse(data.window.from));
            expect(start).toBeLessThan(Date.parse(data.window.to));
        });
    });

    it("backfills coordinates the feed is missing", async () => {
        const { data } = await events({ when: "this week", limit: 40 });
        expect(data.coverage.resolvedFromBuilding).toBeGreaterThan(0);
        expect(data.notes.join(" ")).toContain("resolved from the location text");
        const backfilled = data.events.filter((e) => e.coordinateSource === "building");
        expectAll(backfilled, (event) => {
            expect(event.buildingCode).not.toBeNull();
            expect(event.latitude).not.toBeNull();
        });
    });

    it("reports coverage that adds up to what matched", async () => {
        const { data } = await events({ when: "this week", limit: 40 });
        const { feedCoordinates, resolvedFromBuilding, noCoordinates } = data.coverage;
        expect(feedCoordinates + resolvedFromBuilding + noCoordinates).toBe(data.matched);
    });

    it("filters by category", async () => {
        const all = await events({ when: "this week", limit: 40 });
        const target = all.data.events.flatMap((event) => event.categories)[0];
        expect(target).toBeDefined();
        const { data } = await events({ when: "this week", categories: [target!], limit: 40 });
        expectAll(data.events, (event) => expect(event.categories).toContain(target));
        // The filter must actually remove something, or it proves nothing.
        expect(data.matched).toBeLessThan(all.data.matched);
    });

    it("tolerates a category with stray whitespace or odd case", async () => {
        // Validation trimmed and matching did not, so " Academics" validated
        // and then matched nothing: a real answer became "nothing on".
        const plain = await events({ when: "this week", categories: ["Academics"], limit: 40 });
        for (const variant of [" Academics", "academics", "ACADEMICS ", "  Academics  "]) {
            const got = await events({ when: "this week", categories: [variant], limit: 40 });
            expect(got.data.matched).toBe(plain.data.matched);
        }
    });

    it("errors on an unknown category instead of answering nothing", async () => {
        const bad = await events({ when: "this week", categories: ["Free Food"] });
        expect(bad.isError).toBe(true);
        expect(bad.content[0]?.text).toContain("Unknown categor");
        expect(bad.content[0]?.text).toContain("Academics");
    });

    it("filters by audience, and errors on one it does not know", async () => {
        const all = await events({ when: "this week", limit: 40 });
        const { data } = await events({
            when: "this week",
            audiences: ["Students"],
            limit: 40,
        });
        expectAll(data.events, (event) => expect(event.audiences).toContain("Students"));
        expect(data.matched).toBeLessThan(all.data.matched);

        const bad = await events({ when: "this week", audiences: ["Undergrads"] });
        expect(bad.isError).toBe(true);
        expect(bad.content[0]?.text).toContain("Unknown audience");
    });

    it("filters by venue type", async () => {
        const all = await events({ when: "this week", limit: 40 });
        const { data } = await events({ when: "this week", venue: "virtual", limit: 40 });
        expectAll(data.events, (event) => expect(event.venue).toBe("virtual"));
        expect(data.matched).toBeLessThan(all.data.matched);
    });

    it("filters by department", async () => {
        const all = await events({ when: "this week", limit: 40 });
        const target = all.data.events.flatMap((event) => event.departments)[0];
        expect(target).toBeDefined();
        const { data } = await events({ when: "this week", department: target!, limit: 40 });
        expectAll(data.events, (event) =>
            expect(event.departments.join(" ").toLowerCase()).toContain(target!.toLowerCase()),
        );
        expect(data.matched).toBeLessThan(all.data.matched);
    });

    it("filters by free admission", async () => {
        const all = await events({ when: "this week", limit: 40 });
        const { data } = await events({ when: "this week", freeAdmission: true, limit: 40 });
        expectAll(data.events, (event) => expect(event.freeAdmission).toBe(true));
        expect(data.matched).toBeLessThan(all.data.matched);
    });

    it("matches a query against the title, and excludes what does not match", async () => {
        const all = await events({ when: "this week", limit: 40 });
        const sample = all.data.events[0];
        expect(sample).toBeDefined();
        const word = sample!.title.split(/\s+/).find((w) => w.length > 5);
        expect(word).toBeDefined();
        const { data } = await events({ when: "this week", query: word!, limit: 40 });
        expect(data.matched).toBeGreaterThan(0);
        // The point the old version missed: a filter that returns everything
        // also satisfies "matched > 0".
        expect(data.matched).toBeLessThan(all.data.matched);
        const nonsense = await events({ when: "this week", query: "zzqqxx", limit: 40 });
        expect(nonsense.data.matched).toBe(0);
    });

    it("filters near a building, and the radius actually bounds it", async () => {
        const wide = await events({
            when: "this week",
            near: "the SAC",
            withinMetres: 5000,
            limit: 40,
        });
        const tight = await events({
            when: "this week",
            near: "the SAC",
            withinMetres: 150,
            limit: 40,
        });
        expect(wide.data.matched).toBeGreaterThan(tight.data.matched);
        expectAll(wide.data.events, (event) => {
            expect(event.latitude).not.toBeNull();
            expect(event.walkMinutes).not.toBeNull();
        });
        expect(wide.data.notes.join(" ")).toMatch(/excluded by the 5000 m radius/);
    });

    it("refuses a near it cannot resolve rather than ignoring it", async () => {
        const result = await call("find_events", { when: "this week", near: "Hogwarts" });
        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toContain("resolve_ut_location");
    });

    it("refuses a blank near instead of dropping the radius", async () => {
        // `near: "   "` used to skip the resolve-or-refuse guard entirely, so
        // the answer covered the whole campus while looking filtered.
        for (const blank of ["", "   "]) {
            const result = await call("find_events", { when: "this week", near: blank });
            expect(result.isError).toBe(true);
            expect(result.content[0]?.text).toContain("near was empty");
        }
    });

    it("refuses withinMetres with no near to measure from", async () => {
        const result = await call("find_events", { when: "this week", withinMetres: 50 });
        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toContain("only means something with near");
    });

    it("finds events that say food is provided, and admits it is a text match", async () => {
        const all = await events({ when: "this week", limit: 40 });
        const { data, content } = await events({ when: "this week", freeFood: true, limit: 40 });
        expectAll(data.events, (event) => expect(event.mentionsFreeFood).toBe(true));
        expect(data.matched).toBeLessThan(all.data.matched);
        expect(content[0]?.text).toContain("no free-food field");
    });

    it("does not confuse free admission with free food", async () => {
        const { data } = await events({ when: "this week", freeAdmission: true, limit: 40 });
        expectAll(data.events, (event) => expect(event.freeAdmission).toBe(true));
        expect(data.events.every((event) => event.mentionsFreeFood)).toBe(false);
    });

    it("marks an away game and can exclude it", async () => {
        const all = await events({ when: "this week", limit: 40 });
        const away = all.data.events.filter((event) => event.onCampus === false);
        expect(away.length).toBeGreaterThan(0);
        expect(all.content[0]?.text).toContain("NOT on campus");
        const here = await events({ when: "this week", onCampusOnly: true, limit: 40 });
        expectAll(here.data.events, (event) => expect(event.onCampus).not.toBe(false));
        expect(here.data.matched).toBeLessThan(all.data.matched);
    });

    it("excludes a road game written with a spelled-out state, not just an abbreviation", async () => {
        // Abbreviations caught the tennis fixtures; "San Diego, California"
        // and "Louisville, Kentucky" went through as campus events.
        const raw = await getCalendar(30);
        const spelled = raw.events.filter((event) =>
            /\b(California|Kentucky|Georgia)\b/.test(event.locationName ?? ""),
        );
        expect(spelled.length).toBeGreaterThan(0);
        const here = await events({ when: "this week", onCampusOnly: true, limit: 40 });
        for (const title of spelled.map((event) => event.title)) {
            expect(here.data.events.map((event) => event.title)).not.toContain(title);
        }
    });

    it("errors on an unreadable when instead of answering about today", async () => {
        const result = await call("find_events", { when: "whenever" });
        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toContain("Couldn't read");
        expect(result.content[0]?.text).toContain("tonight");
    });

    it("says it has not looked, rather than answering nothing, past its range", async () => {
        const far = await call("find_events", { when: "2027-05-01" });
        expect(far.isError).toBe(true);
        expect(far.content[0]?.text).toMatch(/days out and this tool reads/);

        const past = await call("find_events", { when: "2020-01-01" });
        expect(past.isError).toBe(true);
        expect(past.content[0]?.text).toContain("in the past");
    });

    it("rejects an unknown argument to find_events instead of ignoring it", async () => {
        const result = await call("find_events", { date: "tomorrow" });
        expect(result.isError).toBe(true);
    });

    it("caps rows and says how many it held back", async () => {
        const { data, content } = await events({ when: "this week", limit: 3 });
        expect(data.shown).toBe(3);
        expect(data.matched).toBeGreaterThan(3);
        expect(content[0]?.text).toContain(`Showing 3 of ${data.matched}`);
    });

    it("truncates a long description rather than returning an abstract", async () => {
        const { data } = await events({ when: "this week", limit: 40 });
        expectAll(data.events, (event) => {
            if (event.description) expect(event.description.length).toBeLessThanOrEqual(404);
        });
        expect(data.events.some((event) => event.description?.endsWith("..."))).toBe(true);
    });

    it("falls back to the HTML description when the plain one is empty", async () => {
        const raw = await getCalendar(30);
        const fallback = raw.events.find((event) => event.description?.includes("markup"));
        expect(fallback).toBeDefined();
        // Tags stripped, entities decoded.
        expect(fallback!.description).not.toContain("<b>");
        expect(fallback!.description).toContain("Film & Media");
        expect(fallback!.description).toContain("café");
    });

    it("renders the time in Austin time, not UTC", async () => {
        const { data } = await events({ when: "this week", limit: 40 });
        const evening = data.events.find((event) => {
            const hour = Number(
                new Intl.DateTimeFormat("en-US", {
                    timeZone: "America/Chicago",
                    hour: "numeric",
                    hour12: false,
                }).format(new Date(event.start)),
            );
            return !event.allDay && hour >= 18;
        });
        // An evening event is the discriminating case: rendered in UTC it
        // shows the next calendar day.
        expect(evening).toBeDefined();
        const austinDay = new Intl.DateTimeFormat("en-US", {
            timeZone: "America/Chicago",
            day: "numeric",
        }).format(new Date(evening!.start));
        expect(evening!.when).toContain(austinDay);
    });

    it("keeps an all-day event on its own day", async () => {
        const { data } = await events({ when: "today", limit: 40 });
        expect(
            data.events.filter((event) => event.when.endsWith("all day")).length,
        ).toBeGreaterThan(0);
    });

    it("serves a second identical call from cache", async () => {
        await events({ when: "this week" });
        const afterFirst = log.length;
        await events({ when: "this week" });
        expect(log).toHaveLength(afterFirst);
    });

    it("says UT's calendar is down rather than returning nothing silently", async () => {
        vi.unstubAllGlobals();
        resetCache();
        stubFetch({ "calendar.utexas.edu": 503 });
        const result = await call("find_events", { when: "today" });
        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toContain("calendar.utexas.edu");
    });

    it("says so when the feed is not JSON, instead of a parse error", async () => {
        vi.unstubAllGlobals();
        resetCache();
        stubFetch({ "calendar.utexas.edu": "<html>maintenance</html>" });
        const result = await call("find_events", { when: "today" });
        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toContain("not JSON");
    });

    it("explains malformed upstream data instead of leaking a TypeError", async () => {
        // Each of these used to surface a raw JS message to the client, e.g.
        // "object is not iterable" or "(list ?? []).map is not a function".
        const LEAKS = /is not iterable|is not a function|Cannot read properties/;

        // No event list at all means the feed is broken, and that is an error.
        for (const body of [
            '{"events":{},"page":{"total":1,"total_items":0}}',
            '{"page":{"total":1,"total_items":0}}',
            "null",
        ]) {
            vi.unstubAllGlobals();
            resetCache();
            stubFetch({ "calendar.utexas.edu": body });
            const result = await call("find_events", { when: "today" });
            expect(result.isError).toBe(true);
            const text = result.content[0]?.text ?? "";
            expect(text).not.toMatch(LEAKS);
            expect(text).toContain("UT's calendar");
        }

        // A bad row inside a good list is skipped, not fatal: one malformed
        // entry should not cost the user the other ninety-nine.
        for (const body of [
            '{"events":[null],"page":{"total":1,"total_items":1}}',
            '{"events":[{"event":{"id":1,"title":7,"departments":"Fine Arts",' +
                '"filters":{"event_types":{}},"event_instances":{"a":1}}}],' +
                '"page":{"total":1,"total_items":1}}',
        ]) {
            vi.unstubAllGlobals();
            resetCache();
            stubFetch({ "calendar.utexas.edu": body });
            const result = await call("find_events", { when: "today" });
            expect(result.content[0]?.text ?? "").not.toMatch(LEAKS);
        }
    });

    it("rejects a feed coordinate that is out of range", async () => {
        // A latitude and longitude swapped upstream gives latitude -97.73,
        // which is not a latitude, and used to be passed through as "feed".
        const [row] = normalizeEvent({
            event: {
                id: 99,
                title: "Swapped",
                geo: { latitude: "-97.73", longitude: "30.28" },
                event_instances: [
                    { event_instance: { id: 99, start: "2026-11-09T12:00:00-06:00" } },
                ],
            },
        });
        expect(row?.coordinateSource).not.toBe("feed");
        expect(row?.latitude).not.toBe(-97.73);
    });

    it("counts the pages it actually fetched", async () => {
        const result = await getCalendar(30);
        const calls = log.filter((entry) => entry.url.includes("calendar.utexas.edu"));
        expect(result.pagesFetched).toBe(calls.length);
    });
});

describe("boundaries the obvious tests miss", () => {
    it("trims inside filterEvents, not only at the tool boundary", () => {
        // filterEvents is exported, so a caller that has not trimmed must
        // still get the right answer. Trimming only in index.ts left this
        // untested, and either fix alone hid the other's absence.
        const window = {
            from: new Date("2026-11-09T06:00:00Z"),
            to: new Date("2026-11-10T06:00:00Z"),
        };
        const event = makeEvent({
            start: "2026-11-09T12:00:00-06:00",
            categories: ["Academics"],
            audiences: ["Students"],
            departments: ["School of Law"],
        });
        expect(filterEvents([event], { ...window, categories: [" Academics "] })).toHaveLength(1);
        expect(filterEvents([event], { ...window, audiences: ["  students"] })).toHaveLength(1);
        expect(filterEvents([event], { ...window, department: " school of law " })).toHaveLength(1);
    });

    it("prefers the room reference over the location name", () => {
        // Both resolve here, to different buildings. The old test used a
        // location name that resolved to nothing, so it could not detect the
        // ordering it existed to prove.
        const [row] = normalizeEvent({
            event: {
                id: 1,
                title: "Precedence",
                location_name: "Gates Dell Complex",
                room_number: "Ann Hartness Reading Room (SRH 1.106)",
                geo: { latitude: null, longitude: null },
                event_instances: [
                    { event_instance: { id: 1, start: "2026-11-09T12:00:00-06:00" } },
                ],
            },
        });
        // The room is the more specific claim.
        expect(row?.buildingCode).toBe("SRH");
    });

    it("survives event_instances arriving as an object", async () => {
        // The earlier malformed-data case had a numeric title, so it was
        // rejected before it ever reached the instance loop, and `?? []` on a
        // non-array went untested. An object is not iterable.
        vi.unstubAllGlobals();
        resetCache();
        stubFetch({
            "calendar.utexas.edu":
                '{"events":[{"event":{"id":1,"title":"Bad shape",' +
                '"event_instances":{"a":1},"tags":{"b":2}}}],' +
                '"page":{"total":1,"total_items":1}}',
        });
        const result = await call("find_events", { when: "today" });
        expect(result.content[0]?.text ?? "").not.toMatch(
            /is not iterable|is not a function|Cannot read properties/,
        );
    });

    it("reads Austin's offset from the zone, not a fixed -6", () => {
        // November is CST (UTC-6) and July is CDT (UTC-5). A hardcoded 360
        // passed every test because the fixture clock is in November.
        const july = new Date("2026-07-15T15:00:00Z");
        const summer = parseWindow("tomorrow", july)!;
        expect(summer.from.toISOString()).toBe("2026-07-16T05:00:00.000Z");

        const november = parseWindow("tomorrow", CAMPUS_NOW)!;
        expect(november.from.toISOString()).toBe("2026-11-10T06:00:00.000Z");
    });

    it("does not find a short building name inside a longer word", () => {
        // With the 9-character floor dropped, "UNION" and "MAIN" become name
        // keys and BY_NAME matches on substring, so "Reunion" resolves to the
        // Union Building and "Remaining" to the Main Building.
        expect(resolveBuilding("Class Reunion in the courtyard")).toBeNull();
        expect(resolveBuilding("Remaining seats for the lecture")).toBeNull();
    });

    it("degrades an unrecognised precision to the loosest, not the tightest", () => {
        // A bad value in the data file would otherwise be reported as an exact
        // marker, and the "approximate" warning would be decided by a string
        // nobody checked.
        expect(toPrecision("marker")).toBe("marker");
        expect(toPrecision("centroid")).toBe("centroid");
        expect(toPrecision("geocoded")).toBe("geocoded");
        expect(toPrecision("something-new")).toBe("geocoded");
        expect(toPrecision("")).toBe("geocoded");
    });
});

/**
 * Each case here returned a confident, plausible, wrong answer at some point.
 * They are the ones worth keeping an eye on when touching the matcher.
 */
describe("searching event text, and what counts as on campus", () => {
    const longDescription = (tail: string) =>
        `${"UT hosts a seminar series on campus each week. ".repeat(14)}${tail}`;

    const synthetic = (over: { title?: string; description?: string; locationName?: string }) =>
        normalizeEvent({
            event: {
                id: 77,
                title: over.title ?? "Seminar",
                description_text: over.description,
                location_name: over.locationName,
                event_instances: [
                    { event_instance: { id: 771, start: "2026-11-09T12:00:00-06:00" } },
                ],
            },
        })[0]!;

    describe("text features ran on the display truncation", () => {
        it("sees free food named past the 400-character display cut", () => {
            const row = synthetic({ description: longDescription("Lunch will be provided.") });
            // The description really is cut, so this is not accidentally
            // passing on a short string.
            expect(row.description!.length).toBeLessThanOrEqual(403);
            expect(row.description).not.toContain("Lunch will be provided");
            expect(row.searchText).toContain("lunch will be provided");
            // Measured against the live feed: 2 of 6 before this, because UT
            // puts "Lunch will be provided." at character 1,030 of 1,100.
            expect(mentionsFreeFood(row)).toBe(true);
        });

        it("still refuses a bare mention of a mealtime", () => {
            const row = synthetic({ description: longDescription("Come by after lunch.") });
            expect(mentionsFreeFood(row)).toBe(false);
        });

        it("finds a query term past the 400-character display cut", () => {
            const row = synthetic({
                description: longDescription("This group discusses mental health openly."),
            });
            expect(row.description).not.toContain("mental health");
            expect(filterEvents([row], { query: "mental health" })).toHaveLength(1);
        });
    });

    describe("query matched inside unrelated words", () => {
        const ai = makeEvent({ title: "AI Ideas: Drop-in Hours" });
        // These genuinely contain the letters "ai" inside a word: tr-ai-ning,
        // ch-ai-r, m-ai-ntenance. A title that merely looks unrelated is not a
        // test -- "Nation-Building" has no "ai" in it and passes either way.
        const notAi = makeEvent({ title: "Research Training Grant Workshop" });

        it("matches a short query at a word start", () => {
            expect(filterEvents([ai], { query: "AI" })).toHaveLength(1);
        });

        it("does not match a short query mid-word", () => {
            // A plain substring returned 48 of the week's 105 events as AI
            // events, on matches exactly like this one.
            expect(filterEvents([notAi], { query: "AI" })).toHaveLength(0);
            expect(
                filterEvents([makeEvent({ title: "Department Chair Lecture" })], { query: "AI" }),
            ).toHaveLength(0);
            expect(
                filterEvents([makeEvent({ description: "Facilities maintenance notice" })], {
                    query: "AI",
                }),
            ).toHaveLength(0);
        });

        it("treats a two- or three-letter query as a whole word", () => {
            // A word-start anchor alone still matched "aid", "aims" and "air",
            // which is most of a calendar. An acronym has to stand alone.
            for (const title of ["Financial Aid Night", "Air Quality Seminar", "Aims and Scope"]) {
                expect(filterEvents([makeEvent({ title })], { query: "AI" })).toHaveLength(0);
            }
            // Still found when it is its own word, including hyphenated.
            expect(filterEvents([ai], { query: "AI" })).toHaveLength(1);
            expect(
                filterEvents([makeEvent({ title: "AI-powered Tutoring" })], { query: "AI" }),
            ).toHaveLength(1);
        });

        it("still matches a prefix, so 'robotic' finds robotics", () => {
            const row = makeEvent({ title: "Robotics Open House" });
            expect(filterEvents([row], { query: "robotic" })).toHaveLength(1);
            expect(filterEvents([row], { query: "engineer" })).toHaveLength(0);
        });

        it("does not throw on a query that is also a regex", () => {
            const row = makeEvent({ title: "C++ for Beginners" });
            expect(filterEvents([row], { query: "c++" })).toHaveLength(1);
            expect(() => filterEvents([row], { query: "what's on? (today)" })).not.toThrow();
        });
    });

    describe("in-state road games", () => {
        const awayGame = makeEvent({
            locationName: "College Station, Texas, Kyle Field",
            title: "University of Texas Football at Texas A&M",
        });
        const homeGame = makeEvent({ locationName: "Austin, Texas, Moody Center" });

        it("calls a Texas city that is not Austin off campus", () => {
            // The state tests cannot see this one: every athletics row is
            // written "City, Texas, Venue" whichever side of the line it is on.
            expect(onCampus(awayGame)).toBe(false);
            expect(onCampus(makeEvent({ locationName: "Midland, Texas" }))).toBe(false);
        });

        it("does not call an Austin venue off campus", () => {
            expect(onCampus(homeGame)).not.toBe(false);
        });

        it("drops an in-state road game from onCampusOnly", () => {
            expect(filterEvents([awayGame], { onCampusOnly: true })).toHaveLength(0);
            expect(filterEvents([homeGame], { onCampusOnly: true })).toHaveLength(1);
        });

        it("does not read a street address as an away city", () => {
            // An address legitimately contains "Austin, Texas" after a street,
            // and a building-resolved row must not be thrown away.
            expect(onCampus(makeEvent({ address: "2501 Speedway, Austin, Texas 78712" }))).not.toBe(
                false,
            );
        });
    });
});

describe("the edges of a day, and venues UT has renamed", () => {
    // The clock is 2026-11-09 09:00 Austin, so "yesterday" is the 8th.
    it("refuses yesterday, not just the day before", async () => {
        // The guard allowed a full day of grace, which meant yesterday was
        // accepted at EVERY hour: the window closes at today 00:00 and only
        // falls behind `now - 24h` once tomorrow starts. A student asking what
        // was on yesterday got 46 finished events presented as upcoming.
        const result = await call("find_events", { when: "2026-11-08" });
        expect(result.isError).toBe(true);
        expect(result.content[0]!.text).toMatch(/in the past/);
    });

    it("still answers for today and tomorrow", async () => {
        expect((await call("find_events", { when: "today" })).isError).toBeFalsy();
        expect((await call("find_events", { when: "tomorrow" })).isError).toBeFalsy();
    });

    it("excludes an all-day event belonging to the day after the window", async () => {
        // An all-day event on the 10th starts at the instant the 10th begins,
        // which is exactly the upper bound of a window for the 9th. With an
        // inclusive bound, a one-day query reported the next day's events and
        // `occurrences` counted a day outside the window.
        const monday = {
            from: new Date("2026-11-09T06:00:00Z"),
            to: new Date("2026-11-10T06:00:00Z"),
        };
        const tuesdayAllDay = makeEvent({
            start: "2026-11-10T00:00:00-06:00",
            end: "2026-11-11T00:00:00-06:00",
            allDay: true,
        });
        expect(filterEvents([tuesdayAllDay], monday)).toHaveLength(0);

        const mondayAllDay = makeEvent({
            start: "2026-11-09T00:00:00-06:00",
            end: "2026-11-10T00:00:00-06:00",
            allDay: true,
        });
        expect(filterEvents([mondayAllDay], monday)).toHaveLength(1);
    });

    it("counts the window, not the whole fetch, when nothing matched", async () => {
        const { data, content } = await events({
            when: "today",
            query: "zzzznotathing",
        });
        expect(data.events).toHaveLength(0);
        const stated = Number(/held (\d+) event/.exec(content[0]!.text)![1]);
        // The old number was the uncollapsed multi-day fetch, which said 130
        // for a day holding 45. It must not exceed the day's own total.
        const today = await events({ when: "today", limit: 40 });
        expect(stated).toBe(today.data.matched);
    });

    describe("renamed buildings students still write", () => {
        it("resolves CLA to Patton Hall", async () => {
            const { data } = await location({ location: "CLA 1.106" });
            expect(data.resolved).toBe(true);
            expect(data.building?.code).toBe("RLP");
            expect(data.building?.name).toBe("PATTON HALL");
        });

        it("resolves BMC to the Dealey Center", async () => {
            const { data } = await location({ location: "BMC 2.106" });
            expect(data.resolved).toBe(true);
            expect(data.building?.code).toBe("DMC");
        });
    });

    describe("the surname plus room-number rule", () => {
        // Each of these came back resolved with full coordinates and no hedge.
        it.each([
            ["North 1st Street", "a real Austin street, not the North End Zone"],
            ["Education 2.302", "UT's College of Education is SZB, not EER"],
            ["Austin 2026 Climate Summit", "an event title, not Lake Austin Centre"],
            ["Campus 2 West", "not the East Campus Garage"],
        ])("does not invent a building for %j", async (input) => {
            const { data } = await location({ location: input });
            expect(data.resolved).toBe(false);
        });

        it("does not read a year as a room number", async () => {
            // GEARING is a legitimate surname token, so the word list does not
            // block this one: only the room-number shape does. "2026" is four
            // digits, which a bare length test accepts.
            const { data } = await location({ location: "Gearing 2026 Symposium" });
            expect(data.resolved).toBe(false);
        });

        it("still resolves a real room reference", async () => {
            expect((await location({ location: "Gearing 114" })).data.building?.code).toBe("GEA");
            expect((await location({ location: "Welch 2.224" })).data.building?.code).toBe("WEL");
            expect((await location({ location: "Bellmont 962" })).data.building?.code).toBe("BEL");
        });
    });
});

describe("short queries, punctuation, and which name wins", () => {
    describe("a short query and its own plural", () => {
        const arts = makeEvent({ title: "Arts and Entertainment Showcase" });
        const art = makeEvent({ title: "Art History Lecture" });

        it("lets a three-letter query reach its plural", () => {
            // REGRESSION: holding short needles to a whole word meant "art"
            // could not see "Arts" and lost 13 of 20 arts events.
            expect(filterEvents([arts], { query: "art" })).toHaveLength(1);
            expect(filterEvents([art], { query: "art" })).toHaveLength(1);
            expect(
                filterEvents([makeEvent({ title: "Classes" })], { query: "class" }),
            ).toHaveLength(1);
        });

        it("reaches a longer word only when asked, and says nothing matched strictly", async () => {
            const bio = makeEvent({ title: "Biology Colloquium" });
            expect(filterEvents([bio], { query: "bio" })).toHaveLength(0);
            expect(filterEvents([bio], { query: "bio", looseQuery: true })).toHaveLength(1);
        });
    });

    describe("punctuation in a query", () => {
        it("matches across a hyphen either way round", () => {
            const hyphen = makeEvent({ title: "Pre-Med Advising Drop-in" });
            const solid = makeEvent({ title: "Premed Society Meeting" });
            for (const query of ["pre-med", "premed", "pre med"]) {
                expect(filterEvents([hyphen, solid], { query })).toHaveLength(2);
            }
        });

        it("matches whichever apostrophe the client typed", () => {
            // UT's feed carries 114 events with a straight apostrophe and one
            // with a curly one. An LLM that emits the typographic form used to
            // get nothing at all.
            const straight = makeEvent({ title: "Women's Basketball vs Vanderbilt" });
            const curly = makeEvent({ title: "Mao’s Cultural War" });
            expect(filterEvents([straight], { query: "women’s basketball" })).toHaveLength(1);
            expect(filterEvents([straight], { query: "women's basketball" })).toHaveLength(1);
            expect(filterEvents([curly], { query: "mao's cultural war" })).toHaveLength(1);
        });

        it("does not let a phrase straddle two fields", () => {
            // searchText joins fields with newlines for exactly this reason,
            // and the flexible separator must not cross one.
            const row = makeEvent({ title: "Robotics", departments: ["Showcase"] });
            expect(filterEvents([row], { query: "robotics showcase" })).toHaveLength(0);
        });

        it("still handles a query that is also a regex", () => {
            const row = makeEvent({ title: "C++ for Beginners" });
            expect(filterEvents([row], { query: "c++" })).toHaveLength(1);
            expect(() => filterEvents([row], { query: "what's on? (today)" })).not.toThrow();
        });
    });

    describe("dotted room numbers", () => {
        // REGRESSION: `normalize` strips periods, so "2.014" became "2014" and
        // the year guard threw it away along with every real floor-2 room
        // numbered 0xx and floor-1 room numbered 9xx.
        it.each([
            ["Gearing 2.014", "GEA"],
            ["Gearing 1.902", "GEA"],
            ["Gearing 1.126", "GEA"],
            ["Welch 2.224", "WEL"],
            ["Bellmont 962", "BEL"],
        ])("resolves %j", async (input, code) => {
            const { data } = await location({ location: input });
            expect(data.building?.code).toBe(code);
        });

        it("still refuses a bare year", async () => {
            expect((await location({ location: "Gearing 2026 Symposium" })).data.resolved).toBe(
                false,
            );
        });
    });

    describe("a named building beats a nickname", () => {
        it("does not let a college name shadow the building the string names", async () => {
            // REGRESSION: "COLLEGE OF LIBERAL ARTS" was added as a phrase alias
            // for RLP. It is the name of a college with departments in a dozen
            // buildings, and Localist puts it in an event's `departments`.
            const { data } = await location({
                location: "College of Liberal Arts, Burdine Hall 108",
            });
            expect(data.building?.code).toBe("BUR");
        });

        it("prefers a real code over a one-word alias elsewhere in the string", async () => {
            // TOWER is an alias token, and sat earlier than the code the string
            // actually gives.
            expect((await location({ location: "UT Tower, GDC 2.216" })).data.building?.code).toBe(
                "GDC",
            );
        });

        it("still resolves the nicknames that have no code to compete with", async () => {
            expect((await location({ location: "the SAC" })).data.building?.code).toBe("WCP");
            expect((await location({ location: "UT Tower" })).data.building?.code).toBe("MAI");
            expect((await location({ location: "CLA 1.106" })).data.building?.code).toBe("RLP");
        });
    });
});

describe("falling back to a looser query, and how far ahead it reads", () => {
    it("retries a short query loosely and says it did", async () => {
        // "bio" appears in the fixture only inside longer words (biography,
        // biomedical, bioscience). Strictly it matches nothing, and a bare
        // "nothing on UT's calendar" would be a wrong answer.
        const { data, content } = await events({ when: "this week", query: "bio", limit: 10 });
        expect(data.events.length).toBeGreaterThan(0);
        expect(data.notes.join(" ")).toMatch(
            /Nothing matched "bio" as a whole word, so these matched it as the start of a longer word/,
        );
        expect(content[0]!.text).toContain("NOTE:");
    });

    it("does not add the loose note when the strict pass found something", async () => {
        const { data } = await events({ when: "this week", query: "robotics", limit: 10 });
        expect(data.notes.join(" ")).not.toMatch(/as the start of a longer word/);
    });

    it("fetches far enough to cover the last day it advertises", async () => {
        // The fetch used to stop at MAX_WINDOW_DAYS days from now, which ends
        // partway through the last day the tool advertises, so that date was
        // accepted and then answered "nothing" while UT published events on it.
        // Clock is 2026-11-09 09:00 Austin, so the 60th day out is 2027-01-08.
        const edge = await call("find_events", { when: "2027-01-08" });
        expect(edge.isError).toBeFalsy();
        const days = log
            .filter((entry) => entry.url.includes("calendar.utexas.edu"))
            .map((entry) => Number(new URL(entry.url).searchParams.get("days")));
        // It has to ask for one day MORE than the window's own reach, or the
        // window's final hours are not in the response it filters.
        expect(Math.max(...days)).toBe(MAX_WINDOW_DAYS + 1);
    });

    it("still refuses a date past what it reads, and says how far that is", async () => {
        const past = await call("find_events", { when: "2027-02-20" });
        expect(past.isError).toBe(true);
        expect(past.content[0]!.text).toMatch(
            new RegExp(`days out and this tool reads the next ${MAX_WINDOW_DAYS} days`),
        );
    });
});

describe("a department filter that matches nothing", () => {
    it("says what the field holds instead of implying nothing is happening", async () => {
        // Asked for "Computer Science" this answered "Nothing on UT's calendar"
        // and the agent reported there are no CS events at UT that week. There
        // were 23, on the CS department's own calendar. The central feed has no
        // Computer Science department value at all.
        const { data, content } = await events({
            when: "this week",
            // Nursing is not one of the departmental calendars read here, and
            // the central feed carries no such value either.
            department: "School of Nursing Quilting Society",
            limit: 5,
        });
        expect(data.events).toHaveLength(0);

        const notes = data.notes.join(" ");
        expect(notes).toMatch(/No event in this window is tagged with a department matching/);
        // The count has to be collapsed events, not occurrence rows, or it
        // disagrees with the "window held N" line in the same answer.
        const stated = Number(/of (\d+) events here/.exec(notes)![1]);
        const held = Number(/held (\d+) event/.exec(content[0]!.text)![1]);
        expect(stated).toBe(held);
        // Names the departments that ARE present, so the agent can retry.
        expect(notes).toMatch(/the ones that do are:/);
        // And says what an empty answer does and does not mean.
        expect(notes).toMatch(/rather than 'not happening'/);
        expect(content[0]!.text).toContain("NOTE:");
    });

    it("does not add that note when the department did match", async () => {
        const withDept = await events({ when: "this week", limit: 40 });
        const known = withDept.data.events.flatMap((event) => event.departments ?? []);
        if (!known.length) return; // fixture carries no departments; nothing to assert
        resetCache();
        const { data } = await events({ when: "this week", department: known[0]!, limit: 5 });
        expect(data.events.length).toBeGreaterThan(0);
        expect(data.notes.join(" ")).not.toMatch(/is tagged with a department matching/);
    });
});

describe("the CS department calendar", () => {
    // The CS feed is forward-looking: the November feed starts on the 18th, so
    // these fixtures have their own era rather than the shared campus clock.
    const CS_NOW = new Date("2026-11-18T15:00:00Z");
    beforeEach(() => {
        vi.setSystemTime(CS_NOW);
    });

    it("parses the feed and joins the room from the monthly view", async () => {
        const { events, failed } = await getCsCalendar(CS_NOW, 8);
        expect(failed).toEqual([]);
        expect(events.length).toBeGreaterThan(0);

        const social = events.find((e) => e.title.includes("Longhorn Developers"));
        expect(social).toBeTruthy();
        // The feed carries no location. The room comes from the monthly HTML,
        // and the resolver turns it into coordinates.
        expect(social!.room).toMatch(/^GDC /);
        expect(social!.buildingCode).toBe("GDC");
        expect(social!.latitude).toBeTypeOf("number");
        expect(social!.coordinateSource).toBe("building");
        expect(social!.source).toBe(CS_SOURCE);
        expect(social!.departments).toEqual(["Computer Science"]);
    });

    it("reads times from the monthly view, which already carries an offset", () => {
        const rows = parseMonth(fixture("cs-events-month.html"));
        expect(rows.length).toBeGreaterThan(0);
        for (const row of rows) {
            expect(row.start).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:]+[+-]\d{2}:\d{2}$/);
            expect(row.title).toBeTruthy();
        }
        // An end time too, which the feed never carried.
        expect(rows.some((r) => r.end)).toBe(true);
    });

    it("does not read events from the feed, which ignores the month it is asked for", async () => {
        // /events/rss/<month> returns a byte-identical rolling 50 items for
        // 2026-10, 2026-12 and 2027-03 alike. Reading it per month made CS
        // invisible past its ~16-day horizon and double-counted a window that
        // spanned two months.
        resetCache();
        const log = stubFetch();
        await getCsCalendar(CS_NOW, 40);
        const rss = log.filter((e) => e.url.includes("/events/rss"));
        const months = log.filter((e) => e.url.includes("/events/month/"));
        // One feed request however many months are in the window.
        expect(rss).toHaveLength(1);
        expect(months.length).toBeGreaterThan(1);
        // And the month is a real path segment, not decoration.
        expect(new Set(months.map((e) => e.url)).size).toBe(months.length);
    });

    it("reads each month separately instead of the same items twice", async () => {
        // The old code fetched /events/rss/<month> per month and got identical
        // items back, so a two-month window double-counted everything and
        // collapseSeries called a single meeting a 2-day series.
        const { events } = await getCsCalendar(CS_NOW, 40);
        const november = events.filter((e) => e.start.startsWith("2026-11"));
        const december = events.filter((e) => e.start.startsWith("2026-12"));
        expect(november.length).toBeGreaterThan(0);
        expect(december.length).toBeGreaterThan(0);

        // No two rows share an instant AND an id: that is the duplicate shape.
        const seen = new Set(events.map((e) => `${e.id}@${e.start}`));
        expect(seen.size).toBe(events.length);

        // A genuinely recurring meeting still collapses to one row that says
        // how many times it runs, rather than filling the answer.
        const collapsed = collapseSeries([...events].sort(byStart));
        expect(collapsed.length).toBeLessThan(events.length);
    });

    it("keeps every occurrence of a weekly meeting, not just the first", () => {
        // parseMonth deduped by id at one point, which dropped a weekly
        // meeting from any window after its first occurrence in the month.
        const rows = parseMonth(fixture("cs-events-month.html"));
        const byId = new Map<string, number>();
        for (const r of rows) byId.set(r.id, (byId.get(r.id) ?? 0) + 1);
        expect(rows.length).toBeGreaterThanOrEqual(byId.size);
        // And each occurrence has its own start.
        const starts = new Set(rows.map((r) => `${r.id}@${r.start}`));
        expect(starts.size).toBe(rows.length);
    });

    it("counts the months a window touches in Austin's calendar, not UTC's", () => {
        // After 6pm Central on the last day of a month, UTC is already into the
        // next one, so the current month would never be asked for.
        const lateOnTheLast = new Date("2026-11-30T23:30:00Z"); // 17:30 Austin
        expect(monthsSpanned(lateOnTheLast, 1)[0]).toBe("2026-11");
        const spans = monthsSpanned(new Date("2026-11-18T15:00:00Z"), 40);
        expect(spans).toContain("2026-11");
        expect(spans).toContain("2026-12");
    });

    it("joins the feed's descriptions onto the month's events", () => {
        const descriptions = parseFeedDescriptions(fixture("cs-events-rss.xml"));
        expect(descriptions.size).toBeGreaterThan(0);
        for (const text of descriptions.values()) expect(text).not.toMatch(/<[a-z]/i);
    });

    it("does not return the organiser's name", async () => {
        // The feed's dc:creator names a student. Same decision as HornsLink's
        // officer record: not read at all.
        const { events } = await getCsCalendar(CS_NOW, 8);
        expect(JSON.stringify(events)).not.toMatch(/dc:creator|Nikki/);
    });

    it("takes the room from whichever field carries it", () => {
        // The view renders a room field and a location field and leaves one
        // empty. Preferring whichever MATCHED found 12 of 102 rooms; checking
        // the values finds 101.
        const html = fixture("cs-events-month.html");
        const rooms = parseRooms(html);
        // A floor, not just "more than zero": reading only `location-1` found
        // 12 of 102 rooms and still satisfied `> 0`.
        const blocks = new Set(html.match(/calendar\.(\d+)\.field_date/g) ?? []).size;
        expect(blocks).toBeGreaterThan(0);
        expect(rooms.size).toBeGreaterThan(blocks * 0.6);
        for (const room of rooms.values()) expect(room).not.toMatch(/^Room:/i);
    });

    it("surfaces CS events through find_events", async () => {
        const { data } = await events({ when: "this week", limit: 40 });
        expect(data.events.some((e) => e.source === "apps.cs.utexas.edu")).toBe(true);
    });

    it("answers a Computer Science department search", async () => {
        // The question that started this: the central calendar has no Computer
        // Science department value at all, so this used to answer "nothing".
        const { data } = await events({
            when: "this week",
            department: "Computer Science",
            limit: 10,
        });
        expect(data.events.length).toBeGreaterThan(0);
        for (const e of data.events) expect(e.source).toBe("apps.cs.utexas.edu");
    });
});

describe("one calendar failing", () => {
    it("still answers from the central calendar, and says which source was lost", async () => {
        // Clock stays on the shared campus era, where the central fixture has
        // events and the CS fixture has none, so this isolates the failure.
        resetCache();
        vi.unstubAllGlobals();
        stubFetch();
        const stubbed = globalThis.fetch;
        vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
            const url =
                typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
            // Only the CS feed, so the note names it and not the others.
            if (url.includes("apps.cs.utexas.edu")) throw new Error("cs feed down");
            return stubbed(input as never, init);
        });

        const result = await call("find_events", { when: "this week", limit: 5 });
        expect(result.isError).toBeFalsy();
        const data = result.structuredContent as EventsStructured;
        expect(data.events.length).toBeGreaterThan(0);
        expect(data.notes.join(" ")).toMatch(/apps\.cs\.utexas\.edu did not answer/);
    });
});

describe("departmental calendars in three formats", () => {
    describe("law, an ICS feed", () => {
        const parsed = () => parseIcs(fixture("law-events.ics"), "law.utexas.edu", "School of Law");

        it("reads events with their rooms", () => {
            const events = parsed();
            expect(events.length).toBeGreaterThan(0);
            for (const e of events) {
                expect(e.title).toBeTruthy();
                expect(e.source).toBe("law.utexas.edu");
                expect(e.departments).toEqual(["School of Law"]);
                expect(e.start).toMatch(/^\d{4}-\d{2}-\d{2}T/);
            }
            // The title of this test promised a room and never checked one, so
            // a broken LOCATION parse passed. A law room resolves to TNH.
            const located = events.filter((e) => e.room);
            expect(located.length).toBeGreaterThan(0);
            expect(located.some((e) => e.buildingCode === "TNH")).toBe(true);
        });

        it("drops the accessibility trailer every description carries", () => {
            // Every law description ends with the same boilerplate, so
            // query:"accommodation" returned 11 events, all law.
            const blob = parsed()
                .map((e) => e.description ?? "")
                .join(" ");
            expect(blob).not.toMatch(/request an accommodation/i);
        });

        it("unfolds a wrapped line before reading it", () => {
            // RFC 5545 wraps a long value by starting the next line with a
            // space, so a naive line parse reads half a LOCATION.
            // The inserted space IS the fold marker, so unfolding deletes the
            // newline and that space: "...was wr" + "\n apped" rejoins as
            // "was wrapped".
            const folded = "SUMMARY:A title that was wr\n apped\r\nLOCATION:TNH 2.1\n 23";
            const out = unfoldIcs(folded);
            expect(out).toContain("that was wrapped");
            expect(out).toContain("TNH 2.123");
        });

        it("resolves a Central wall-clock time, not whatever Date.parse decides", () => {
            // The feed writes DTSTART;TZID=US/Central:20261118T083000.
            expect(icsInstant("20261118T083000")).toBe("2026-11-18T08:30:00-06:00");
            // A trailing Z is already UTC and must not be shifted again.
            expect(icsInstant("20261118T143000Z")).toBe("2026-11-18T08:30:00-06:00");
            expect(icsInstant("nonsense")).toBeNull();
        });

        it("puts an all-day event at midnight in summer too", () => {
            // A hard-coded -06:00 was right in CST and an hour out in CDT, so
            // an April all-day event started at 01:00.
            expect(icsInstant("20261118")).toBe("2026-11-18T00:00:00-06:00");
            expect(icsInstant("20270415")).toBe("2027-04-15T00:00:00-05:00");
        });

        it("emits the same offset form as every other source", () => {
            // Mixing "...Z" and "...-06:00" sorted the merged list six hours
            // wrong and dropped Law rows at the limit.
            for (const e of parsed()) expect(e.start).toMatch(/[+-]\d{2}:\d{2}$/);
        });

        it("unescapes the commas and semicolons ICS escapes", () => {
            const events = parsed();
            const blob = events.map((e) => `${e.title} ${e.description ?? ""}`).join(" ");
            // A BACKSLASH before a comma or semicolon, not the punctuation
            // itself. The fixture legitimately contains plenty of both.
            expect(blob).not.toMatch(/\\[,;]/);
            // And the fixture really does exercise it.
            expect(fixture("law-events.ics")).toMatch(/\\[,;]/);
        });
    });

    describe("mccombs, LiveWhale JSON", () => {
        it("reads the data array, not the envelope", () => {
            // The payload is {meta, links, data}; reading the wrong key gave
            // zero events while the feed carried 150.
            const events = parseLiveWhale(JSON.parse(fixture("mccombs-events.json")));
            expect(events.length).toBeGreaterThan(0);
            for (const e of events) expect(e.source).toBe("calendar.mccombs.utexas.edu");
        });

        it("has no coordinates, because the endpoint serves no location", () => {
            const events = parseLiveWhale(JSON.parse(fixture("mccombs-events.json")));
            // Guarded: a loop over an empty array asserts nothing.
            expect(events.length).toBeGreaterThan(0);
            for (const e of events) {
                expect(e.room).toBeNull();
                expect(e.latitude).toBeNull();
            }
        });

        it("does not claim an event with no location is in person", () => {
            // is_online is null and online_url empty on every row, so the title
            // is the only evidence. Asserting "inperson" returned virtual
            // office hours to a student filtering for in-person events.
            const events = parseLiveWhale(JSON.parse(fixture("mccombs-events.json")));
            for (const e of events) {
                if (/virtual|online/i.test(e.title)) expect(e.venue).toBe("virtual");
                else if (/in[- ]?person/i.test(e.title)) expect(e.venue).toBe("inperson");
                else expect(e.venue).toBe("unknown");
            }
        });

        it("reads free admission from the cost field", () => {
            // 82 of 100 rows say "Free" and every one came back false.
            const events = parseLiveWhale(JSON.parse(fixture("mccombs-events.json")));
            expect(events.some((e) => e.freeAdmission)).toBe(true);
        });

        it("groups a recurring series so one meeting is not thirteen rows", () => {
            // LiveWhale numbers each occurrence, so collapseSeries could not
            // group them and one weekday series filled a third of an answer.
            const events = parseLiveWhale(JSON.parse(fixture("mccombs-events.json")));
            const repeated = events.filter((e) => e.title.includes("Talk MSTC"));
            if (repeated.length > 1) {
                expect(new Set(repeated.map((e) => e.seriesKey)).size).toBe(1);
                expect(new Set(repeated.map((e) => e.id)).size).toBe(repeated.length);
                expect(collapseSeries(repeated)).toHaveLength(1);
            }
        });

        it("returns nothing rather than throwing on an unexpected payload", () => {
            expect(parseLiveWhale({})).toEqual([]);
            expect(parseLiveWhale({ data: "not an array" })).toEqual([]);
            expect(parseLiveWhale(null)).toEqual([]);
        });
    });

    describe("cockrell, WordPress REST", () => {
        const parsed = () => parseWordPress(JSON.parse(fixture("cockrell-events.json")));

        it("builds a time from the date and the am/pm clock in post meta", () => {
            const events = parsed();
            expect(events.length).toBeGreaterThan(0);
            // `noon ?? events[0]` passed even when the am/pm parse was broken.
            // The fixture's events are all 12:00 pm Central.
            const noon = events.filter((e) => e.start.includes("T12:00:00-06:00"));
            expect(noon.length).toBeGreaterThan(0);
            for (const e of events) {
                expect(e.source).toBe("cockrell.utexas.edu");
                expect(e.start).toMatch(/[+-]\d{2}:\d{2}$/);
            }
        });

        it("reads FREE from the cost field", () => {
            // Every fixture event is cockrell_event_cost: "FREE".
            expect(parsed().every((e) => e.freeAdmission)).toBe(true);
        });

        it("flattens the markup in the location field before resolving it", () => {
            // The field carries '"HQ" Room, Floor 1<br>North Tower, EER Building'.
            const events = parsed();
            const located = events.filter((e) => e.room);
            expect(located.length).toBeGreaterThan(0);
            for (const e of located) expect(e.room).not.toMatch(/<[a-z]/i);
            // That string names EER, and the resolver should find it.
            expect(events.find((e) => e.buildingCode === "EER")).toBeTruthy();
        });

        it("returns nothing rather than throwing on an unexpected payload", () => {
            expect(parseWordPress({})).toEqual([]);
            expect(parseWordPress([{ id: 1 }])).toEqual([]);
        });
    });

    it("keeps going when one department is down", async () => {
        resetCache();
        vi.unstubAllGlobals();
        stubFetch();
        const stubbed = globalThis.fetch;
        vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
            const url =
                typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
            if (url.includes("law.utexas.edu")) throw new Error("law feed down");
            return stubbed(input as never, init);
        });
        const { events, failed } = await getDepartmentCalendars(CAMPUS_NOW, 8);
        expect(failed).toEqual(["law.utexas.edu"]);
        // The others still answered.
        expect(events.length).toBeGreaterThan(0);
        expect(new Set(events.map((e) => e.source)).has("law.utexas.edu")).toBe(false);
    });
});

describe("fixes from the five-source audit", () => {
    it("sorts the merged list by instant, not by string", () => {
        // Law and Cockrell wrote "...Z" where the others wrote "...-06:00", so
        // a string compare put an 8am law event between 2pm and 3pm, and made
        // law and Cockrell the first rows dropped at the limit.
        const zulu = makeEvent({ id: 1, instanceId: 1, start: "2026-12-02T14:00:00.000Z" });
        const central = makeEvent({ id: 2, instanceId: 2, start: "2026-12-02T09:00:00-06:00" });
        const sorted = [central, zulu].sort(byStart);
        // 14:00Z is 08:00 Central, so it comes first.
        expect(sorted[0]!.id).toBe(1);
    });

    it("does not merge two sources that happen to share an id", () => {
        // collapseSeries keyed on the id alone, so the second event vanished
        // and the first was relabelled as a 2-day series.
        const a = makeEvent({ id: 500, instanceId: 500, title: "Central thing" });
        const b = {
            ...makeEvent({ id: 500, instanceId: 500, title: "Law thing" }),
            source: "law.utexas.edu" as const,
        };
        expect(collapseSeries([a, b])).toHaveLength(2);
    });

    it("resolves the shorthand a student would type for a department", async () => {
        // "computer science".includes("cs") is false, so department:"CS"
        // answered "Nothing on UT's calendar" with CS events in hand.
        const cs = makeEvent({ departments: ["Computer Science"] });
        expect(filterEvents([cs], { department: "CS" })).toHaveLength(1);
        expect(filterEvents([cs], { department: "cs" })).toHaveLength(1);
        const law = makeEvent({ departments: ["School of Law"] });
        expect(filterEvents([law], { department: "law" })).toHaveLength(1);
        const mccombs = makeEvent({ departments: ["McCombs School of Business"] });
        expect(filterEvents([mccombs], { department: "business" })).toHaveLength(1);
        // And an unrelated term still matches nothing.
        expect(filterEvents([cs], { department: "nursing" })).toHaveLength(0);
    });

    it("shares one cache entry between windows that round to the same size", async () => {
        resetCache();
        const log = stubFetch();
        await events({ when: "today", limit: 2 });
        const afterFirst = log.filter((e) => e.url.includes("calendar.utexas.edu")).length;
        expect(afterFirst).toBeGreaterThan(0);
        // "tonight" needs the same two days, so it must not refetch.
        await events({ when: "tonight", limit: 2 });
        const afterSecond = log.filter((e) => e.url.includes("calendar.utexas.edu")).length;
        expect(afterSecond).toBe(afterFirst);
    });

    it("asks upstream for the whole bucket it caches under", async () => {
        // Keying on the bucket while fetching the exact window would let a
        // 21-day request fill the 31-day entry with 21 days of data.
        resetCache();
        const log = stubFetch();
        await events({ when: "this week", limit: 2 });
        const days = log
            .filter((e) => e.url.includes("calendar.utexas.edu"))
            .map((e) => Number(new URL(e.url).searchParams.get("days")));
        expect(new Set(days).size).toBe(1);
        // 8 is a bucket; a window of 8 days must not ask for 9 or 7.
        expect(days[0]).toBe(8);
    });

    it("pages McCombs rather than stopping at the first hundred", async () => {
        // per_page=100 read 100 of the 150 the payload's own meta declares.
        resetCache();
        const log = stubFetch();
        await getDepartmentCalendars(CAMPUS_NOW, 8);
        const calls = log.filter((e) => e.url.includes("mccombs.utexas.edu"));
        expect(calls.length).toBeGreaterThan(0);
        for (const c of calls) expect(c.url).toContain("page=");
    });
});
