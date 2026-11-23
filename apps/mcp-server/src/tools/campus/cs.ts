import { cached, decode, getText, text } from "../../shared.ts";
import { austinNow } from "../dining/extract.ts";
import { buildEvent, hashId, type CampusEvent } from "./extract.ts";

export const CS_SOURCE = "apps.cs.utexas.edu";

const BASE = "https://apps.cs.utexas.edu/calendar";
const CACHE_VERSION = 5; // 4 stored searchText without the scope break // 3 stored a Map, which a cache hit returned as {}
/** 30 minutes, matching the central calendar. */
const TTL_SECONDS = 1_800;
/**
 * A 61-day window can touch FOUR months: from 31 January it reaches 2 April. Capping at three
 * silently dropped the last one, with no note, which is the same shape as the horizon bug this file
 * was rewritten to fix.
 */
const MAX_MONTHS = 4;

/** The YYYY-MM keys a window touches, in Austin's months rather than UTC's. */
export function monthsSpanned(now: Date, days: number): string[] {
    // Austin-local: after 6pm Central on the last day of a month UTC is already into the next one,
    // and the current month would never be asked for.
    const from = austinNow(now);
    const end = austinNow(new Date(now.getTime() + days * 86_400_000));
    const out: string[] = [];
    let year = from.year;
    let month = from.month;
    for (let i = 0; i < MAX_MONTHS; i++) {
        out.push(`${year}-${String(month).padStart(2, "0")}`);
        if (year > end.year || (year === end.year && month >= end.month)) break;
        month += 1;
        if (month > 12) {
            month = 1;
            year += 1;
        }
    }
    return out;
}

/** One block per event occurrence in the monthly view, as `[, id, body]`. */
function blocksOf(html: string): RegExpMatchArray[] {
    return [
        ...html.matchAll(
            /calendar\.(\d+)\.field_date(.*?)(?=<div class="calendar\.\d+\.field_date|$)/gs,
        ),
    ];
}

/** Event id to room. */
export function parseRooms(html: string): Map<string, string> {
    const out = new Map<string, string>();
    for (const [, id, body] of blocksOf(html)) {
        if (!id || out.has(id)) continue;
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

export interface CsRow {
    id: string;
    title: string;
    start: string;
    end: string | null;
    room: string | null;
}

/**
 * Events from the monthly view. `content="<ISO>"` already carries a Central offset, so nothing here
 * has to guess a timezone.
 */
export function parseMonth(html: string): CsRow[] {
    const rooms = parseRooms(html);
    const out: CsRow[] = [];
    // One row per OCCURRENCE, which is how Localist publishes too. Deduping by id here kept only a
    // weekly meeting's first occurrence, so a window later in the month lost it entirely;
    // `collapseSeries` does the grouping.
    for (const [, id, body] of blocksOf(html)) {
        if (!id) continue;
        const title = text(
            /colorbox-load">(.*?)<\/a>/s.exec(body ?? "")?.[1] ??
                /views-field-title.*?<a[^>]*>(.*?)<\/a>/s.exec(body ?? "")?.[1] ??
                "",
        ).trim();
        const times = [
            ...(body ?? "").matchAll(/content="(\d{4}-\d{2}-\d{2}T[\d:]+[+-]\d{2}:\d{2})"/g),
        ].map((m) => m[1]!);
        if (!title || !times.length) continue;
        out.push({
            id,
            title: decode(title),
            start: times[0]!,
            end: times[1] ?? null,
            room: rooms.get(id) ?? null,
        });
    }
    return out;
}

/** Descriptions, keyed by event id. */
export function parseFeedDescriptions(xml: string): [string, string][] {
    const out: [string, string][] = [];
    for (const [, block] of xml.matchAll(/<item>(.*?)<\/item>/gs)) {
        const pick = (tag: string) => {
            const m = new RegExp(`<${tag}[^>]*>(.*?)</${tag}>`, "s").exec(block ?? "");
            return m ? decode(m[1]!.trim()) : "";
        };
        const id = pick("guid");
        const description = text(pick("description")).trim();
        if (id && description) out.push([id, description]);
    }
    return out;
}

function toEvent(row: CsRow, description: string | undefined): CampusEvent {
    return buildEvent({
        id: Number(row.id) || hashId(row.id),
        instanceId: hashId(`${row.id}:${row.start}`),
        title: row.title,
        start: row.start,
        end: row.end,
        description: description ?? null,
        room: row.room,
        url: `${BASE}/events/${row.id}`,
        department: "Computer Science",
        source: CS_SOURCE,
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
    // Pairs, not a Map. `cached` stores JSON and rehydrates with res.json(), so
    // a Map survives a cache MISS and comes back as `{}` on a HIT -- which made
    // `descriptions.get` throw, took the whole CS source down with it, and left
    // only a "did not answer" note. It worked exactly once per TTL, so a cold
    // check passed and every call after it returned nothing.
    const pairs = await cached(`cs:v${CACHE_VERSION}:descriptions`, TTL_SECONDS, async () =>
        parseFeedDescriptions(await getText(`${BASE}/events/rss`, TTL_SECONDS)),
    ).catch((): [string, string][] => []);
    const descriptions = new Map(pairs);

    const settled = await Promise.allSettled(
        months.map((month) =>
            cached(`cs:v${CACHE_VERSION}:${month}`, TTL_SECONDS, async () =>
                parseMonth(await getText(`${BASE}/events/month/${month}`, TTL_SECONDS)),
            ),
        ),
    );

    const events: CampusEvent[] = [];
    const failed: string[] = [];
    settled.forEach((result, i) => {
        if (result.status === "fulfilled") {
            for (const row of result.value) events.push(toEvent(row, descriptions.get(row.id)));
        } else {
            failed.push(months[i]!);
        }
    });
    return { events, failed };
}
