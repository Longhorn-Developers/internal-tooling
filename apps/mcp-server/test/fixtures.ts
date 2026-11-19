import type { McpServer } from "@modelcontextprotocol/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { vi } from "vite-plus/test";

const DIR = join(import.meta.dirname, "fixtures");

export const fixture = (name: string): string => readFileSync(join(DIR, name), "utf8");

/**
 * Real responses captured from UT on 2026-10-14/15, and from UT course docs and
 * Rate My Professors on 2026-11-01. Matched longest-pattern first so a specific
 * URL wins over a prefix. GraphQL posts share one URL, so they match on the body.
 */
const ROUTES: [string, string][] = [
    ["course_number=439", "coursedocs-cs439-fall2025.html"],
    ["instructor_last=Gheith", "coursedocs-gheith-fall2025.html"],
    ["coursedocs/courses/nlogon/", "coursedocs-no-search.html"],
    ["q=Ahmed+Gheith", "rmp-search-gheith.html"],
    ["q=Alison", "rmp-search-norman.html"],
    ["q=E+Elnozahy", "rmp-search-elnozahy.html"],
    ["q=Zzyzx", "rmp-search-none.html"],
    ["VGVhY2hlci0xNzMwMjIw", "rmp-reviews-gheith.json"],
    ["VGVhY2hlci0xOTAyMzg4", "rmp-reviews-norman.json"],
    ["VGVhY2hlci0yOTk3MzQx", "rmp-reviews-elnozahy.json"],
    ["data_all_endpoint.php?menu=1", "foodpro-menu.json"],
    ["data_all_endpoint.php?hours=1", "foodpro-hours.txt"],
    // UT's Localist calendar, captured 2026-11-09. Two pages so pagination is
    // exercised: `page.total` there is a count of PAGES, not of events, and
    // reading it as events stops the loop after one page. Matched on `pp`
    // because the number of days requested varies with the window asked for.
    // Departmental calendars, captured 2026-11-18 and trimmed. Three different
    // formats because UT has no universal one: an ICS feed, LiveWhale JSON and
    // a WordPress REST collection.
    ["law.utexas.edu/calendar/feed/ics", "law-events.ics"],
    ["mccombs.utexas.edu/live/json/events", "mccombs-events.json"],
    ["cockrell.utexas.edu/wp-json/wp/v2/event", "cockrell-events.json"],
    // The CS department's own calendar, captured 2026-11-18 and trimmed to six
    // events. Two routes because the feed carries the event and the monthly
    // view carries the room, joined on the event id.
    ["calendar/events/rss", "cs-events-rss.xml"],
    // Two months, so a test can prove the month path segment is honoured. The
    // feed is NOT per month: /events/rss/<month> returns the same rolling items
    // whatever month is asked for, which is why events come from the view.
    ["calendar/events/month/2026-12", "cs-events-month-12.html"],
    ["calendar/events/month/", "cs-events-month.html"],
    ["pp=100&page=1", "localist-page1.json"],
    ["pp=100&page=2", "localist-page2.json"],
    // Labels are per item, so route by recipe reference. Without this every
    // item would come back with the same nutrition and the label path would
    // look correct while being untested.
    ["RecNumAndPort=081906", "foodpro-label-bacon.html"],
    ["RecNumAndPort=197042", "foodpro-label-margarine.html"],
    ["RecNumAndPort=140915", "foodpro-label-cheese-pizza.html"],
    ["label.aspx", "foodpro-label-450231.html"],
    ["housing.utexas.edu/dining/hours-of-operation", "housing-hours.html"],
    ["dining-locations/dining-halls", "housing-dining-halls.html"],
    ["dining-locations/restaurants/noodle-lab", "housing-noodle-lab.html"],
    ["dining-locations/restaurants", "housing-restaurants.html"],
    // HornsLink (Anthology Engage), captured 2026-11-14. The directory fixture is
    // a TRIMMED subset: 39 of the 1,226 real rows, chosen to cover every
    // category plus the legacy names that are not in the category endpoint.
    // `@odata.count` is left at the real 1226, which is what the tool reports
    // as the match total, so a test asserting on 39 would be asserting on the
    // trim rather than on behaviour.
    [
        "organization/bykey/ieeeroboticsandautomationsociety",
        "hornslink-detail-ieeeroboticsandautomationsociety.json",
    ],
    ["organization/bykey/unjaded", "hornslink-detail-unjaded.json"],
    // The only captured org with `showJoin: false`, so it is what makes the
    // `acceptingMembers` filter observable, and it shares a category with
    // several open orgs so a browse returns a mix.
    ["organization/bykey/blantonmuseum", "hornslink-detail-blantonmuseum.json"],
    // Any other org: the shape is the same whichever was asked about, and a
    // category browse reaches orgs no fixture is captured for.
    ["organization/bykey/", "hornslink-detail-unjaded.json"],
    ["query=robotics", "hornslink-search-robotics.json"],
    ["top=1300", "hornslink-directory.json"],
    // Every org's events route here: `organizationIds` honours only its first
    // value upstream, so the tool asks per org and the response shape is the
    // same whichever org it asked about.
    ["event/search", "hornslink-org-events.json"],
    // Least specific last: the app shell, which carries the location coordinates.
    ["hf-foodpro.austin.utexas.edu/foodpro/", "foodpro-app.html"],
];

export type FetchLog = { url: string; body?: string }[];

/**
 * Replace global fetch with a fixture server. Returns the call log, so tests can
 * assert on how many times upstream was actually hit (de-duplication, caching).
 */
export function stubFetch(overrides: Record<string, string | number> = {}): FetchLog {
    const log: FetchLog = [];
    vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        const body = typeof init?.body === "string" ? init.body : undefined;
        log.push({ url, body });
        const request = body ? `${url} ${body}` : url;
        for (const [key, value] of Object.entries(overrides)) {
            if (request.includes(key)) {
                if (typeof value === "number") return new Response("", { status: value });
                return new Response(value, { status: 200 });
            }
        }
        const hit = ROUTES.find(([pattern]) => request.includes(pattern));
        if (!hit) throw new Error(`No fixture for ${url}`);
        return new Response(fixture(hit[1]), { status: 200 });
    });
    return log;
}

/** 2026-10-15 15:44 America/Chicago (CDT, UTC-5), a Thursday. */
export const FIXED_NOW = new Date("2026-10-15T20:44:00Z");

/**
 * 2026-11-09 09:00 America/Chicago, a Monday, and CST (UTC-6) because DST ended
 * on 1 November. The campus-calendar fixture runs 9 to 17 November, so the
 * dining fixture's October clock would put every event in the past.
 */
export const CAMPUS_NOW = new Date("2026-11-09T15:00:00Z");

type ToolResult = {
    structuredContent?: unknown;
    content?: { type: string; text: string }[];
    isError?: boolean;
};

type Tool = {
    config: { inputSchema: { parse: (value: unknown) => unknown } };
    handler: (args: unknown, extra: unknown) => Promise<ToolResult>;
};

/**
 * Registers into a recorder and calls tools through their input schema, as the
 * server does, handing back the WHOLE result.
 *
 * An agent may read either half of a tool's answer, so a test that claims
 * something about the prose has to assert on the prose. `toolCaller` below is
 * the structured-only shorthand, which most tests want.
 */
export function toolResultCaller(register: (server: McpServer) => void) {
    const tools = new Map<string, Tool>();
    register({
        registerTool: (name: string, config: Tool["config"], handler: Tool["handler"]) =>
            tools.set(name, { config, handler }),
    } as unknown as McpServer);
    return async (name: string, args: Record<string, unknown> = {}): Promise<ToolResult> => {
        const tool = tools.get(name);
        if (!tool) throw new Error(`No such tool: ${name}`);
        return await tool.handler(tool.config.inputSchema.parse(args), {});
    };
}

/** The structured half of a tool's answer, which is what most tests assert on. */
export function toolCaller(register: (server: McpServer) => void) {
    const raw = toolResultCaller(register);
    return async <T>(name: string, args: Record<string, unknown> = {}): Promise<T> =>
        (await raw(name, args)).structuredContent as T;
}

/** The prose half, for tests about what the agent actually reads as text. */
export function toolTextCaller(register: (server: McpServer) => void) {
    const raw = toolResultCaller(register);
    return async (name: string, args: Record<string, unknown> = {}): Promise<string> =>
        ((await raw(name, args)).content ?? []).map((part) => part.text).join("\n");
}
