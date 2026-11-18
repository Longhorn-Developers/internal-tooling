// Departmental calendars. UT's central calendar carries almost none of this:
// over 60 days it has 245 events and only 23 department values, nearly all
// arts, student affairs and HR.
//
// There is no single format. Three families cover the three sources worth
// reading, and each is the cheapest structured endpoint that site offers:
//
//   law         ICS feed              135 events, with locations
//   mccombs     LiveWhale JSON        150 events, no location on this endpoint
//   cockrell    WordPress REST        5 events, location in post meta
//
// Moody, Nursing, Fine Arts, Texas Global, Liberal Arts, the iSchool and
// Physics expose none of these and would each need a bespoke HTML parser, which
// is how Longhorn Loop reached 8 of 11 scrapers broken. Fine Arts is also
// already the best-covered department in the central calendar.

import { cached, decode, getJson, getText, text } from "../../shared.ts";
import { resolveBuilding } from "./buildings.ts";
import { austinInstant, type CampusEvent, type EventSource } from "./extract.ts";
import { CS_SOURCE, getCsCalendar } from "./cs.ts";

const CACHE_VERSION = 1;
/** Six hours. These are hand-edited department calendars, not live feeds. */
const TTL_SECONDS = 21_600;
const DESCRIPTION_LIMIT = 400;
const SEARCH_TEXT_LIMIT = 8_000;

export const LAW_SOURCE = "law.utexas.edu";
export const MCCOMBS_SOURCE = "calendar.mccombs.utexas.edu";
export const COCKRELL_SOURCE = "cockrell.utexas.edu";

/** The shared parts of an event, so each provider only supplies what it knows. */
function build(opts: {
    id: number;
    title: string;
    start: string;
    end?: string | null;
    allDay?: boolean;
    description?: string | null;
    room?: string | null;
    url: string;
    department: string;
    source: EventSource;
    canceled?: boolean;
    online?: boolean;
}): CampusEvent {
    const room = opts.room?.trim() || null;
    const resolved = room ? resolveBuilding(room) : null;
    const plain = opts.description?.trim() || null;
    return {
        id: opts.id,
        instanceId: opts.id,
        title: opts.title,
        description:
            plain && plain.length > DESCRIPTION_LIMIT
                ? `${plain.slice(0, DESCRIPTION_LIMIT).trimEnd()}...`
                : plain,
        searchText: [opts.title, (plain ?? "").slice(0, SEARCH_TEXT_LIMIT), room ?? ""]
            .filter(Boolean)
            .join("\n")
            .toLowerCase(),
        start: opts.start,
        end: opts.end ?? null,
        allDay: opts.allDay ?? false,
        locationName: room,
        room,
        address: null,
        latitude: resolved?.building.latitude ?? null,
        longitude: resolved?.building.longitude ?? null,
        coordinateSource: resolved ? "building" : null,
        buildingCode: resolved?.building.code ?? null,
        venue: opts.online ? "virtual" : "inperson",
        categories: [],
        audiences: [],
        departments: [opts.department],
        tags: [],
        canceled: opts.canceled ?? false,
        freeAdmission: false,
        ticketCost: null,
        streamUrl: null,
        url: opts.url,
        photoUrl: null,
        source: opts.source,
    };
}

/** Stable positive id from a feed's own string id. */
function hash(value: string): number {
    let h = 0;
    for (let i = 0; i < value.length; i++) h = (h * 31 + value.charCodeAt(i)) | 0;
    return Math.abs(h) || 1;
}

// ------------------------------------------------------------------- law, ICS

/**
 * ICS unfolding, which has to happen before anything else.
 *
 * RFC 5545 wraps a long line by starting the continuation with a space or tab,
 * so a LOCATION or DESCRIPTION arrives split across lines and a naive line
 * parse reads half of it.
 */
export function unfoldIcs(body: string): string {
    return body.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "");
}

/**
 * "20261118T083000" with TZID=US/Central, or a trailing Z for UTC.
 *
 * The named zone is resolved through `austinInstant` rather than trusted to
 * `Date.parse`, which may ignore it.
 */
export function icsInstant(value: string, tzid: string | null): string | null {
    const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(value.trim());
    if (!m) return null;
    const [, y, mo, d, h, mi, , z] = m;
    if (!h) return `${y}-${mo}-${d}T00:00:00-06:00`;
    if (z) return new Date(`${y}-${mo}-${d}T${h}:${mi}:00Z`).toISOString();
    // Every TZID this feed uses is Central; anything else is read as Central
    // too, which is wrong by an hour at worst and never wrong by a day.
    void tzid;
    return austinInstant(Number(y), Number(mo), Number(d), Number(h), Number(mi)).toISOString();
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
        const tzid = /TZID=([^;:]+)/.exec(start.params)?.[1] ?? null;
        const startIso = icsInstant(start.value, tzid);
        if (!startIso) continue;
        const end = field("DTEND");
        const status = field("STATUS")?.value.trim().toUpperCase();

        out.push(
            build({
                id: hash(uid.value.trim()),
                title: unescape(summary.value),
                start: startIso,
                end: end ? icsInstant(end.value, tzid) : null,
                allDay: !/T\d{6}/.test(start.value),
                description: text(unescape(field("DESCRIPTION")?.value ?? "")) || null,
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
    is_online?: boolean | number;
    url?: string;
    summary?: string;
}

/**
 * No location field. `supported_fields` advertises one and no spelling of a
 * field-selection parameter returns it, so these events have a time and a title
 * and no coordinates. Loop gets locations by fetching each event's own page,
 * which is one subrequest per event and too expensive here.
 */
export function parseLiveWhale(payload: unknown): CampusEvent[] {
    const rows = (payload as { data?: LiveWhaleRow[] })?.data;
    if (!Array.isArray(rows)) return [];
    const out: CampusEvent[] = [];
    for (const row of rows) {
        const start = row.date_iso?.trim();
        const title = row.title?.trim();
        if (!start || !title) continue;
        out.push(
            build({
                id: Number(row.id) || hash(String(row.id ?? title)),
                title: decode(title),
                start,
                end: row.date2_iso?.trim() || null,
                allDay: Boolean(row.is_all_day),
                description: row.summary ? text(decode(row.summary)) : null,
                room: null,
                url: row.url?.trim() || `https://${MCCOMBS_SOURCE}`,
                department: "McCombs School of Business",
                source: MCCOMBS_SOURCE,
                canceled: Boolean(row.is_canceled),
                online: Boolean(row.is_online),
            }),
        );
    }
    return out;
}

async function mccombsEvents(): Promise<CampusEvent[]> {
    return cached(`mccombs:v${CACHE_VERSION}`, TTL_SECONDS, async () =>
        parseLiveWhale(
            await getJson(`https://${MCCOMBS_SOURCE}/live/json/events?per_page=100`, TTL_SECONDS),
        ),
    );
}

// ------------------------------------------- cockrell, WordPress REST

interface WpRow {
    id?: number;
    link?: string;
    title?: { rendered?: string };
    meta?: Record<string, unknown>;
}

/**
 * Post meta is untyped, so a field that arrives as an object is treated as
 * absent rather than stringified into "[object Object]" and then parsed as a
 * date or a room.
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
        const startClock = clock(meta["cockrell_event_start_time"]);
        const endClock = clock(meta["cockrell_event_end_time"]);
        out.push(
            build({
                id: Number(row.id) || hash(day + title),
                title,
                start: austinInstant(
                    y,
                    mo,
                    d,
                    startClock?.[0] ?? 0,
                    startClock?.[1] ?? 0,
                ).toISOString(),
                end: endClock
                    ? austinInstant(y, mo, d, endClock[0], endClock[1]).toISOString()
                    : null,
                allDay: !startClock,
                description: null,
                // The field carries markup: "\"HQ\" Room, Floor 1<br>North
                // Tower, EER Building". `text` flattens it so the resolver sees
                // one string.
                room: text(metaString(meta["cockrell_event_location"])) || null,
                url: row.link?.trim() || `https://${COCKRELL_SOURCE}`,
                department: "Cockrell School of Engineering",
                source: COCKRELL_SOURCE,
            }),
        );
    }
    return out;
}

async function cockrellEvents(): Promise<CampusEvent[]> {
    return cached(`cockrell:v${CACHE_VERSION}`, TTL_SECONDS, async () =>
        parseWordPress(
            await getJson(
                `https://${COCKRELL_SOURCE}/wp-json/wp/v2/event?per_page=100`,
                TTL_SECONDS,
            ),
        ),
    );
}

// ------------------------------------------------------------------ registry

export interface DepartmentResult {
    events: CampusEvent[];
    /** Sources that did not answer, so the answer can say what is missing. */
    failed: string[];
}

/**
 * Every departmental calendar, each settled on its own.
 *
 * One source failing must not take the others down, which is the whole reason
 * these are separate cache entries with their own TTLs: a warm cache costs no
 * subrequests at all, and a cold one costs five.
 */
export async function getDepartmentCalendars(now: Date, days: number): Promise<DepartmentResult> {
    const sources: { id: string; run: () => Promise<CampusEvent[]> }[] = [
        {
            // CS settles its months internally and reports which ones failed,
            // so reading only `.events` would swallow a total outage. A partial
            // loss stays quiet: some months answered, and the alternative is a
            // note about a month the question may not even touch.
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
    events.sort((a, b) => a.start.localeCompare(b.start) || a.instanceId - b.instanceId);
    return { events, failed };
}
