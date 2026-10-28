const UA =
    "Mozilla/5.0 (compatible; ut-mcp/0.1; +https://github.com/Longhorn-Developers/internal-tooling)";

type Entry = { value: unknown; expires: number };

// memo (per isolate) -> Cache API (per colo) -> UT.
// The Cache API holds the parsed, trimmed value rather than the upstream body,
// so a hit reads a few KB instead of re-parsing the 1.9 MB menu feed.
const memo = new Map<string, Entry>();
const inflight = new Map<string, Promise<unknown>>();
const failures = new Map<string, { error: unknown; expires: number }>();

const CACHE_HOST = "https://ut-mcp.cache";

// Keys include recipe numbers, so bound this. Map keeps insertion order, so
// re-inserting on read gives an LRU.
const MEMO_MAX = 256;

/** Remember failures briefly so a UT outage doesn't mean one origin hit per request. */
const FAILURE_TTL_MS = 30_000;

function remember(key: string, value: unknown, expires: number): void {
    memo.delete(key);
    memo.set(key, { value, expires });
    while (memo.size > MEMO_MAX) {
        const oldest = memo.keys().next().value;
        if (oldest === undefined) break;
        memo.delete(oldest);
    }
}

async function edgeCache(): Promise<Cache | null> {
    try {
        return (caches as unknown as { default: Cache }).default ?? null;
    } catch {
        return null; // not available outside the Workers runtime
    }
}

/** `load` should return something small and JSON-safe, not the raw response. */
export async function cached<T>(
    key: string,
    ttlSeconds: number,
    load: () => Promise<T>,
    /** Lets a partial result be kept for less time than a complete one. */
    ttlFor?: (value: T) => number,
): Promise<T> {
    const now = Date.now();
    const hit = memo.get(key);
    if (hit && hit.expires > now) {
        remember(key, hit.value, hit.expires); // refresh LRU position only
        return hit.value as T;
    }

    const failed = failures.get(key);
    if (failed && failed.expires > now) throw failed.error;

    const pending = inflight.get(key);
    if (pending) return pending as Promise<T>;

    const p = (async () => {
        const cache = await edgeCache();
        const req = new Request(`${CACHE_HOST}/${encodeURIComponent(key)}`);
        if (cache) {
            try {
                const res = await cache.match(req);
                if (res) {
                    // deadline travels with the value, so a hit doesn't restart the TTL
                    const { exp, v } = (await res.json()) as { exp: number; v: T };
                    if (exp > Date.now()) {
                        remember(key, v, exp);
                        return v;
                    }
                }
            } catch {
                // fall through to origin
            }
        }

        let value: T;
        try {
            value = await load();
        } catch (error) {
            // bounded like the memo; a bad item number is a reachable error
            if (failures.size >= MEMO_MAX) {
                const now = Date.now();
                for (const [k, v] of failures) if (v.expires <= now) failures.delete(k);
                while (failures.size >= MEMO_MAX) {
                    const oldest = failures.keys().next().value;
                    if (oldest === undefined) break;
                    failures.delete(oldest);
                }
            }
            failures.set(key, { error, expires: Date.now() + FAILURE_TTL_MS });
            throw error;
        }
        failures.delete(key);

        const exp = Date.now() + (ttlFor ? ttlFor(value) : ttlSeconds) * 1000;
        remember(key, value, exp);
        if (cache) {
            try {
                await cache.put(
                    req,
                    new Response(JSON.stringify({ exp, v: value }), {
                        headers: {
                            "Content-Type": "application/json",
                            "Cache-Control": `max-age=${Math.round((exp - Date.now()) / 1000)}`,
                        },
                    }),
                );
            } catch {
                // cache writes are best-effort
            }
        }
        return value;
    })().finally(() => inflight.delete(key));

    inflight.set(key, p);
    return p;
}

/** Tests call this so each case starts cold. */
export function resetCache(): void {
    memo.clear();
    inflight.clear();
    failures.clear();
}

export const cacheStats = () => ({ entries: memo.size, failures: failures.size, limit: MEMO_MAX });

export class UpstreamError extends Error {}

async function get(url: string, ttlSeconds: number, accept: string): Promise<Response> {
    let res: Response;
    try {
        res = await fetch(url, {
            headers: { "User-Agent": UA, Accept: accept },
            cf: { cacheTtl: ttlSeconds, cacheEverything: true },
        } as RequestInit);
    } catch (e) {
        throw new UpstreamError(`Could not reach ${new URL(url).host}: ${(e as Error).message}`);
    }
    if (!res.ok) throw new UpstreamError(`${new URL(url).host} returned HTTP ${res.status}`);
    if (res.url.includes("login.utexas.edu"))
        throw new UpstreamError(`${url} now requires a UT EID login`);
    return res;
}

/** SSO can answer 200 with a login page at the original URL. */
function looksLikeLogin(body: string): boolean {
    return (
        /enterprise\.login\.utexas\.edu|\/idp\/profile\/SAML2/.test(body) ||
        (/name="j_username"|id="username"/.test(body) && /UT\s*EID/i.test(body))
    );
}

export async function getText(url: string, ttlSeconds = 600): Promise<string> {
    const body = await (
        await get(url, ttlSeconds, "text/html,application/json;q=0.9,*/*;q=0.8")
    ).text();
    if (looksLikeLogin(body)) throw new UpstreamError(`${url} now requires a UT EID login`);
    return body;
}
