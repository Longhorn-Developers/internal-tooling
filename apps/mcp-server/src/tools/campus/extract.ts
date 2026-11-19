// Reads UT's Localist calendar. `source` is on every event so a Longhorn Loop
// provider can be added alongside later.

import { cached, decode, getText, text } from "../../shared.ts";
import { metresBetween, resolveBuilding, type Precision } from "./buildings.ts";
import { calendarUrl, eventUrl } from "./urls.ts";

/** Bump on any shape or derived-content change: the CF cache outlives a deploy. */
const CACHE_VERSION = 1;

/** Windows round up to one of these, so common phrasings share a cache entry. */
const DAY_BUCKETS = [2, 8, 16, 31, 61];

/** 30 minutes. The calendar is edited by hand; it does not move minute to minute. */
const TTL_SECONDS = 1_800;

/** A Worker invocation gets 50 subrequests and this is not the only tool in it. */
const MAX_PAGES = 12;

/** Bounded by MAX_PAGES, not by Localist, which accepts up to 370 days. */
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

export const VENUE_TYPES = ["inperson", "virtual", "hybrid", "unknown"] as const;
export type VenueType = (typeof VENUE_TYPES)[number];

/** Austin's UTC offset at a given instant, in minutes behind UTC. */
export function austinOffsetMinutes(at: Date): number {
    const name = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Chicago",
        timeZoneName: "longOffset",
    })
        .formatToParts(at)
        .find((part) => part.type === "timeZoneName")?.value;
    const match = /GMT([+-])(\d{2}):(\d{2})/.exec(name ?? "");
    if (!match) return 360; // CST, the safe assumption if the runtime surprises us
    const sign = match[1] === "-" ? 1 : -1;
    return sign * (Number(match[2]) * 60 + Number(match[3]));
}

/** An instant from an Austin wall-clock reading. */
export function austinInstant(
    year: number,
    month: number,
    day: number,
    hour: number,
    minute = 0,
): Date {
    const guess = Date.UTC(year, month - 1, day, hour, minute);
    const first = new Date(guess + austinOffsetMinutes(new Date(guess)) * 60_000);
    // One correction pass, for a DST changeover day.
    return new Date(guess + austinOffsetMinutes(first) * 60_000);
}

/**
 * Sorts by INSTANT, not by string.
 *
 * `start` is ISO 8601, and two sources writing the same moment as
 * "...T14:00:00Z" and "...T08:00:00-06:00" sort six hours apart under a string
 * compare. That put Law and Cockrell rows in the wrong place in every merged
 * answer, and made them the first thing dropped when `limit` bit.
 */
export const byStart = (a: CampusEvent, b: CampusEvent): number =>
    Date.parse(a.start) - Date.parse(b.start) || a.instanceId - b.instanceId;

/**
 * An instant as ISO 8601 with Austin's offset, which is the form
 * `CampusEvent.start` promises. `toISOString()` gives the Z form instead.
 */
export function centralIso(at: Date): string {
    const offset = austinOffsetMinutes(at);
    const local = new Date(at.getTime() - offset * 60_000);
    const sign = offset <= 0 ? "+" : "-";
    const abs = Math.abs(offset);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${local.toISOString().slice(0, 19)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** Every calendar find_events reads. One per provider. */
export type EventSource =
    | "calendar.utexas.edu"
    | "apps.cs.utexas.edu"
    | "law.utexas.edu"
    | "calendar.mccombs.utexas.edu"
    | "cockrell.utexas.edu";

export interface CampusEvent {
    id: number;
    instanceId: number;
    title: string;
    /** Cut to DESCRIPTION_LIMIT. For showing a person, never for searching. */
    description: string | null;
    /** Title, the FULL description, tags, departments and location, lowercased. */
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
    /** Where the coordinate came from. */
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
    /** Which calendar this came from. */
    source: EventSource;
    /**
     * Groups occurrences of one recurring event, when the source numbers each
     * occurrence separately. McCombs does: "Let's Talk MSTC" is 13 rows with 13
     * ids, which filled a third of a default answer with the same meeting.
     */
    seriesKey?: string;
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
        // Strings, and null for about half the feed.
        geo?: { latitude?: string | null; longitude?: string | null } | null;
        experience?: string | null;
        free?: boolean | null;
        ticket_cost?: string | null;
        stream_url?: string | null;
        // "live" | "canceled".
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
    // Array.isArray, not `?? []`: an object here threw at the client.
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

/** DESCRIPTION_LIMIT is a display budget; this is the search budget, which has to be bigger. */
const SEARCH_TEXT_LIMIT = 8_000;

/** The full plain-text description, uncut. `describe` cuts it for display. */
function fullDescription(raw: NonNullable<RawEvent["event"]>): string {
    return (
        clean(raw.description_text ?? "") || (raw.description ? clean(text(raw.description)) : "")
    );
}

/** Strips U+FFFD, which `res.text()` substitutes for any byte it cannot decode. */
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
    // typeof, not truthiness: a numeric title reached `.replace` and threw.
    if (!event || typeof event !== "object") return [];
    if (typeof event.id !== "number" || typeof event.title !== "string" || !event.title) return [];

    const locationName = event.location_name?.trim() || event.location?.trim() || null;
    const room = event.room_number?.trim() || null;

    const feedLat = coordinate(event.geo?.latitude, 90);
    const feedLng = coordinate(event.geo?.longitude, 180);

    // Prefer the room reference: "Reading Room (SRH 1.106)" names a building
    // where "The University of Texas at Austin" does not.
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
        // Built from the FULL description, not the truncated one.
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
    // An object here is not iterable and threw straight at the client.
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

/**
 * The shared parts of an event, so each provider only supplies what it knows.
 *
 * Lives here rather than in a provider because three of them need it and the
 * CS one had its own copy of the same twenty literal fields.
 */
export function buildEvent(opts: {
    id: number;
    instanceId?: number;
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
    venue?: VenueType;
    freeAdmission?: boolean;
    seriesKey?: string;
}): CampusEvent {
    const room = opts.room?.trim() || null;
    const resolved = room ? resolveBuilding(room) : null;
    const plain = opts.description?.trim() || null;
    return {
        id: opts.id,
        // Defaults to the event id. A source that publishes one row per
        // occurrence passes its own, so two occurrences of a weekly meeting
        // stay distinct rows under the same `id`.
        instanceId: opts.instanceId ?? opts.id,
        title: opts.title,
        description:
            plain && plain.length > DESCRIPTION_LIMIT
                ? `${plain.slice(0, DESCRIPTION_LIMIT).trimEnd()}...`
                : plain,
        // The department is in here because the `query` parameter promises to
        // match it, and only the central calendar was honouring that: a
        // `query: "school of law"` found nothing while `department` found ten.
        searchText: [
            opts.title,
            (plain ?? "").slice(0, SEARCH_TEXT_LIMIT),
            room ?? "",
            opts.department,
        ]
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
        venue: opts.venue ?? "inperson",
        categories: [],
        audiences: [],
        departments: [opts.department],
        tags: [],
        canceled: opts.canceled ?? false,
        freeAdmission: opts.freeAdmission ?? false,
        ticketCost: null,
        streamUrl: null,
        url: opts.url,
        photoUrl: null,
        source: opts.source,
        seriesKey: opts.seriesKey,
    };
}

/** Stable positive id from a feed's own string id. */
export function hashId(value: string): number {
    let h = 0;
    for (let i = 0; i < value.length; i++) h = (h * 31 + value.charCodeAt(i)) | 0;
    return Math.abs(h) || 1;
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
    // Bucketed, not exact: "today" (2), "this week" (8) and every ISO date
    // produced its own `days` and so its own cold fetch, and a cold 60-day
    // window took 9-16 seconds. Rounding up means the common phrasings share an
    // entry, at the cost of fetching a few days more than asked for.
    //
    // The FETCH uses the bucket too. Keying on the bucket while fetching `days`
    // would let a 21-day request populate the 31-day entry with 21 days of
    // data, and the next 31-day caller would silently get the short answer.
    const bucket = DAY_BUCKETS.find((b) => b >= days) ?? days;
    const key = `calendar:v${CACHE_VERSION}:${bucket}:${groupId ?? "all"}`;
    return cached(key, TTL_SECONDS, async () => {
        // Non-optional: `readPage` has proved it is an array, and a `?? []` at
        // every use is where an empty page would hide.
        type FetchedPage = { events: RawEvent[]; page?: RawPage["page"] };
        const readPage = async (page: number): Promise<FetchedPage> => {
            const body = await getText(calendarUrl({ days: bucket, page, groupId }), TTL_SECONDS);
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
            // `events: {}` or `[null]` surfaced a raw TypeError as the answer.
            if (!Array.isArray(parsed.events)) {
                throw new Error("UT's calendar returned no event list. It may be having trouble.");
            }
            return { events: parsed.events, page: parsed.page };
        };

        const first = await readPage(1);
        // Localist's page.total is a count of PAGES, not of events; total_items is the event count.
        const totalPages = first.page?.total ?? 1;
        const totalItems = first.page?.total_items ?? 0;
        const wanted = Math.min(totalPages, MAX_PAGES);

        // Page 1 reports the page count, so the rest go out together.
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

        events.sort(byStart);
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

/**
 * How a student writes a department, mapped to how a calendar publishes it.
 *
 * The filter is a substring match, and "computer science".includes("cs") is
 * false, so `department: "CS"` answered "Nothing on UT's calendar" with seven CS
 * events in hand. These are the four sources with their own calendar.
 */
const DEPARTMENT_ALIASES: Record<string, string> = {
    cs: "computer science",
    utcs: "computer science",
    compsci: "computer science",
    law: "school of law",
    "texas law": "school of law",
    business: "mccombs",
    mba: "mccombs",
    engineering: "cockrell",
    engr: "cockrell",
    "comp sci": "computer science",
    "law school": "school of law",
    "computer sciences": "computer science",
};

/**
 * Resolves an alias, else trims and lowercases.
 *
 * The lookup ignores punctuation and spacing, so "comp sci", "CS Department"
 * and "law school" land on the same entry as "cs" and "law". An exact-match
 * table answered "nothing" for all three.
 */
function departmentTerm(raw: string | undefined): string {
    const value = raw?.trim().toLowerCase() ?? "";
    if (!value) return "";
    const squeeze = (v: string) => v.replace(/[^a-z0-9]/g, "");
    const key = squeeze(value);
    for (const [alias, full] of Object.entries(DEPARTMENT_ALIASES)) {
        const a = squeeze(alias);
        // The alias, optionally with a word like "department" or "school"
        // around it, but not an unrelated string that merely contains it.
        if (key === a || key === `${a}department` || key === `${a}school`) return full;
    }
    return value;
}

/** Trim as well as lowercase: `" Academics"` passed validation and matched nothing. */
const lower = (list: string[]) => list.map((value) => value.trim().toLowerCase());

/** Anchored at a word start, over the full search text. */
/**
 * Diacritics folded, so the ASCII spelling of a name works.
 *
 * `query: "anzaldua"` found nothing while the exhibition is published as
 * "Gloria Anzaldua's Borderlands" with an accent -- and UT's own URL slug for
 * it is ASCII. Same for "So Percussion", marketed without the macron.
 */
const fold = (value: string): string => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

export function queryPattern(needle: string, loose = false): RegExp | null {
    // `\b` needs a word character, so a punctuation-led needle falls back.
    if (!/^[a-z0-9]/.test(needle)) return null;
    const words = needle.split(/[^a-z0-9]+/).filter(Boolean);
    if (!words.length) return null;
    const escape = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    // Flexible between words: "pre-med" finds "premed", and either apostrophe.
    const body = words.map(escape).join("[^a-z0-9\\n]*");

    // An open prefix made "AI" match "aid"; a bare boundary hid "Arts" from "art".
    const tail = !loose && words.length === 1 && needle.length <= 3 ? "(?:e?s)?(?![a-z])" : "";
    return new RegExp(`\\b${body}${tail}`);
}

/** `loose` drops the short-needle restriction, so "bio" reaches "biology". */
function matchesQuery(event: CampusEvent, query: string, loose = false): boolean {
    const needle = fold(query.trim().toLowerCase());
    if (!needle) return true;
    const haystack = fold(event.searchText);
    const pattern = queryPattern(needle, loose);
    if (!pattern) return haystack.includes(needle);
    if (pattern.test(haystack)) return true;

    // Then as ALL of the words, in any order. Joining them with "no
    // alphanumerics between" meant a two-word query was a strict phrase, so
    // `query: "football arkansas"` answered "Nothing on UT's calendar" on a day
    // UT played Arkansas -- the title reads "Football vs Arkansas" and the "vs"
    // defeated it. The phrase form is tried first, so an exact phrase still
    // matches.
    //
    // Against the title and body only, not the whole search text: with the
    // department in scope, "art history" matched three College of Liberal ARTS
    // events whose description happened to contain "history", and "computer
    // lab" matched three Computer Science "Lab meeting" rows.
    const words = needle.split(/[^a-z0-9]+/).filter(Boolean);
    const narrow = fold(event.searchText.split("\n").slice(0, 2).join("\n"));
    const allWords = (text: string) =>
        words.length > 1 &&
        words.map((word) => queryPattern(word, loose)).every((p) => p && p.test(text));
    if (allWords(narrow)) return true;

    // Then the same two passes with the TEXT's punctuation removed, so
    // "premed" finds "Pre-Med" and "mens basketball" finds "Men's Basketball".
    // This retry used to be gated to a single word, which is why a two-word
    // query still lost to an apostrophe -- the same defeat as the adjacency
    // bug, one character further in.
    const strip = (text: string) => text.replace(/[^a-z0-9\s]/g, "");
    if (pattern.test(strip(haystack))) return true;
    return allWords(strip(narrow));
}

export function filterEvents(events: CampusEvent[], filters: EventFilters): CampusEvent[] {
    const wantCategories = lower(filters.categories ?? []);
    const wantAudiences = lower(filters.audiences ?? []);
    const department = departmentTerm(filters.department);
    // Kept only when it differs, so the common case does no extra work.
    const literal = filters.department?.trim().toLowerCase() ?? "";
    const departmentLiteral = literal && literal !== department ? literal : "";

    return events.filter((event) => {
        // First: showing a cancelled event as if it were on is the worst answer.
        if (event.canceled && !filters.includeCanceled) return false;
        const startMs = Date.parse(event.start);
        // An unparseable date would land wherever the sort left it.
        if (!Number.isFinite(startMs)) return false;
        // Compared against the END, or a talk that began an hour ago drops out of "what is on now".
        const ASSUMED_DURATION_MS = 3_600_000;
        const DAY_MS = 86_400_000;
        const parsedEnd = event.end ? Date.parse(event.end) : NaN;
        const endMs = Number.isFinite(parsedEnd)
            ? parsedEnd
            : startMs + (event.allDay ? DAY_MS : ASSUMED_DURATION_MS);
        // `<=`, not `<`: an event that ends exactly when the window opens is over.
        if (filters.from && endMs <= filters.from.getTime()) return false;
        // `>=`: the bound is the instant the next day begins, which is when its
        // all-day events start.
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
        // The alias target OR the literal word. "engineering" resolves to
        // "cockrell", which denied the Oden Institute for Computational Engineering
        // while printing its name in the same sentence.
        if (
            department &&
            !event.departments.some(
                (d) =>
                    d.toLowerCase().includes(department) ||
                    (departmentLiteral && d.toLowerCase().includes(departmentLiteral)),
            )
        ) {
            return false;
        }
        if (filters.freeAdmission && !event.freeAdmission) return false;
        // Only a known false is excluded.
        if (filters.onCampusOnly && onCampus(event) === false) return false;
        return true;
    });
}

/** Localist has no free-food field; its `free` flag means free ADMISSION. */
const FOOD_PHRASES = [
    /\bfree\s+(food|pizza|lunch|breakfast|dinner|snacks?|refreshments?|coffee|donuts?|tacos?|boba)\b/i,
    // Up to three words between the noun and the verb, so "food and drinks
    // will be provided" and "pastries, coffee and tea are served" count.
    /\b(food|pizza|lunch|breakfast|dinner|snacks?|refreshments?|pastries|coffee|donuts?|tacos?|boba)\b(?:[\s,]+\w+){0,3}[\s,]+(will\s+be\s+|are\s+|is\s+)?(provided|served)\b/i,
    // And the verb-first form: "we will be providing food", "we provide bagels".
    /\b(provid\w*|serv\w*)\b(?:[\s,:-]+\w+){0,3}[\s,:-]+(food|pizza|lunch|breakfast|dinner|snacks?|refreshments?|pastries|bagels|donuts?|tacos?|boba)\b/i,
    /\b(lunch|breakfast|dinner|refreshments?|snacks?)\s+(is|are)\s+included\b/i,
    /\bcomplimentary\s+(food|lunch|breakfast|dinner|refreshments?|snacks?|coffee)\b/i,
    // "we will have pizza", "there will be snacks", "come enjoy food and
    // drinks", "grab snacks", "a pancake buffet". These are the commonest
    // phrasings on UT's calendar and none of the patterns above accepts them,
    // so finals week -- the week a student most wants this -- answered nothing.
    /\b(we(?:'ll|\s+will)?\s+have|there\s+(?:will\s+be|are|is)|enjoy|grab|serving)\b(?:[\s,:-]+\w+){0,3}[\s,:-]+(food|pizza|lunch|breakfast|dinner|snacks?|refreshments?|pastries|bagels|donuts?|tacos?|boba|drinks)\b/i,
    /\b(pancake|pizza|taco|coffee|breakfast|dessert|ice\s+cream)\s+(buffet|bar|social|study\s+break)\b/i,
];

export function mentionsFreeFood(event: CampusEvent): boolean {
    // `searchText`, not `description`: the phrase is usually the last line, so
    // the display cut found 2 of 6.
    return FOOD_PHRASES.some((pattern) => pattern.test(event.searchText));
}

/** Main campus, near the Tower. Only used for an is-it-even-in-Austin test. */
const CAMPUS_CENTRE = { latitude: 30.2849, longitude: -97.7341 };

/** Generous: 15 km reaches the Pickle Research Campus and still excludes road games. */
const AUSTIN_RADIUS_M = 15_000;

/** Out-of-state road games. Both AP abbreviations and full state names appear. */
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

/** Separate anchors: no word boundary sits between "." and " ". */
const NON_TEXAS = new RegExp(`\\b(?:${STATE_ABBREVIATIONS})\\.|\\b(?:${STATE_NAMES})\\b`, "i");

/** Is this on or near campus?. */
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

/** In-state road games: rows read "City, Texas, Venue" either side of the line,
 * and home rows are always "Austin, Texas". `locationName` only. */
function texasCityAwayFromAustin(locationName: string | null): boolean {
    if (!locationName) return false;
    const match = /^\s*([^,]+?)\s*,\s*Tex(?:as)?\s*(?:,|$)/i.exec(locationName);
    if (!match) return false;
    return match[1]!.trim().toUpperCase() !== "AUSTIN";
}

/** One row per event. Localist repeats a multi-day event once per day of the window. */
export interface Collapsed {
    event: CampusEvent;
    /** Days in the window this event appears on, including the one kept. */
    occurrences: number;
    /** Start of the last occurrence in the window, or null if there is only one. */
    lastStart: string | null;
    /** The Austin dates seen, so `occurrences` counts days and not rows. */
    days: Set<string>;
    /**
     * Every distinct start in the window, sorted.
     *
     * Needed because days alone lose a second SHOWING on one day: "Buena Vista
     * Social Club" plays Bass Concert Hall at 2pm and 8pm, and collapsing to a
     * day reported only the matinee. Exact-instant duplicates -- the same
     * meeting published twice -- still fold into one entry here.
     */
    starts: string[];
}

export function collapseSeries(events: CampusEvent[]): Collapsed[] {
    // Keyed by SOURCE and id: five calendars number their events
    // independently, and two sharing an id would otherwise merge into one row
    // with the other's start as `lastStart`.
    const byId = new Map<string, Collapsed>();
    for (const event of events) {
        // `seriesKey` lets a source that numbers every occurrence separately
        // say so; the default is the event's own id.
        const key = `${event.source}:${event.seriesKey ?? event.id}`;
        const seen = byId.get(key);
        if (!seen) {
            byId.set(key, {
                event,
                occurrences: 1,
                lastStart: null,
                days: new Set([event.start.slice(0, 10)]),
                starts: [event.start],
            });
            continue;
        }
        // Distinct DAYS, which is what the schema and the rendered text both
        // promise. Counting rows said "runs on 2 days" inside a one-day window
        // for two duplicate rows at the same instant.
        seen.days.add(event.start.slice(0, 10));
        seen.occurrences = seen.days.size;
        if (!seen.starts.includes(event.start)) seen.starts.push(event.start);
        // Only when there IS a later one. Setting it unconditionally left
        // `occurrences: 1` beside a non-null `lastStart`, which is the
        // fingerprint of a dropped showing.
        // Gated on DAYS, matching what the field documents. Keying it on
        // distinct times shipped `occurrences: 1` beside a non-null
        // `lastStart`, which the schema says cannot happen; a same-day second
        // showing is `alsoAt`'s job.
        seen.lastStart = seen.days.size > 1 ? seen.starts[seen.starts.length - 1]! : null;
    }
    return [...byId.values()];
}
