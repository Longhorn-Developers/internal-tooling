import type { McpServer } from "@modelcontextprotocol/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { vi } from "vite-plus/test";

const DIR = join(import.meta.dirname, "fixtures");

export const fixture = (name: string): string => readFileSync(join(DIR, name), "utf8");

/**
 * Real responses captured from UT on 2026-10-14/15, and from UT course docs and Rate My Professors
 * on 2026-11-01. Matched longest-pattern first so a specific URL wins over a prefix. GraphQL posts
 * share one URL, so they match on the body.
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
    ["law.utexas.edu/calendar/feed/ics", "law-events.ics"],
    ["mccombs.utexas.edu/live/json/events", "mccombs-events.json"],
    ["cockrell.utexas.edu/wp-json/wp/v2/event", "cockrell-events.json"],
    ["calendar/events/rss", "cs-events-rss.xml"],
    ["calendar/events/month/2026-12", "cs-events-month-12.html"],
    ["calendar/events/month/", "cs-events-month.html"],
    ["pp=100&page=1", "localist-page1.json"],
    ["pp=100&page=2", "localist-page2.json"],
    ["RecNumAndPort=081906", "foodpro-label-bacon.html"],
    ["RecNumAndPort=197042", "foodpro-label-margarine.html"],
    ["RecNumAndPort=140915", "foodpro-label-cheese-pizza.html"],
    ["label.aspx", "foodpro-label-450231.html"],
    ["housing.utexas.edu/dining/hours-of-operation", "housing-hours.html"],
    ["dining-locations/dining-halls", "housing-dining-halls.html"],
    ["dining-locations/restaurants/noodle-lab", "housing-noodle-lab.html"],
    ["dining-locations/restaurants", "housing-restaurants.html"],
    [
        "organization/bykey/ieeeroboticsandautomationsociety",
        "hornslink-detail-ieeeroboticsandautomationsociety.json",
    ],
    ["organization/bykey/unjaded", "hornslink-detail-unjaded.json"],
    ["organization/bykey/blantonmuseum", "hornslink-detail-blantonmuseum.json"],
    // Any other org: the shape is the same whichever was asked about, and a category browse reaches
    // orgs no fixture is captured for.
    ["organization/bykey/", "hornslink-detail-unjaded.json"],
    ["query=robotics", "hornslink-search-robotics.json"],
    ["top=1300", "hornslink-directory.json"],
    // Every org's events route here: `organizationIds` honours only its first value upstream, so
    // the tool asks per org and the response shape is the same whichever org it asked about.
    ["event/search", "hornslink-org-events.json"],
    // Least specific last: the app shell, which carries the location coordinates.
    ["hf-foodpro.austin.utexas.edu/foodpro/", "foodpro-app.html"],
];

export type FetchLog = { url: string; body?: string }[];

/**
 * Replace global fetch with a fixture server. Returns the call log, so tests can assert on how many
 * times upstream was actually hit (de-duplication, caching).
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
 * 2026-11-09 09:00 America/Chicago, a Monday, and CST (UTC-6) because DST ended on 1 November. The
 * campus-calendar fixture runs 9 to 17 November, so the dining fixture's October clock would put
 * every event in the past.
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
 * Registers into a recorder and calls tools through their input schema, as the server does, handing
 * back the WHOLE result.
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

/**
 * A stand-in for Cloudflare's Cache API that, like the real one, can only hold
 * bytes. Anything that does not survive JSON.stringify/parse comes back
 * changed -- which is how a cache HIT can behave differently from a MISS.
 */
export function stubCaches() {
    const store = new Map<string, string>();
    vi.stubGlobal("caches", {
        default: {
            async match(req: Request) {
                const body = store.get(req.url);
                return body === undefined ? undefined : new Response(body);
            },
            async put(req: Request, res: Response) {
                store.set(req.url, await res.text());
            },
        },
    });
    return store;
}
