import { cached, decode, getJson, getText, text } from "../../shared.ts";
import {
    austinInstant,
    buildEvent,
    centralIso,
    hashId,
    type CampusEvent,
    type EventSource,
    type VenueType,
} from "./extract.ts";
import { CS_SOURCE, getCsCalendar } from "./cs.ts";

const CACHE_VERSION = 3; // 2 stored searchText without the scope break // 1 stored events before venue, cost and series keys
/** Six hours. These are hand-edited department calendars, not live feeds. */
const TTL_SECONDS = 21_600;

export const LAW_SOURCE = "law.utexas.edu";
export const MCCOMBS_SOURCE = "calendar.mccombs.utexas.edu";
export const COCKRELL_SOURCE = "cockrell.utexas.edu";

// ------------------------------------------------------------------- law, ICS

/** ICS unfolding, which has to happen before anything else. */
export function unfoldIcs(body: string): string {
    return body.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "");
}

/**
 * "20261118T083000", or a trailing Z for UTC, to an ISO string with Austin's
 * offset -- the form `CampusEvent.start` promises.
 */
export function icsInstant(value: string): string | null {
    const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(value.trim());
    if (!m) return null;
    const [, y, mo, d, h, mi, , z] = m;
    if (z) return centralIso(new Date(`${y}-${mo}-${d}T${h}:${mi}:00Z`));
    return centralIso(
        austinInstant(Number(y), Number(mo), Number(d), Number(h ?? 0), Number(mi ?? 0)),
    );
}

export function parseIcs(body: string, source: EventSource, department: string): CampusEvent[] {
    const out: CampusEvent[] = [];
    for (const [, block] of unfoldIcs(body).matchAll(/BEGIN:VEVENT\n(.*?)END:VEVENT/gs)) {
        const field = (name: string) => {
            const m = new RegExp(`^${name}([^:\n]*):(.*)$`, "m").exec(block ?? "");
            return m ? { params: m[1] ?? "", value: m[2] ?? "" } : null;
        };
        // ICS escapes commas and semicolons inside a value.
        const unescape = (v: string) =>
            decode(v.replace(/\\n/g, " ").replace(/\\([,;\\])/g, "$1")).trim();

        const start = field("DTSTART");
        const summary = field("SUMMARY");
        const uid = field("UID");
        if (!start || !summary?.value.trim() || !uid) continue;
        const startIso = icsInstant(start.value);
        if (!startIso) continue;
        const end = field("DTEND");
        const status = field("STATUS")?.value.trim().toUpperCase();

        out.push(
            buildEvent({
                id: hashId(uid.value.trim()),
                title: unescape(summary.value),
                start: startIso,
                end: end ? icsInstant(end.value) : null,
                allDay: !/T\d{6}/.test(start.value),
                description: lawDescription(unescape(field("DESCRIPTION")?.value ?? "")),
                room: unescape(field("LOCATION")?.value ?? "") || null,
                url: field("URL")?.value.trim() || `https://${source}`,
                department,
                source,
                canceled: status === "CANCELLED",
            }),
        );
    }
    return out;
}

/**
 * Every law description ends with the same accessibility trailer, which made `query:
 * "accommodation"` return 11 law events and nothing else.
 */
function lawDescription(raw: string): string | null {
    const body = text(raw).split(/To request an accommodation|Special Events Office/i)[0] ?? "";
    return body.trim() || null;
}

async function lawEvents(): Promise<CampusEvent[]> {
    return cached(`law:v${CACHE_VERSION}`, TTL_SECONDS, async () => {
        const body = await getText("https://law.utexas.edu/calendar/feed/ics/", TTL_SECONDS);
        return parseIcs(body, LAW_SOURCE, "School of Law");
    });
}

// ------------------------------------------------- mccombs, LiveWhale JSON

interface LiveWhaleRow {
    id?: number | string;
    title?: string;
    date_iso?: string;
    date2_iso?: string;
    is_all_day?: boolean | number;
    is_canceled?: boolean | number;
    url?: string;
    summary?: string;
    /** "Free", a number, or null. */
    cost?: string | number | null;
}

/**
 * No location, and no online flag either: `is_online` is null and `online_url`
 * empty on every row, so the title is the only evidence of how to attend. An
 * event that says neither is reported as `unknown` rather than asserted to be
 * in person, which was wrong in both directions -- the in-person filter
 * returned "MSF Virtual Office Hours" and the virtual filter returned nothing.
 */
function venueFromTitle(title: string): VenueType {
    if (/\b(virtual|online|zoom|webinar)\b/i.test(title)) return "virtual";
    if (/\bin[- ]?person\b/i.test(title)) return "inperson";
    return "unknown";
}

/** "Free" means free; a number means it is not. Absent says nothing either way. */
function isFree(cost: unknown): boolean {
    return typeof cost === "string" && /^\s*free\s*$/i.test(cost);
}
export function parseLiveWhale(payload: unknown): CampusEvent[] {
    const rows = (payload as { data?: LiveWhaleRow[] })?.data;
    if (!Array.isArray(rows)) return [];
    const out: CampusEvent[] = [];
    for (const row of rows) {
        const start = row.date_iso?.trim();
        const title = row.title?.trim();
        if (!start || !title) continue;
        const clean = decode(title);
        out.push(
            buildEvent({
                id: Number(row.id) || hashId(String(row.id ?? title)),
                title: clean,
                start,
                end: row.date2_iso?.trim() || null,
                allDay: Boolean(row.is_all_day),
                description: row.summary ? text(decode(row.summary)) : null,
                room: null,
                url: row.url?.trim() || `https://${MCCOMBS_SOURCE}`,
                department: "McCombs School of Business",
                source: MCCOMBS_SOURCE,
                canceled: Boolean(row.is_canceled),
                venue: venueFromTitle(clean),
                freeAdmission: isFree(row.cost),
                // LiveWhale gives every occurrence its own id, so without this one weekday series
                // was 13 separate rows. `gid` is a calendar group, not a series, so the title and
                // link are the key.
                seriesKey: `${clean}|${row.url ?? ""}`,
            }),
        );
    }
    return out;
}

/** Pages until the feed runs out, up to MAX_PAGES. */
const MAX_PAGES = 3;

async function mccombsEvents(): Promise<CampusEvent[]> {
    return cached(`mccombs:v${CACHE_VERSION}`, TTL_SECONDS, async () => {
        const out: CampusEvent[] = [];
        for (let page = 1; page <= MAX_PAGES; page++) {
            const payload = await getJson<{ meta?: { total_pages?: number } }>(
                `https://${MCCOMBS_SOURCE}/live/json/events?per_page=100&page=${page}`,
                TTL_SECONDS,
            );
            const rows = parseLiveWhale(payload);
            out.push(...rows);
            if (!rows.length || page >= (payload?.meta?.total_pages ?? 1)) break;
        }
        return out;
    });
}

// ------------------------------------------- cockrell, WordPress REST

interface WpRow {
    id?: number;
    link?: string;
    title?: { rendered?: string };
    meta?: Record<string, unknown>;
}

/**
 * Post meta is untyped, so a field that arrives as an object is treated as absent rather than
 * stringified into "[object Object]" and then parsed as a date or a room.
 */
const metaString = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

/** Times live in post meta as "2026-12-11" plus "12:00 pm". */
export function parseWordPress(payload: unknown): CampusEvent[] {
    const rows = payload as WpRow[];
    if (!Array.isArray(rows)) return [];
    const out: CampusEvent[] = [];
    for (const row of rows) {
        const meta = row.meta ?? {};
        const day = metaString(meta["cockrell_event_date"]);
        const title = decode(row.title?.rendered ?? "").trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !title) continue;
        const clock = (value: unknown): [number, number] | null => {
            const m = /^(\d{1,2}):(\d{2})\s*(am|pm)$/i.exec(metaString(value));
            if (!m) return null;
            let hour = Number(m[1]) % 12;
            if (m[3]!.toLowerCase() === "pm") hour += 12;
            return [hour, Number(m[2])];
        };
        const [y, mo, d] = day.split("-").map(Number) as [number, number, number];
        const endDay = metaString(meta["cockrell_event_end_date"]);
        const [ey, emo, ed] = (/^\d{4}-\d{2}-\d{2}$/.test(endDay) ? endDay : day)
            .split("-")
            .map(Number) as [number, number, number];
        const startClock = clock(meta["cockrell_event_start_time"]);
        const endClock = clock(meta["cockrell_event_end_time"]);
        out.push(
            buildEvent({
                id: Number(row.id) || hashId(day + title),
                title,
                start: centralIso(
                    austinInstant(y, mo, d, startClock?.[0] ?? 0, startClock?.[1] ?? 0),
                ),
                // `cockrell_event_end_date` is its own field, so a multi-day event used to end on
                // its start date and read as one day.
                end: endClock
                    ? centralIso(austinInstant(ey, emo, ed, endClock[0], endClock[1]))
                    : null,
                allDay: !startClock,
                description: null,
                // The field carries markup: "\"HQ\" Room, Floor 1<br>North Tower, EER Building".
                // `text` flattens it so the resolver sees one string.
                room: text(metaString(meta["cockrell_event_location"])) || null,
                url: row.link?.trim() || `https://${COCKRELL_SOURCE}`,
                department: "Cockrell School of Engineering",
                source: COCKRELL_SOURCE,
                freeAdmission: isFree(metaString(meta["cockrell_event_cost"])),
            }),
        );
    }
    return out;
}

async function cockrellEvents(): Promise<CampusEvent[]> {
    return cached(`cockrell:v${CACHE_VERSION}`, TTL_SECONDS, async () => {
        const out: CampusEvent[] = [];
        // WordPress reports the page count in a header, which `getJson` does not surface, so a full
        // page is taken as a hint there may be another.
        for (let page = 1; page <= MAX_PAGES; page++) {
            const rows = await getJson<unknown[]>(
                `https://${COCKRELL_SOURCE}/wp-json/wp/v2/event?per_page=100&page=${page}`,
                TTL_SECONDS,
            );
            out.push(...parseWordPress(rows));
            if (!Array.isArray(rows) || rows.length < 100) break;
        }
        return out;
    });
}

// ------------------------------------------------------------------ registry

export interface DepartmentResult {
    events: CampusEvent[];
    /** Sources that did not answer, so the answer can say what is missing. */
    failed: string[];
}

/** Every departmental calendar, each settled on its own. */
export async function getDepartmentCalendars(now: Date, days: number): Promise<DepartmentResult> {
    const sources: { id: string; run: () => Promise<CampusEvent[]> }[] = [
        {
            id: CS_SOURCE,
            run: async () => {
                const result = await getCsCalendar(now, days);
                if (result.failed.length && !result.events.length) {
                    throw new Error(`no month answered: ${result.failed.join(", ")}`);
                }
                return result.events;
            },
        },
        { id: LAW_SOURCE, run: lawEvents },
        { id: MCCOMBS_SOURCE, run: mccombsEvents },
        { id: COCKRELL_SOURCE, run: cockrellEvents },
    ];
    const settled = await Promise.allSettled(sources.map((s) => s.run()));
    const events: CampusEvent[] = [];
    const failed: string[] = [];
    settled.forEach((result, i) => {
        if (result.status === "fulfilled") events.push(...result.value);
        else failed.push(sources[i]!.id);
    });
    // No sort here: index.ts sorts the merged list, which is the only order a caller sees.
    return { events, failed };
}
