import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { McpServer } from "@modelcontextprotocol/server";

import { resetCache } from "../src/shared";
import { registerDiningTools } from "../src/tools/dining";
import { FIXED_NOW, stubFetch } from "./fixtures";

/**
 * Cloudflare counts cache.match and cache.put against the same per-request
 * budget as fetch, and the free plan allows 50. Caching each label on its own
 * cost three subrequests apiece, which put an unfiltered menu at 123.
 */
const FREE_PLAN_LIMIT = 50;

function countingCaches() {
    const store = new Map<string, string>();
    const n = { match: 0, put: 0 };
    vi.stubGlobal("caches", {
        default: {
            async match(req: Request) {
                n.match++;
                const body = store.get(req.url);
                return body === undefined ? undefined : new Response(body);
            },
            async put(req: Request, res: Response) {
                n.put++;
                store.set(req.url, await res.text());
            },
        },
    });
    return n;
}

const tools = new Map<string, (a: unknown) => Promise<unknown>>();
registerDiningTools({
    registerTool: (name: string, _config: unknown, handler: unknown) => {
        tools.set(name, handler as (a: unknown) => Promise<unknown>);
    },
} as unknown as McpServer);

const menu = (args: Record<string, unknown>) => tools.get("get_dining_menu")!(args);

beforeEach(() => {
    resetCache();
    vi.setSystemTime(FIXED_NOW);
});
afterEach(() => vi.unstubAllGlobals());

describe("subrequest budget", () => {
    it("fits an unfiltered cold call inside the free plan's limit", async () => {
        const cache = countingCaches();
        const log = stubFetch();
        await menu({ location: "J2", meal: "Lunch" });
        expect(log.length + cache.match + cache.put).toBeLessThan(FREE_PLAN_LIMIT);
    });

    it("costs almost nothing once the edge cache is warm", async () => {
        const cache = countingCaches();
        const log = stubFetch();
        await menu({ location: "J2", meal: "Lunch" });

        resetCache(); // a fresh isolate in the same colo: memo gone, edge cache warm
        const before = { fetch: log.length, match: cache.match, put: cache.put };
        await menu({ location: "J2", meal: "Lunch" });

        const spent =
            log.length - before.fetch + (cache.match - before.match) + (cache.put - before.put);
        expect(log.length).toBe(before.fetch); // nothing went back to UT
        expect(spent).toBeLessThan(10);
    });
});
