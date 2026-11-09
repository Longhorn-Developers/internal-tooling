import type { McpServer } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { resetCache } from "../src/shared";
import {
    ALL_BUILDINGS,
    isNonPhysicalLocation,
    metresBetween,
    resolveBuilding,
    walkMinutes,
} from "../src/tools/campus/buildings";
import {
    filterEvents,
    getCalendar,
    mentionsFreeFood,
    normalizeEvent,
    onCampus,
    type CampusEvent,
} from "../src/tools/campus/extract";
import { parseWindow, registerCampusTools } from "../src/tools/campus";
import { CAMPUS_NOW, stubFetch, type FetchLog } from "./fixtures";

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
    const result = await call("find_campus_events", args);
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

    it("measures a plausible distance and walking time across campus", () => {
        const gdc = resolveBuilding("GDC")!.building;
        const pcl = resolveBuilding("PCL")!.building;
        const metres = metresBetween(gdc, pcl);
        // GDC to PCL is a real walk but it is not a mile.
        expect(metres).toBeGreaterThan(200);
        expect(metres).toBeLessThan(1500);
        expect(walkMinutes(metres)).toBeGreaterThanOrEqual(2);
        expect(walkMinutes(metres)).toBeLessThan(25);
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
        expect(hit?.building.code).not.toBe("EER");
    });

    it("resolves a surname and room number with no building type", () => {
        const hit = resolveBuilding("Gearing 114");
        expect(hit?.matchedBy).toBe("room-reference");
    });

    it("keeps the AT&T Conference Center findable despite the ampersand", () => {
        expect(resolveBuilding("AT&T Conference Center")).not.toBeNull();
    });

    it("treats online and unscheduled locations as absent, not unrecognised", () => {
        for (const value of ["Online", "Zoom", "TBA", "TBD", "Virtual", ""]) {
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

    it("rejects an unknown argument instead of ignoring it", async () => {
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

/** A complete CampusEvent, so tests can override just the field under test. */
function makeEvent(over: Partial<CampusEvent> = {}): CampusEvent {
    return {
        id: 1,
        instanceId: 1,
        title: "T",
        description: null,
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
        freeAdmission: false,
        ticketCost: null,
        streamUrl: null,
        url: "https://calendar.utexas.edu/event/1",
        photoUrl: null,
        source: "calendar.utexas.edu",
        ...over,
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

describe("find_campus_events", () => {
    it("reads every page, because page.total counts pages not events", async () => {
        const { data } = await events({ when: "this week" });
        const calendarCalls = log.filter((entry) => entry.url.includes("calendar.utexas.edu"));
        expect(calendarCalls).toHaveLength(2);
        expect(data.matched).toBeGreaterThan(20);
    });

    it("lists what is on today, from now rather than from midnight", async () => {
        const { data, content } = await events();
        expect(data.shown).toBeGreaterThan(0);
        expect(content[0]?.text).toContain("today");
        for (const event of data.events) {
            expect(Date.parse(event.start)).toBeLessThan(Date.parse(data.window.to));
        }
    });

    it("narrows to a single day for tomorrow", async () => {
        const { data } = await events({ when: "tomorrow", limit: 40 });
        for (const event of data.events) {
            expect(event.start.slice(0, 10)).toBe("2026-11-10");
        }
    });

    it("keeps an event that has started but not finished", async () => {
        // The window compares against the end where there is one, so a talk
        // that began an hour ago is still on.
        const all = await getCalendar(30);
        const running = all.events.find(
            (event) =>
                Date.parse(event.start) < CAMPUS_NOW.getTime() &&
                event.end !== null &&
                Date.parse(event.end) > CAMPUS_NOW.getTime(),
        );
        if (!running) return; // fixture has none; nothing to assert
        const { data } = await events({ when: "today", limit: 40 });
        expect(data.events.some((event) => event.title === running.title)).toBe(true);
    });

    it("backfills coordinates the feed is missing", async () => {
        const { data } = await events({ when: "this week", limit: 40 });
        // The fixture deliberately holds events with no feed coordinates but a
        // readable room or location, which is about half of UT's real calendar.
        expect(data.coverage.resolvedFromBuilding).toBeGreaterThan(0);
        expect(data.notes.join(" ")).toContain("resolved from the location text");
    });

    it("reports coverage that adds up to what matched", async () => {
        const { data } = await events({ when: "this week", limit: 40 });
        const { feedCoordinates, resolvedFromBuilding, noCoordinates } = data.coverage;
        expect(feedCoordinates + resolvedFromBuilding + noCoordinates).toBe(data.matched);
    });

    it("filters by category and rejects one it does not know", async () => {
        const { data } = await events({
            when: "this week",
            categories: ["Academics"],
            limit: 40,
        });
        for (const event of data.events) expect(event.categories).toContain("Academics");

        const bad = await events({ when: "this week", categories: ["Free Food"] });
        expect(bad.data.matched).toBe(0);
        expect(bad.content[0]?.text).toContain("Unknown categor");
        // Naming the valid values is what stops a second wrong guess.
        expect(bad.content[0]?.text).toContain("Academics");
    });

    it("filters by audience and rejects one it does not know", async () => {
        const { data } = await events({ when: "this week", audiences: ["Students"], limit: 40 });
        for (const event of data.events) expect(event.audiences).toContain("Students");

        const bad = await events({ when: "this week", audiences: ["Undergrads"] });
        expect(bad.content[0]?.text).toContain("Unknown audience");
    });

    it("filters by venue type", async () => {
        const { data } = await events({ when: "this week", venue: "virtual", limit: 40 });
        for (const event of data.events) expect(event.venue).toBe("virtual");
    });

    it("filters near a building and says what the radius excluded", async () => {
        const { data } = await events({
            when: "this week",
            near: "the SAC",
            withinMetres: 600,
            limit: 40,
        });
        for (const event of data.events) {
            expect(event.latitude).not.toBeNull();
            expect(event.walkMinutes).not.toBeNull();
        }
        expect(data.notes.join(" ")).toMatch(/excluded by the 600 m radius/);
    });

    it("refuses a near it cannot resolve rather than ignoring it", async () => {
        // Dropping the filter here would answer about the whole campus while
        // looking like it answered about one building.
        const { data, content } = await events({ when: "this week", near: "Hogwarts" });
        expect(data.matched).toBe(0);
        expect(content[0]?.text).toContain("resolve_ut_location");
    });

    it("finds events that say food is provided, and admits it is a text match", async () => {
        const { data, content } = await events({ when: "this week", freeFood: true, limit: 40 });
        expect(data.matched).toBeGreaterThan(0);
        for (const event of data.events) expect(event.mentionsFreeFood).toBe(true);
        expect(content[0]?.text).toContain("no free-food field");
    });

    it("does not confuse free admission with free food", async () => {
        // Localist's `free` flag is about the ticket price. Conflating the two
        // would promise food at an event that only promised entry.
        const { data } = await events({ when: "this week", freeAdmission: true, limit: 40 });
        expect(data.matched).toBeGreaterThan(0);
        const promisesFood = data.events.every((event) => event.mentionsFreeFood);
        expect(promisesFood).toBe(false);
    });

    it("matches a query against title, description and department", async () => {
        const all = await events({ when: "this week", limit: 40 });
        const sample = all.data.events[0];
        if (!sample) return;
        const word = sample.title.split(/\s+/).find((w) => w.length > 5);
        if (!word) return;
        const { data } = await events({ when: "this week", query: word, limit: 40 });
        expect(data.matched).toBeGreaterThan(0);
    });

    it("explains an unreadable when instead of defaulting to today", async () => {
        const { data, content } = await events({ when: "whenever" });
        expect(data.matched).toBe(0);
        expect(content[0]?.text).toContain("Couldn't read");
        expect(content[0]?.text).toContain("tonight");
    });

    it("rejects an unknown argument instead of ignoring it", async () => {
        // `date` instead of `when` would otherwise answer about today while
        // appearing to honour the filter.
        const result = await call("find_campus_events", { date: "tomorrow" });
        expect(result.isError).toBe(true);
    });

    it("marks an away game and can exclude it", async () => {
        // UT publishes road games on its own calendar, so "what is on campus"
        // otherwise answers with a tennis match in Nebraska.
        const all = await events({ when: "this week", limit: 40 });
        const away = all.data.events.filter((event) => event.onCampus === false);
        if (away.length === 0) return; // fixture window has none
        expect(all.content[0]?.text).toContain("NOT on campus");
        const onlyHere = await events({ when: "this week", onCampusOnly: true, limit: 40 });
        expect(onlyHere.data.events.every((event) => event.onCampus !== false)).toBe(true);
        expect(onlyHere.data.matched).toBeLessThan(all.data.matched);
    });

    it("caps rows and says how many it held back", async () => {
        const { data, content } = await events({ when: "this week", limit: 3 });
        expect(data.shown).toBe(3);
        expect(data.matched).toBeGreaterThan(3);
        expect(content[0]?.text).toContain(`Showing 3 of ${data.matched}`);
    });

    it("truncates a long description rather than returning an abstract", async () => {
        const { data } = await events({ when: "this week", limit: 40 });
        for (const event of data.events) {
            if (event.description) expect(event.description.length).toBeLessThanOrEqual(404);
        }
        expect(data.events.some((event) => event.description?.endsWith("..."))).toBe(true);
    });

    it("renders a time a person can read, in Austin time", async () => {
        const { data } = await events({ when: "tomorrow", limit: 5 });
        const first = data.events[0];
        if (!first) return;
        expect(first.when).toMatch(/^[A-Z][a-z]{2}, [A-Z][a-z]{2} \d+/);
    });

    it("keeps an all-day event on its own day", async () => {
        // Localist writes an all-day event as midnight with no end time. Read
        // literally it is over before anyone is awake, which dropped every
        // all-day exhibition out of "today".
        const { data } = await events({ when: "today", limit: 40 });
        const allDay = data.events.filter((event) => event.when.endsWith("all day"));
        expect(allDay.length).toBeGreaterThan(0);
    });

    it("keeps a timed event with no end time on for an hour", async () => {
        const all = await getCalendar(30);
        const open = all.events.find((event) => event.end === null && !event.allDay);
        if (!open) return;
        const startMs = Date.parse(open.start);
        // Half an hour in, it should still be listed.
        vi.setSystemTime(new Date(startMs + 1_800_000));
        resetCache();
        const { data } = await events({ when: "today", limit: 40 });
        expect(data.events.some((event) => event.title === open.title)).toBe(true);
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
        const result = await call("find_campus_events", { when: "today" });
        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toContain("calendar.utexas.edu");
    });

    it("says so when the feed is not JSON, instead of throwing a parse error", async () => {
        vi.unstubAllGlobals();
        resetCache();
        stubFetch({ "calendar.utexas.edu": "<html>maintenance</html>" });
        const result = await call("find_campus_events", { when: "today" });
        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toContain("not JSON");
    });
});
