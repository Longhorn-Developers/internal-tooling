import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { cacheStats, cached, getText, resetCache, UpstreamError } from "../src/shared";
import { getCurrentHours, getLocations } from "../src/tools/dining/extract";
import { stubFetch } from "./fixtures";

/**
 * A stand-in for Cloudflare's Cache API that, like the real one, can only hold
 * bytes. Anything that does not survive JSON.stringify/parse comes back changed
 * -- which is how a cache HIT can behave differently from a MISS.
 */
function stubCaches() {
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

beforeEach(() => resetCache());
afterEach(() => vi.unstubAllGlobals());

describe("three-tier cache", () => {
    it("serves the second call from memo without a second fetch", async () => {
        const log = stubFetch();
        await getCurrentHours();
        await getCurrentHours();
        expect(log.filter((c) => c.url.includes("hours=1"))).toHaveLength(1);
    });

    it("falls back to the edge cache when the isolate memo is gone", async () => {
        const log = stubFetch();
        stubCaches();
        await getCurrentHours();
        resetCache(); // simulate a fresh isolate
        const second = await getCurrentHours();
        expect(second.locations.length).toBeGreaterThan(15);
        expect(log.filter((c) => c.url.includes("hours=1"))).toHaveLength(1);
    });

    it("works when the Cache API is unavailable", async () => {
        stubFetch();
        vi.stubGlobal("caches", undefined);
        await expect(getCurrentHours()).resolves.toBeTruthy();
    });

    it("survives a cache that throws on read and write", async () => {
        stubFetch();
        vi.stubGlobal("caches", {
            default: {
                match: async () => {
                    throw new Error("cache down");
                },
                put: async () => {
                    throw new Error("cache down");
                },
            },
        });
        await expect(getCurrentHours()).resolves.toBeTruthy();
    });
});

describe("cached values stay JSON-safe", () => {
    // A Map or Date survives the isolate memo but returns as {} or a string
    // from the edge cache, so this only ever fails on a cache hit.
    it("keeps parsed hour ranges usable after a round-trip", async () => {
        stubFetch();
        stubCaches();
        const first = await getCurrentHours();
        resetCache();
        const second = await getCurrentHours();

        const j2 = second.locations.find((l) => l.name === "J2 Dining")!;
        expect(j2.week[0]).toEqual(first.locations.find((l) => l.name === "J2 Dining")!.week[0]);
        expect(j2.week[0]![0]!.start).toBe(7 * 60); // Monday, 7:00am
    });

    it("keeps the location list usable after a round-trip", async () => {
        stubFetch();
        stubCaches();
        const first = await getLocations();
        resetCache();
        const second = await getLocations();
        expect(second).toHaveLength(first.length);
        expect(second.find((l) => l.name === "J2 Dining")?.lat).toBeCloseTo(30.28, 1);
    });

    it("round-trips every cached shape without loss", async () => {
        stubCaches();
        const value = { list: [1, 2], nested: { a: "x" }, empty: [] as number[] };
        const once = await cached("shape", 60, async () => value);
        resetCache();
        const twice = await cached("shape", 60, async () => {
            throw new Error("should not refetch");
        });
        expect(twice).toEqual(once);
    });
});

describe("in-flight de-duplication", () => {
    it("collapses concurrent misses into one upstream request", async () => {
        let calls = 0;
        const load = async () => {
            calls++;
            await new Promise((r) => setTimeout(r, 20));
            return { ok: true };
        };
        const all = await Promise.all(Array.from({ length: 25 }, () => cached("burst", 60, load)));
        expect(calls).toBe(1);
        expect(all.every((r) => r.ok)).toBe(true);
    });

    // A failure is remembered briefly so an outage cannot turn every request
    // into a fresh origin request, then retried so recovery is picked up.
    it("shields the origin during an outage, then retries", async () => {
        vi.useFakeTimers();
        try {
            let calls = 0;
            const load = async () => {
                calls++;
                if (calls === 1) throw new Error("upstream blew up");
                return "recovered";
            };
            await expect(cached("flaky", 60, load)).rejects.toThrow("upstream blew up");
            await expect(cached("flaky", 60, load)).rejects.toThrow("upstream blew up");
            expect(calls).toBe(1);

            vi.advanceTimersByTime(31_000);
            await expect(cached("flaky", 60, load)).resolves.toBe("recovered");
            expect(calls).toBe(2);
        } finally {
            vi.useRealTimers();
        }
    });

    it("clears a remembered failure once the call succeeds", async () => {
        vi.useFakeTimers();
        try {
            let fail = true;
            const load = async () => {
                if (fail) throw new Error("down");
                return "up";
            };
            await expect(cached("recovering", 60, load)).rejects.toThrow("down");
            expect(cacheStats().failures).toBe(1);

            vi.advanceTimersByTime(31_000);
            fail = false;
            await expect(cached("recovering", 60, load)).resolves.toBe("up");
            expect(cacheStats().failures).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });

    it("rejects every concurrent caller when the shared load fails", async () => {
        const load = async () => {
            await new Promise((r) => setTimeout(r, 10));
            throw new Error("shared failure");
        };
        const results = await Promise.allSettled(
            Array.from({ length: 5 }, () => cached("shared-fail", 60, load)),
        );
        expect(results.every((r) => r.status === "rejected")).toBe(true);
    });
});

describe("cache bounds and freshness", () => {
    it("does not restart the TTL when serving from the edge cache", async () => {
        vi.useFakeTimers();
        try {
            const store = stubCaches();
            let calls = 0;
            const load = async () => {
                calls++;
                return `v${calls}`;
            };
            await cached("ttl", 60, load);
            expect(store.size).toBe(1);

            vi.advanceTimersByTime(45_000);
            resetCache(); // fresh isolate, value still in the edge cache
            await expect(cached("ttl", 60, load)).resolves.toBe("v1");
            expect(calls).toBe(1);

            // The memo must have inherited the original t+60s deadline. Do NOT
            // reset here: if the hit restarted the TTL to t+105s, the memo would
            // still be live at t+70s and quietly serve a stale value.
            vi.advanceTimersByTime(25_000);
            await expect(cached("ttl", 60, load)).resolves.toBe("v2");
            expect(calls).toBe(2);
        } finally {
            vi.useRealTimers();
        }
    });

    // Keys are partly caller-driven (one per recipe and serving), so an
    // unbounded memo would grow against the isolate's memory limit.
    it("bounds the in-memory cache", async () => {
        for (let i = 0; i < 400; i++) await cached(`k${i}`, 600, async () => `v${i}`);
        const { entries, limit } = cacheStats();
        expect(entries).toBe(limit);
    });

    it("evicts least-recently-used entries, keeping hot ones", async () => {
        for (let i = 0; i < 200; i++) await cached(`e${i}`, 600, async () => i);
        await cached("e0", 600, async () => -1); // touch the oldest; must not reload
        for (let i = 200; i < 400; i++) await cached(`e${i}`, 600, async () => i);

        let reloaded = false;
        await cached("e0", 600, async () => {
            reloaded = true;
            return -1;
        });
        expect(reloaded).toBe(false);
    });
});

describe("upstream failures are explicit", () => {
    it("names the host on a non-200", async () => {
        stubFetch({ "hf-foodpro": 503 });
        await expect(
            getText("https://hf-foodpro.austin.utexas.edu/foodpro/"),
        ).rejects.toBeInstanceOf(UpstreamError);
        await expect(getText("https://hf-foodpro.austin.utexas.edu/foodpro/")).rejects.toThrow(
            /503/,
        );
    });

    // UT's SSO can answer 200 at the original URL with a login page, so
    // checking the response URL alone never fires.
    it("does not silently parse a login page as data", async () => {
        stubFetch({
            "housing.utexas.edu":
                '<html><form action="/idp/profile/SAML2/Redirect/SSO">UT EID</form></html>',
        });
        await expect(
            getText("https://housing.utexas.edu/dining/hours-of-operation"),
        ).rejects.toThrow(/EID login/);
    });

    it("reports a network failure as an upstream error", async () => {
        vi.stubGlobal("fetch", async () => {
            throw new TypeError("connection refused");
        });
        await expect(getText("https://hf-foodpro.austin.utexas.edu/")).rejects.toThrow(
            /Could not reach/,
        );
    });
});

describe("a partial label bundle is not kept as long as a complete one", () => {
    it("re-reads a bundle that had a failure once its short deadline passes", async () => {
        stubCaches();
        const log = stubFetch({ "label.aspx": 500 });
        const load = async () => {
            let ok = 0;
            try {
                await getText("https://x/label.aspx?a");
                ok++;
            } catch {}
            return { ok };
        };
        const ttlFor = (v: { ok: number }) => (v.ok ? 86400 : 300);

        await cached("bundle", 86400, load, ttlFor);
        const afterFirst = log.length;

        vi.setSystemTime(Date.now() + 301_000);
        resetCache(); // fresh isolate; the edge entry is what's being tested
        await cached("bundle", 86400, load, ttlFor);
        expect(log.length).toBeGreaterThan(afterFirst);
    });
});
