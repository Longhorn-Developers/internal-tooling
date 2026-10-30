import { readFileSync } from "node:fs";
import { join } from "node:path";
import { vi } from "vite-plus/test";

const DIR = join(import.meta.dirname, "fixtures");

export const fixture = (name: string): string => readFileSync(join(DIR, name), "utf8");

/**
 * Real responses captured from UT on 2026-10-14/15. Matched longest-pattern
 * first so a specific URL wins over a prefix.
 */
const ROUTES: [string, string][] = [
    ["data_all_endpoint.php?menu=1", "foodpro-menu.json"],
    ["data_all_endpoint.php?hours=1", "foodpro-hours.txt"],
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
    // Least specific last: the app shell, which carries the location coordinates.
    ["hf-foodpro.austin.utexas.edu/foodpro/", "foodpro-app.html"],
];

export type FetchLog = { url: string }[];

/**
 * Replace global fetch with a fixture server. Returns the call log, so tests can
 * assert on how many times upstream was actually hit (de-duplication, caching).
 */
export function stubFetch(overrides: Record<string, string | number> = {}): FetchLog {
    const log: FetchLog = [];
    vi.stubGlobal("fetch", async (input: string | URL) => {
        const url = String(input);
        log.push({ url });
        for (const [key, value] of Object.entries(overrides)) {
            if (url.includes(key)) {
                if (typeof value === "number") return new Response("", { status: value });
                return new Response(value, { status: 200 });
            }
        }
        const hit = ROUTES.find(([pattern]) => url.includes(pattern));
        if (!hit) throw new Error(`No fixture for ${url}`);
        return new Response(fixture(hit[1]), { status: 200 });
    });
    return log;
}

/** 2026-10-15 15:44 America/Chicago (CDT, UTC-5), a Thursday. */
export const FIXED_NOW = new Date("2026-10-15T20:44:00Z");
