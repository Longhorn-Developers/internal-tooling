export async function fetchPage(url: string, init?: RequestInit): Promise<string> {
    const response = await fetch(url, init);
    if (!response.ok) {
        throw new Error(`Page request returned HTTP ${response.status} ${response.statusText}.`);
    }
    return response.text();
}

export function jsonResponse(value: Record<string, unknown>) {
    return {
        content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
        structuredContent: value,
    };
}

export function trimmed(value: string | undefined): string | null {
    return value?.trim() || null;
}

const NAMED: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    ndash: "–",
    mdash: "—",
    rsquo: "’",
    lsquo: "‘",
    rdquo: "”",
    ldquo: "“",
    hellip: "…",
    eacute: "é",
    aacute: "á",
    iacute: "í",
    oacute: "ó",
    uacute: "ú",
    ntilde: "ñ",
    copy: "©",
    reg: "®",
    trade: "™",
};

export function decode(s: string): string {
    return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
        if (e[0] === "#") {
            const n =
                e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
            // Past U+10FFFF fromCodePoint throws, which would abort the whole
            // page parse over one bad entity in third-party markup.
            return Number.isFinite(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
        }
        return NAMED[e.toLowerCase()] ?? m;
    });
}

/**
 * Remove tags, keeping the text between them. Scans linearly rather than using
 * a regex, so a `>` inside a quoted attribute does not end the tag early and
 * there is no backtracking to blow up on.
 */
function stripTags(html: string): string {
    let out = "";
    let i = 0;
    while (i < html.length) {
        const lt = html.indexOf("<", i);
        if (lt < 0) return out + html.slice(i);
        out += html.slice(i, lt);

        if (html.startsWith("<!--", lt)) {
            const end = html.indexOf("-->", lt + 4);
            if (end < 0) return out;
            i = end + 3;
            continue;
        }

        // A `<` that cannot start a tag is literal text. Without this, a stray
        // "a < b" would open quote tracking on the next apostrophe and swallow
        // the rest of the fragment.
        if (!/[a-zA-Z/!?]/.test(html[lt + 1] ?? "")) {
            out += "<";
            i = lt + 1;
            continue;
        }

        let j = lt + 1;
        let quote = "";
        for (; j < html.length; j++) {
            const ch = html[j]!;
            if (quote) {
                if (ch === quote) quote = "";
            } else if (ch === '"' || ch === "'") {
                quote = ch;
            } else if (ch === ">") {
                break;
            }
        }
        if (j >= html.length) return out; // unterminated tag: drop the remainder
        i = j + 1;
    }
    return out;
}

/** Strip tags, decode entities, collapse whitespace. `<br>` and block ends become `sep`. */
export function text(html: string, sep = " "): string {
    return decode(
        stripTags(
            html
                .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
                .replace(/<br\s*\/?>|<\/(div|p|li|tr)>/gi, "\u0000"),
        ),
    )
        .replace(/�/g, "")
        .split("\u0000")
        .map((part) => part.replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .join(sep);
}

/** Lowercase alphanumerics only, for fuzzy name matching. */
export function norm(s: string): string {
    return s
        .toLowerCase()
        .normalize("NFD")
        .replace(/[^a-z0-9]/g, "");
}

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
