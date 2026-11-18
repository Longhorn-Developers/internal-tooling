// Reads UT's Localist calendar. Loop's own API is not the source: it serves 29
// upcoming events because 8 of its 11 scrapers yield nothing (Longhorn-Loop#472)
// where the calendar underneath carries ~324 over 60 days. `source` is on every
// event so a Loop provider can be added alongside later.
//
// A 60-day pull is 1,046 ROWS but 324 distinct events: Localist repeats a
// multi-day event once per day. See `collapseSeries`.

import { cached, decode, getText, text } from "../../shared.ts";
import { metresBetween, resolveBuilding, type Precision } from "./buildings.ts";
import { calendarUrl, eventUrl } from "./urls.ts";

/**
 * Bump whenever a cached value's shape OR its derived content changes. The
 * Cloudflare cache outlives a deploy, so old entries are read by new code. A
 * cached event bakes in coordinates resolved from buildings.json and its
 * searchText, so editing either without bumping serves the old resolution.
 */
const CACHE_VERSION = 1;

/** 30 minutes. The calendar is edited by hand; it does not move minute to minute. */
const TTL_SECONDS = 1_800;

/** A Worker invocation gets 50 subrequests and this is not the only tool in it. */
const MAX_PAGES = 12;

/**
 * Bounded by MAX_PAGES, not by Localist, which accepts up to 370 days. A window
 * past this is refused rather than answered "nothing" from a short fetch.
 */
export const MAX_WINDOW_DAYS = 60;

export const EVENT_CATEGORIES = [
    "Academics",
    "Arts & Humanities",
    "Athletics",
    "Business & Economy",
    "Campus & Community",
    "Entrepreneurship & Innovation",
    "Health & Wellness",
    "Policy & Law",
    "Research",
    "Science & Technology",
    "Sports & Recreation",
    "Sustainability",
    "World & Culture",
] as const;

export const AUDIENCES = ["Students", "Faculty", "Staff", "Alumni", "Families", "General Public"];

export const VENUE_TYPES = ["inperson", "virtual", "hybrid"] as const;
export type VenueType = (typeof VENUE_TYPES)[number];

export interface CampusEvent {
    id: number;
    instanceId: number;
    title: string;
    /** Cut to DESCRIPTION_LIMIT. For showing a person, never for searching. */
    description: string | null;
    /**
     * Title, the FULL description, tags, departments and location, lowercased.
     * Separate from `description`, which is truncated for display: searching
     * that found 2 of 6 free-food events and 2 of 11 mentioning mental health,
     * because UT puts those phrases at the end. Not returned to the client.
     */
    searchText: string;
    /** ISO 8601 with a Central offset, as Localist publishes it. */
    start: string;
    end: string | null;
    allDay: boolean;
    locationName: string | null;
    room: string | null;
    address: string | null;
    latitude: number | null;
    longitude: number | null;
    /**
     * Where the coordinate came from. "building" means the feed had none and it
     * was resolved from the location text, so it is the building, not the room.
     */
    coordinateSource: "feed" | "building" | Precision | null;
    buildingCode: string | null;
    venue: VenueType;
    categories: string[];
    audiences: string[];
    departments: string[];
    tags: string[];
    /** The calendar marks this cancelled. Excluded from results by default. */
    canceled: boolean;
    /** Free admission as the calendar declares it. NOT a claim about food. */
    freeAdmission: boolean;
    ticketCost: string | null;
    streamUrl: string | null;
    url: string;
    photoUrl: string | null;
    source: "calendar.utexas.edu";
}

interface RawInstance {
    event_instance?: {
        id?: number;
        event_id?: number;
        start?: string;
        end?: string | null;
        all_day?: boolean;
    };
}

interface RawEvent {
    event?: {
        id?: number;
        title?: string;
        description_text?: string | null;
        description?: string | null;
        event_instances?: RawInstance[];
        location_name?: string | null;
        location?: string | null;
        room_number?: string | null;
        address?: string | null;
        // Localist sends these as strings, and as null far more often than the
        // field's presence suggests: about half the feed has no coordinate.
        geo?: { latitude?: string | null; longitude?: string | null } | null;
        experience?: string | null;
        free?: boolean | null;
        ticket_cost?: string | null;
        stream_url?: string | null;
        // "live" | "canceled". Missed on the first pass, which meant a
        // cancelled roundtable was rendered exactly like a live event.
        status?: string | null;
        urlname?: string | null;
        photo_url?: string | null;
        tags?: string[] | null;
        departments?: { name?: string }[] | null;
        filters?: Record<string, { name?: string }[] | undefined> | null;
    };
}

interface RawPage {
    events?: RawEvent[];
    page?: { current?: number; total?: number; total_items?: number };
}

function names(list: { name?: string }[] | undefined): string[] {
    // Array.isArray, not `?? []`: upstream sending an object here used to throw
    // `(list ?? []).map is not a function` at the client.
    if (!Array.isArray(list)) return [];
    return list
        .map((entry) => (entry && typeof entry === "object" ? entry.name : undefined))
        .filter((name): name is string => typeof name === "string" && name.length > 0);
}

/** Coordinates arrive as strings, and "0" is not a campus. `bound` is per axis. */
function coordinate(value: string | null | undefined, bound: number): number | null {
    if (value === null || value === undefined || value === "") return null;
    const n = Number(value);
    if (!Number.isFinite(n) || n === 0) return null;
    return Math.abs(n) <= bound ? n : null;
}

function venueOf(experience: string | null | undefined): VenueType {
    const value = (experience ?? "").toLowerCase();
    return value === "virtual" || value === "hybrid" ? value : "inperson";
}

/** `description_text` is plain; `description` is HTML and needs stripping. */
const DESCRIPTION_LIMIT = 400;

/**
 * DESCRIPTION_LIMIT is a display budget; this is the search budget, which has
 * to be bigger. Longest description in a 60-day pull is 7,583 characters and
 * two exceed 4,000, so a 4,000 cap cut real text out of search.
 */
const SEARCH_TEXT_LIMIT = 8_000;

/** The full plain-text description, uncut. `describe` cuts it for display. */
function fullDescription(raw: NonNullable<RawEvent["event"]>): string {
    return (
        clean(raw.description_text ?? "") || (raw.description ? clean(text(raw.description)) : "")
    );
}

/**
 * Defensive: nothing in the feed needs it today. `res.text()` substitutes
 * U+FFFD for any byte it cannot decode, which would reach a user-facing answer.
 */
const clean = (value: string): string =>
    decode(typeof value === "string" ? value : "")
        .replace(/�/g, "")
        .trim();

/** Cuts an already-extracted description down to the display budget. */
function describe(plain: string): string | null {
    if (!plain) return null;
    return plain.length > DESCRIPTION_LIMIT
        ? `${plain.slice(0, DESCRIPTION_LIMIT).trimEnd()}...`
        : plain;
}

/** One row per occurrence: the question is always "what is on at this time". */
export function normalizeEvent(raw: RawEvent): CampusEvent[] {
    const event = raw.event;
    // typeof checks, not truthiness: a numeric title reached `.replace` and
    // threw "value.replace is not a function" at the client.
    if (!event || typeof event !== "object") return [];
    if (typeof event.id !== "number" || typeof event.title !== "string" || !event.title) return [];

    const locationName = event.location_name?.trim() || event.location?.trim() || null;
    const room = event.room_number?.trim() || null;

    const feedLat = coordinate(event.geo?.latitude, 90);
    const feedLng = coordinate(event.geo?.longitude, 180);

    // Prefer the room reference: "Ann Hartness Reading Room (SRH 1.106)" names
    // a building where "The University of Texas at Austin" does not.
    const resolved =
        feedLat === null || feedLng === null
            ? (resolveBuilding(room) ?? resolveBuilding(locationName))
            : null;

    const latitude = feedLat ?? resolved?.building.latitude ?? null;
    const longitude = feedLng ?? resolved?.building.longitude ?? null;

    const filters = event.filters ?? {};
    const plainDescription = fullDescription(event);
    const title = clean(event.title);
    const tags = Array.isArray(event.tags)
        ? event.tags.filter((tag): tag is string => typeof tag === "string" && tag.length > 0)
        : [];
    const departments = names(event.departments ?? undefined);
    const common = {
        id: event.id,
        title,
        description: describe(plainDescription),
        // Built from the FULL description, not the truncated one. Joined with
        // newlines so a word-start match cannot straddle two fields.
        searchText: [
            title,
            plainDescription.slice(0, SEARCH_TEXT_LIMIT),
            ...tags,
            ...departments,
            locationName ?? "",
            room ?? "",
        ]
            .filter(Boolean)
            .join("\n")
            .toLowerCase(),
        locationName,
        room,
        address: event.address?.trim() || null,
        latitude,
        longitude,
        coordinateSource:
            feedLat !== null && feedLng !== null
                ? ("feed" as const)
                : resolved
                  ? ("building" as const)
                  : null,
        buildingCode: resolved?.building.code ?? null,
        venue: venueOf(event.experience),
        categories: names(filters["event_types"]),
        audiences: names(filters["event_target_audience"]),
        departments,
        tags,
        canceled: (event.status ?? "live").toLowerCase() !== "live",
        freeAdmission: event.free === true,
        ticketCost: event.ticket_cost?.trim() || null,
        streamUrl: event.stream_url?.trim() || null,
        url: eventUrl(event.urlname ?? null, event.id),
        photoUrl: event.photo_url?.trim() || null,
        source: "calendar.utexas.edu" as const,
    };

    const out: CampusEvent[] = [];
    // Array.isArray, because an object here is not iterable and used to throw
    // "object is not iterable" straight at the client.
    const instances = Array.isArray(event.event_instances) ? event.event_instances : [];
    for (const wrapper of instances) {
        const instance = wrapper?.event_instance;
        if (!instance?.start || typeof instance.start !== "string") continue;
        out.push({
            ...common,
            instanceId: instance.id ?? event.id,
            start: instance.start,
            end: instance.end ?? null,
            allDay: instance.all_day === true,
        });
    }
    return out;
}

export interface CalendarResult {
    events: CampusEvent[];
    /** What Localist says exists, which can exceed what MAX_PAGES fetched. */
    totalItems: number;
    pagesFetched: number;
    truncated: boolean;
}

/** Cached whole, not per page: a partial set would answer a later call with a prefix. */
export async function getCalendar(days: number, groupId?: number): Promise<CalendarResult> {
    const key = `calendar:v${CACHE_VERSION}:${days}:${groupId ?? "all"}`;
    return cached(key, TTL_SECONDS, async () => {
        // `events` is non-optional here: `readPage` has already proved it is an
        // array, and carrying the optional type forward costs a `?? []` at every
        // use, which is where a silent empty page would hide.
        type FetchedPage = { events: RawEvent[]; page?: RawPage["page"] };
        const readPage = async (page: number): Promise<FetchedPage> => {
            const body = await getText(calendarUrl({ days, page, groupId }), TTL_SECONDS);
            let parsed: RawPage;
            try {
                parsed = JSON.parse(body) as RawPage;
            } catch {
                throw new Error(
                    "UT's calendar returned something that is not JSON. It may be down.",
                );
            }
            if (!parsed || typeof parsed !== "object") {
                throw new Error("UT's calendar returned an empty response. It may be down.");
            }
            // Array.isArray and a per-row type check, because upstream sending
            // `events: {}` or `events: [null]` used to surface a raw TypeError
            // ("object is not iterable") as the tool's error message.
            if (!Array.isArray(parsed.events)) {
                throw new Error("UT's calendar returned no event list. It may be having trouble.");
            }
            return { events: parsed.events, page: parsed.page };
        };

        const first = await readPage(1);
        // Localist's page.total is a count of PAGES, not of events; total_items
        // is the event count. Reading the wrong one stops after a single page.
        const totalPages = first.page?.total ?? 1;
        const totalItems = first.page?.total_items ?? 0;
        const wanted = Math.min(totalPages, MAX_PAGES);

        // Page 1 reports the page count, so the rest go out together: a 12-page
        // pull is 2 round trips, not 12. No "stop if page 1 was short" check --
        // `page.total` is authoritative and guessing lost half the calendar.
        const rest =
            wanted > 1
                ? await Promise.all(Array.from({ length: wanted - 1 }, (_, i) => readPage(i + 2)))
                : [];

        const events: CampusEvent[] = [];
        for (const parsed of [first, ...rest]) {
            for (const raw of parsed.events) {
                if (raw && typeof raw === "object") events.push(...normalizeEvent(raw));
            }
        }

        events.sort((a, b) => a.start.localeCompare(b.start) || a.instanceId - b.instanceId);
        return {
            events,
            totalItems,
            pagesFetched: 1 + rest.length,
            truncated: totalPages > MAX_PAGES,
        };
    });
}

export interface EventFilters {
    from?: Date;
    to?: Date;
    query?: string;
    /** Let a short query match a longer word. See `matchesQuery`. */
    looseQuery?: boolean;
    categories?: string[];
    audiences?: string[];
    venue?: VenueType;
    department?: string;
    freeAdmission?: boolean;
    /** Cancelled events are excluded unless this is true. */
    includeCanceled?: boolean;
    /** Drop events known to be away from Austin. Unknown is kept, not dropped. */
    onCampusOnly?: boolean;
}

/** Trim as well as lowercase: `" Academics"` passed validation and matched nothing. */
const lower = (list: string[]) => list.map((value) => value.trim().toLowerCase());

/**
 * Anchored at a word START, over the full search text. A plain substring was
 * wrong both ways: `query: "AI"` matched "Chair" and returned 48 of a week's
 * 105 events, while searching the display truncation missed 9 of 11 events
 * mentioning mental health. The open end keeps "engineer" finding
 * "engineering".
 */
function queryPattern(needle: string, loose: boolean): RegExp | null {
    // `\b` only works next to a word character, so a needle led by punctuation
    // gets a plain substring test instead. "c++" is led by "c" and so comes
    // through here, escaped.
    if (!/^[a-z0-9]/.test(needle)) return null;
    const words = needle.split(/[^a-z0-9]+/).filter(Boolean);
    if (!words.length) return null;
    const escape = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    // Flexible between words, so "pre-med" finds "premed" and "women's" matches
    // whichever apostrophe the client typed. Never a newline: searchText joins
    // the fields with them so a phrase cannot straddle two fields.
    const body = words.map(escape).join("[^a-z0-9\\n]*");

    // A short needle is an acronym: an open prefix made "AI" match "aid" and
    // "air", but a bare boundary stopped "art" seeing "Arts". Plural only.
    const tail = !loose && words.length === 1 && needle.length <= 3 ? "(?:e?s)?(?![a-z])" : "";
    return new RegExp(`\\b${body}${tail}`);
}

/**
 * `loose` drops the short-needle restriction, so "bio" reaches "biology". The
 * caller retries with it only when the strict pass found nothing, and says so.
 */
function matchesQuery(event: CampusEvent, query: string, loose = false): boolean {
    const needle = query.trim().toLowerCase();
    if (!needle) return true;
    const pattern = queryPattern(needle, loose);
    if (!pattern) return event.searchText.includes(needle);
    if (pattern.test(event.searchText)) return true;
    // Second look with punctuation removed, so "premed" finds "Pre-Med" too. UT
    // writes it both ways. Spaces and newlines stay, so boundaries still hold.
    return /^[a-z0-9]+$/.test(needle)
        ? pattern.test(event.searchText.replace(/[^a-z0-9\s]/g, ""))
        : false;
}

export function filterEvents(events: CampusEvent[], filters: EventFilters): CampusEvent[] {
    const wantCategories = lower(filters.categories ?? []);
    const wantAudiences = lower(filters.audiences ?? []);
    const department = filters.department?.trim().toLowerCase();

    return events.filter((event) => {
        // First, because a cancelled event is not happening and showing it as
        // if it were is the worst answer this tool can give.
        if (event.canceled && !filters.includeCanceled) return false;
        const startMs = Date.parse(event.start);
        // An unparseable date cannot be placed in a window, and letting it
        // through would put it wherever the sort happened to leave it.
        if (!Number.isFinite(startMs)) return false;
        // Compared against the END, or a talk that began an hour ago drops out of
        // "what is on now". With no end: all-day events are midnight with end
        // null, so assume a day; a timed event with no end gets an hour.
        const ASSUMED_DURATION_MS = 3_600_000;
        const DAY_MS = 86_400_000;
        const parsedEnd = event.end ? Date.parse(event.end) : NaN;
        const endMs = Number.isFinite(parsedEnd)
            ? parsedEnd
            : startMs + (event.allDay ? DAY_MS : ASSUMED_DURATION_MS);
        // `<=`, not `<`: an event that ends exactly when the window opens is
        // over. An all-day event on the 9th ends at the instant the 10th
        // begins, and with `<` every one of them also showed up in "tomorrow".
        if (filters.from && endMs <= filters.from.getTime()) return false;
        // `>=`, not `>`: the window's upper bound is the instant the NEXT day
        // begins, which is exactly when an all-day event on that next day
        // starts. With `>` a one-day window reported the following day's
        // all-day events, and `occurrences` counted a day outside the window.
        if (filters.to && startMs >= filters.to.getTime()) return false;

        if (filters.query && !matchesQuery(event, filters.query, filters.looseQuery)) return false;
        if (
            wantCategories.length &&
            !event.categories.some((category) => wantCategories.includes(category.toLowerCase()))
        ) {
            return false;
        }
        if (
            wantAudiences.length &&
            !event.audiences.some((audience) => wantAudiences.includes(audience.toLowerCase()))
        ) {
            return false;
        }
        if (filters.venue && event.venue !== filters.venue) return false;
        if (department && !event.departments.some((d) => d.toLowerCase().includes(department))) {
            return false;
        }
        if (filters.freeAdmission && !event.freeAdmission) return false;
        // Only a known false is excluded. Dropping unknowns here would throw
        // away every event with no location, which is a lot of real ones.
        if (filters.onCampusOnly && onCampus(event) === false) return false;
        return true;
    });
}

/**
 * Localist has no free-food field; its `free` flag means free ADMISSION. So
 * this is a text heuristic and any answer built on it has to say so.
 * Deliberately narrow: "lunch will be provided" counts, "lunch" does not.
 */
const FOOD_PHRASES = [
    /\bfree\s+(food|pizza|lunch|breakfast|dinner|snacks?|refreshments?|coffee|donuts?|tacos?|boba)\b/i,
    /\b(food|pizza|lunch|breakfast|dinner|snacks?|refreshments?|coffee|donuts?|tacos?|boba)\s+(will\s+be\s+)?(provided|served)\b/i,
    /\b(lunch|breakfast|dinner|refreshments?|snacks?)\s+(is|are)\s+included\b/i,
    /\bcomplimentary\s+(food|lunch|breakfast|dinner|refreshments?|snacks?|coffee)\b/i,
];

export function mentionsFreeFood(event: CampusEvent): boolean {
    // `searchText`, not `description`: the phrase is usually the last line of a
    // long description, so against the 400-character display cut this found 2
    // of the 6 events in a 60-day pull that say food is provided. UT writes
    // "Lunch will be provided." at character 1,030 of 1,100.
    return FOOD_PHRASES.some((pattern) => pattern.test(event.searchText));
}

/** Main campus, near the Tower. Only used for an is-it-even-in-Austin test. */
const CAMPUS_CENTRE = { latitude: 30.2849, longitude: -97.7341 };

/**
 * Deliberately generous: 15 km keeps every UT site in the Austin area,
 * including the Pickle Research Campus about 10 km north, and still catches a
 * road game in another state.
 */
const AUSTIN_RADIUS_M = 15_000;

/**
 * Out-of-state road games, which UT publishes on its own calendar: "Lincoln,
 * Neb., Sid and Hazel Dillon Tennis Center" is a real UT event 1,200 km away.
 * Both spellings are needed -- tennis uses AP abbreviations, basketball writes
 * "Louisville, Kentucky" in full. `geo.state` is null on every one of these.
 */
const STATE_ABBREVIATIONS =
    "Ala|Ariz|Ark|Calif|Colo|Conn|Del|Fla|Ga|Ill|Ind|Kan|Ky|La|Md|Mass|Mich|Minn|Miss|Mo|Mont|" +
    "Neb|Nev|Okla|Ore|Pa|Tenn|Va|Vt|Wash|Wis|Wyo|N\\.?\\s?[CYJMDH]|S\\.?\\s?[CD]";

const STATE_NAMES =
    "Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|Florida|Georgia|" +
    "Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|" +
    "Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|New Hampshire|New Jersey|" +
    "New Mexico|New York|North Carolina|North Dakota|Ohio|Oklahoma|Oregon|Pennsylvania|" +
    "Rhode Island|South Carolina|South Dakota|Tennessee|Utah|Vermont|Virginia|Washington|" +
    "West Virginia|Wisconsin|Wyoming";

/**
 * Two alternatives with their own anchors: there is no word boundary between
 * "." and " ", so one trailing \b matched none of the abbreviations.
 */
const NON_TEXAS = new RegExp(`\\b(?:${STATE_ABBREVIATIONS})\\.|\\b(?:${STATE_NAMES})\\b`, "i");

/**
 * Is this on or near campus? `null` means unknown, which is most events with
 * no location at all, and is reported as unknown rather than guessed either way.
 */
export function onCampus(event: CampusEvent): boolean | null {
    if (event.latitude !== null && event.longitude !== null) {
        return (
            metresBetween(CAMPUS_CENTRE, {
                latitude: event.latitude,
                longitude: event.longitude,
            }) <= AUSTIN_RADIUS_M
        );
    }
    const where = [event.locationName, event.room, event.address].filter(Boolean).join(" ");
    if (!where) return null;
    if (NON_TEXAS.test(where)) return false;
    const awayCity = texasCityAwayFromAustin(event.locationName);
    return awayCity ? false : null;
}

/**
 * In-state road games, which the state tests cannot see: rows read "City,
 * Texas, Venue" on both sides of the line, so `onCampusOnly` kept Kyle Field.
 * Home rows are always "Austin, Texas, <venue>". Only `locationName`, because
 * an address legitimately contains "Austin, Texas" after a street.
 */
function texasCityAwayFromAustin(locationName: string | null): boolean {
    if (!locationName) return false;
    const match = /^\s*([^,]+?)\s*,\s*Tex(?:as)?\s*(?:,|$)/i.exec(locationName);
    if (!match) return false;
    return match[1]!.trim().toUpperCase() !== "AUSTIN";
}

/**
 * One row per event, not one per day it is open. Localist repeats a multi-day
 * event once per day of the window: a 7-day pull is 236 rows and 153 events, so
 * "this week" answered 245 and spent `limit` on repeats. Keeps the earliest
 * occurrence and a day count. Expects a filtered, sorted list.
 */
export interface Collapsed {
    event: CampusEvent;
    /** Days in the window this event appears on, including the one kept. */
    occurrences: number;
    /** Start of the last occurrence in the window, or null if there is one. */
    lastStart: string | null;
}

export function collapseSeries(events: CampusEvent[]): Collapsed[] {
    const byId = new Map<number, Collapsed>();
    for (const event of events) {
        const seen = byId.get(event.id);
        if (!seen) {
            byId.set(event.id, { event, occurrences: 1, lastStart: null });
            continue;
        }
        seen.occurrences++;
        // The list is sorted, so the newest one seen is the latest so far.
        seen.lastStart = event.start;
    }
    return [...byId.values()];
}
