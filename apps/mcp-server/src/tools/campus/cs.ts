// The Computer Science department's own calendar, which the central UT calendar
// does not carry. Cross-checked one week: 23 of 23 CS events were absent from
// Localist, including Texas ACM's and Longhorn Developers' own events.
//
// Two requests per month. The RSS feed is the source of truth -- stable, cheap,
// and it carries the id, title, start and description. The monthly HTML is
// best-effort enrichment for the room, which the feed omits and which is most of
// what makes an answer useful ("GDC 1.304" resolves to coordinates). A layout
// change upstream therefore costs the room, not the events.

import { cached, decode, getText, text } from "../../shared.ts";
import { resolveBuilding } from "./buildings.ts";
import type { CampusEvent } from "./extract.ts";

export const CS_SOURCE = "apps.cs.utexas.edu";

const BASE = "https://apps.cs.utexas.edu/calendar";
const CACHE_VERSION = 2; // 1 cached events before the room join worked
/** 30 minutes, matching the central calendar. */
const TTL_SECONDS = 1_800;
/** A 60-day window touches at most three months. */
const MAX_MONTHS = 3;
const DESCRIPTION_LIMIT = 400;
const SEARCH_TEXT_LIMIT = 8_000;

const MONTHS: Record<string, number> = {
    jan: 1,
    feb: 2,
    mar: 3,
    apr: 4,
    may: 5,
    jun: 6,
    jul: 7,
    aug: 8,
    sep: 9,
    oct: 10,
    nov: 11,
    dec: 12,
};

/** The YYYY-MM keys a window touches, in order. */
export function monthsSpanned(now: Date, days: number): string[] {
    const out: string[] = [];
    const end = new Date(now.getTime() + days * 86_400_000);
    const cursor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    while (out.length < MAX_MONTHS) {
        const key = `${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, "0")}`;
        out.push(key);
        if (
            cursor.getUTCFullYear() > end.getUTCFullYear() ||
            (cursor.getUTCFullYear() === end.getUTCFullYear() &&
                cursor.getUTCMonth() >= end.getUTCMonth())
        ) {
            break;
        }
        cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }
    return out;
}

/**
 * "Wed, 18 Nov 2026 18:00 CST" to an ISO string with a Central offset.
 *
 * Not `Date.parse`: it treats a named zone as a hint and is allowed to ignore
 * it, so the same string can land an hour out depending on the runtime. The
 * feed only ever writes CST or CDT.
 */
export function csInstant(pubDate: string): string | null {
    const m = /^\w{3},\s*(\d{1,2})\s+(\w{3})\s+(\d{4})\s+(\d{1,2}):(\d{2})\s*(CST|CDT)$/i.exec(
        pubDate.trim(),
    );
    if (!m) return null;
    const month = MONTHS[m[2]!.toLowerCase()];
    if (!month) return null;
    const offset = m[6]!.toUpperCase() === "CST" ? "-06:00" : "-05:00";
    const pad = (v: string) => v.padStart(2, "0");
    return `${m[3]}-${String(month).padStart(2, "0")}-${pad(m[1]!)}T${pad(m[4]!)}:${m[5]}:00${offset}`;
}

/** Event id to room, from the monthly view. Empty if the markup moved. */
export function parseRooms(html: string): Map<string, string> {
    const out = new Map<string, string>();
    const blocks = html.matchAll(
        /calendar\.(\d+)\.field_date(.*?)(?=<div class="calendar\.\d+\.field_date|$)/gs,
    );
    for (const [, id, body] of blocks) {
        if (!id || out.has(id)) continue;
        // Both fields, first non-empty. Taking whichever one MATCHED found 12
        // of 102 rooms: the view renders both, and the one it leaves empty is
        // usually `location-1`, so a match-based fallback never fired. Checking
        // the values instead finds 101 of 102.
        for (const field of ["room-1", "location-1"] as const) {
            const m = new RegExp(
                `views-field-field-${field}.*?<div class="field-content">(.*?)</div>`,
                "s",
            ).exec(body ?? "");
            const room = text(m?.[1] ?? "")
                .replace(/^room:\s*/i, "")
                .trim();
            if (room) {
                out.set(id, room);
                break;
            }
        }
    }
    return out;
}

interface RawItem {
    id: string;
    title: string;
    start: string;
    description: string;
    url: string;
}

/** `dc:creator` is deliberately not read: it names a student. */
export function parseFeed(xml: string): RawItem[] {
    const out: RawItem[] = [];
    for (const [, block] of xml.matchAll(/<item>(.*?)<\/item>/gs)) {
        const pick = (tag: string) => {
            const m = new RegExp(`<${tag}[^>]*>(.*?)</${tag}>`, "s").exec(block ?? "");
            return m ? decode(m[1]!.trim()) : "";
        };
        const title = text(pick("title"));
        const start = csInstant(pick("pubDate"));
        const id = pick("guid");
        if (!title || !start || !id) continue;
        out.push({
            id,
            title,
            start,
            description: text(pick("description")),
            url: pick("link") || `${BASE}/events/${id}`,
        });
    }
    return out;
}

function toEvent(raw: RawItem, room: string | undefined): CampusEvent {
    const resolved = room ? resolveBuilding(room) : null;
    const description = raw.description || null;
    return {
        // The feed's ids are numeric strings; a non-numeric one would collapse
        // every such event onto id 0, so it keeps its own hash instead.
        id: Number(raw.id) || hash(raw.id),
        instanceId: Number(raw.id) || hash(raw.id),
        title: raw.title,
        description:
            description && description.length > DESCRIPTION_LIMIT
                ? `${description.slice(0, DESCRIPTION_LIMIT).trimEnd()}...`
                : description,
        searchText: [raw.title, (description ?? "").slice(0, SEARCH_TEXT_LIMIT), room ?? ""]
            .filter(Boolean)
            .join("\n")
            .toLowerCase(),
        start: raw.start,
        // The feed publishes no end time. `filterEvents` assumes an hour for a
        // timed event without one, which is the same assumption Localist rows
        // without an end get.
        end: null,
        allDay: false,
        locationName: room ?? null,
        room: room ?? null,
        address: null,
        latitude: resolved?.building.latitude ?? null,
        longitude: resolved?.building.longitude ?? null,
        coordinateSource: resolved ? "building" : null,
        buildingCode: resolved?.building.code ?? null,
        venue: "inperson",
        categories: [],
        audiences: [],
        departments: ["Computer Science"],
        tags: [],
        canceled: false,
        freeAdmission: false,
        ticketCost: null,
        streamUrl: null,
        url: raw.url,
        photoUrl: null,
        source: CS_SOURCE,
    };
}

/** Stable positive id for a non-numeric guid. */
function hash(value: string): number {
    let h = 0;
    for (let i = 0; i < value.length; i++) h = (h * 31 + value.charCodeAt(i)) | 0;
    return Math.abs(h) || 1;
}

/**
 * One month of CS events. The room lookup is allowed to fail on its own.
 */
async function csMonth(month: string): Promise<CampusEvent[]> {
    return cached(`cs:v${CACHE_VERSION}:${month}`, TTL_SECONDS, async () => {
        const xml = await getText(`${BASE}/events/rss/${month}`, TTL_SECONDS);
        const items = parseFeed(xml);
        if (!items.length) return [];
        const rooms = await getText(`${BASE}/events/month/${month}`, TTL_SECONDS)
            .then(parseRooms)
            .catch(() => new Map<string, string>());
        return items.map((item) => toEvent(item, rooms.get(item.id)));
    });
}

export interface CsResult {
    events: CampusEvent[];
    /** Months that could not be read, so the answer can say so. */
    failed: string[];
}

/** Every CS event in the window, with whichever months answered. */
export async function getCsCalendar(now: Date, days: number): Promise<CsResult> {
    const months = monthsSpanned(now, days);
    const settled = await Promise.allSettled(months.map(csMonth));
    const events: CampusEvent[] = [];
    const failed: string[] = [];
    settled.forEach((result, i) => {
        if (result.status === "fulfilled") events.push(...result.value);
        else failed.push(months[i]!);
    });
    events.sort((a, b) => a.start.localeCompare(b.start) || a.instanceId - b.instanceId);
    return { events, failed };
}
