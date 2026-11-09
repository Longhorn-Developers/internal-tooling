// Reads UT's central Localist calendar and turns it into something a model can
// answer questions from.
//
// WHY NOT LONGHORN LOOP'S API. Loop is the club's campus-events app and the
// obvious thing to call. It serves 29 upcoming events, because 8 of its 11
// scrapers currently yield nothing (Longhorn-Developers/Longhorn-Loop#472).
// The calendar underneath it carries ~324 distinct events over 60 days. So
// this reads the source directly: no dependency on those scrapers being
// fixed, and no second hop. `source` is on every event here so a Loop
// provider can be added alongside later for the user-created events that
// exist only there.
//
// Count carefully when comparing those two numbers. A 60-day pull returns
// 1,046 ROWS but only 324 distinct event ids, because Localist repeats a
// multi-day event once per day of the window. Reading the row count as an
// event count overstates the feed by about 3x. See `collapseSeries`.

import { cached, decode, getText, text } from "../../shared.ts";
import { isNonPhysicalLocation, resolveBuilding, type Precision } from "./buildings.ts";
import { PAGE_SIZE, calendarUrl, eventUrl } from "./urls.ts";

/** 30 minutes. The calendar is edited by hand; it does not move minute to minute. */
const TTL_SECONDS = 1_800;

/**
 * Pages fetched per call, each one a subrequest.
 *
 * A Worker invocation gets 50 subrequests on the free plan and this tool is not
 * the only thing that might run in one, so 12 pages (~1,200 events, about 60
 * days) is the ceiling. Past that the answer says it was truncated rather than
 * quietly returning a prefix.
 */
const MAX_PAGES = 12;

/**
 * How far ahead one call can answer for.
 *
 * Bounded by MAX_PAGES above, not by Localist, which accepts up to 370 days
 * (and 400 gets `Date range is too big`). The tool refuses a window past this
 * rather than fetching 60 days and reporting "nothing" for a date in 2027,
 * which is what it used to do.
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
    description: string | null;
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

/**
 * Localist publishes coordinates as strings, and "0" is not a campus.
 *
 * `bound` rejects a value outside the legal range for that axis. A latitude and
 * longitude swapped upstream gives latitude -97.73, which is not a latitude at
 * all, and passing it through would put the answer's coordinate somewhere no
 * map can show.
 */
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

/**
 * Description text, bounded.
 *
 * `description_text` is Localist's own plain-text rendering and is there most of
 * the time; `description` is HTML and needs stripping. Long ones are cut because
 * a few hundred events of full abstracts is most of a context window and none
 * of it helps choose between them.
 */
const DESCRIPTION_LIMIT = 400;

/**
 * Defensive, not a response to anything in the feed.
 *
 * UT serves this endpoint as clean `application/json; charset=utf-8` and a full
 * 30-day pull contains no U+FFFD at all, so nothing here is currently needed.
 * It stays because `res.text()` substitutes U+FFFD for any byte sequence it
 * cannot decode, so a single bad byte upstream would otherwise put a black
 * diamond in a user-facing answer. `text()` in shared.ts strips the same
 * character on the HTML paths for the same reason.
 */
const clean = (value: string): string =>
    decode(typeof value === "string" ? value : "")
        .replace(/�/g, "")
        .trim();

function describe(raw: NonNullable<RawEvent["event"]>): string | null {
    const plain =
        clean(raw.description_text ?? "") || (raw.description ? clean(text(raw.description)) : "");
    if (!plain) return null;
    return plain.length > DESCRIPTION_LIMIT
        ? `${plain.slice(0, DESCRIPTION_LIMIT).trimEnd()}...`
        : plain;
}

/**
 * One row per occurrence, not per event.
 *
 * A weekly seminar is a single Localist event with an instance per week. The
 * question is always "what is on at this time", so the occurrence is the unit.
 */
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
    const common = {
        id: event.id,
        title: clean(event.title),
        description: describe(event),
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
        departments: names(event.departments ?? undefined),
        tags: Array.isArray(event.tags)
            ? event.tags.filter((tag): tag is string => typeof tag === "string" && tag.length > 0)
            : [],
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

/**
 * Fetch and normalise the calendar.
 *
 * Cached whole rather than per page: the pages only mean anything together, and
 * a partial set in the cache would answer a later call with a prefix.
 */
export async function getCalendar(days: number, groupId?: number): Promise<CalendarResult> {
    const key = `calendar:${days}:${groupId ?? "all"}`;
    return cached(key, TTL_SECONDS, async () => {
        const events: CampusEvent[] = [];
        let totalItems = 0;
        let totalPages = 1;
        let page = 1;
        // Counted rather than derived from `page`: the break below leaves the
        // loop without incrementing, so `page - 1` under-reported by one.
        let fetches = 0;

        while (page <= Math.min(totalPages, MAX_PAGES)) {
            const body = await getText(calendarUrl({ days, page, groupId }), TTL_SECONDS);
            fetches++;
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
            // Localist's page.total is a count of PAGES, not of events;
            // total_items is the event count. Reading the wrong one stops the
            // loop after a single page.
            totalPages = parsed.page?.total ?? 1;
            totalItems = parsed.page?.total_items ?? 0;
            // Array.isArray and a per-row type check, because upstream sending
            // `events: {}` or `events: [null]` used to surface a raw TypeError
            // ("object is not iterable") as the tool's error message.
            if (!Array.isArray(parsed.events)) {
                throw new Error("UT's calendar returned no event list. It may be having trouble.");
            }
            for (const raw of parsed.events) {
                if (raw && typeof raw === "object") events.push(...normalizeEvent(raw));
            }
            if (parsed.events.length < PAGE_SIZE && page >= totalPages) break;
            page++;
        }

        events.sort((a, b) => a.start.localeCompare(b.start) || a.instanceId - b.instanceId);
        return {
            events,
            totalItems,
            pagesFetched: fetches,
            truncated: totalPages > MAX_PAGES,
        };
    });
}

export interface EventFilters {
    from?: Date;
    to?: Date;
    query?: string;
    categories?: string[];
    audiences?: string[];
    venue?: VenueType;
    department?: string;
    /** Within this many metres of a resolved building. */
    near?: { latitude: number; longitude: number; metres: number };
    freeAdmission?: boolean;
    /** Cancelled events are excluded unless this is true. */
    includeCanceled?: boolean;
    onlyWithCoordinates?: boolean;
    /** Drop events known to be away from Austin. Unknown is kept, not dropped. */
    onCampusOnly?: boolean;
}

/**
 * Trim as well as lowercase.
 *
 * The tool validates a category with `.trim().toLowerCase()` and then passed the
 * raw string here, so `" Academics"` passed validation and matched nothing: a
 * 19-event answer became "nothing on UT's calendar" over one leading space.
 */
const lower = (list: string[]) => list.map((value) => value.trim().toLowerCase());

/** Case-insensitive substring over the fields a person would search by name. */
function matchesQuery(event: CampusEvent, query: string): boolean {
    const needle = query.toLowerCase();
    return (
        event.title.toLowerCase().includes(needle) ||
        (event.description?.toLowerCase().includes(needle) ?? false) ||
        event.tags.some((tag) => tag.toLowerCase().includes(needle)) ||
        event.departments.some((dept) => dept.toLowerCase().includes(needle)) ||
        (event.locationName?.toLowerCase().includes(needle) ?? false)
    );
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
        // An event is still on until it ends, so the window is compared against
        // the end. Without this a talk that began an hour ago drops out of
        // "what is on right now".
        //
        // Two cases have no end to compare against:
        //
        //   all day      Localist writes these as midnight with end null. Taken
        //                literally they are over before anyone is awake, which
        //                dropped every all-day exhibition from "today".
        //   timed, none  Assume an hour. A 7pm talk should not vanish from
        //                "tonight" at 7:01, and an hour is the shortest guess
        //                that fixes that without keeping things on all evening.
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
        if (filters.to && startMs > filters.to.getTime()) return false;

        if (filters.query && !matchesQuery(event, filters.query)) return false;
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
        if (filters.onlyWithCoordinates && (event.latitude === null || event.longitude === null)) {
            return false;
        }
        // Only a known false is excluded. Dropping unknowns here would throw
        // away every event with no location, which is a lot of real ones.
        if (filters.onCampusOnly && onCampus(event) === false) return false;
        return true;
    });
}

/**
 * Words that mean food is being served.
 *
 * Localist has no free-food field. Its `free` flag means free ADMISSION and is
 * true for 11 events in 300, none of which is about food. Loop has a real
 * `benefits` table with "Free Food" in it, and exactly one event carrying it.
 *
 * So this is a text heuristic over the title and description, and any answer
 * built on it has to say so. It is deliberately narrow: "lunch will be
 * provided" counts, "lunch" alone does not, because every seminar between
 * noon and 1pm mentions lunch.
 */
const FOOD_PHRASES = [
    /\bfree\s+(food|pizza|lunch|breakfast|dinner|snacks?|refreshments?|coffee|donuts?|tacos?|boba)\b/i,
    /\b(food|pizza|lunch|breakfast|dinner|snacks?|refreshments?|coffee|donuts?|tacos?|boba)\s+(will\s+be\s+)?(provided|served)\b/i,
    /\b(lunch|breakfast|dinner|refreshments?|snacks?)\s+(is|are)\s+included\b/i,
    /\bcomplimentary\s+(food|lunch|breakfast|dinner|refreshments?|snacks?|coffee)\b/i,
];

export function mentionsFreeFood(event: CampusEvent): boolean {
    const haystack = `${event.title} ${event.description ?? ""}`;
    return FOOD_PHRASES.some((pattern) => pattern.test(haystack));
}

/** True when the event has no physical place, as opposed to one we failed to read. */
export function hasNoVenue(event: CampusEvent): boolean {
    return (
        event.venue === "virtual" ||
        (event.latitude === null && isNonPhysicalLocation(event.locationName ?? event.room))
    );
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
 * Anywhere that is not Texas, as UT's athletics listings write it.
 *
 * "University of Texas Women's Tennis vs ITF Lincoln W15" is published on UT's
 * own calendar with the location "Lincoln, Neb., Sid and Hazel Dillon Tennis
 * Center". It is a real UT event and it is 1,200 km away, and calling it a
 * campus event is wrong.
 *
 * BOTH spellings are needed. A first pass matched only AP abbreviations with a
 * trailing period and so caught the tennis fixtures but missed every men's
 * basketball road game, which are written out in full: "San Diego,
 * California", "Louisville, Kentucky", "Athens, Georgia". Over a 60-day pull
 * that was 4 away games returned as campus events by `onCampusOnly`.
 *
 * `geo.state` would be the better signal and is unusable: it is null on every
 * one of these rows, and "TX" only on rows that already have coordinates.
 *
 * No state name collides with any UT building name or address, so matching
 * these against the location text is safe.
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
 * Two alternatives with their own anchors, not one group with a shared \b.
 *
 * An abbreviation ends in a period followed by a space, and there is no word
 * boundary between "." and " ", because neither is a word character. A single
 * group with one trailing \b therefore matched none of the abbreviations, which
 * silently un-fixed the tennis fixtures while fixing the basketball ones.
 */
const NON_TEXAS = new RegExp(`\\b(?:${STATE_ABBREVIATIONS})\\.|\\b(?:${STATE_NAMES})\\b`, "i");

/**
 * Is this on or near campus? `null` means unknown, which is most events with
 * no location at all, and is reported as unknown rather than guessed either way.
 */
export function onCampus(event: CampusEvent): boolean | null {
    if (event.latitude !== null && event.longitude !== null) {
        return (
            metresFromCampus({ latitude: event.latitude, longitude: event.longitude }) <=
            AUSTIN_RADIUS_M
        );
    }
    const where = [event.locationName, event.room, event.address].filter(Boolean).join(" ");
    if (!where) return null;
    return NON_TEXAS.test(where) ? false : null;
}

function metresFromCampus(point: { latitude: number; longitude: number }): number {
    const toRad = (deg: number) => (deg * Math.PI) / 180;
    const dLat = toRad(point.latitude - CAMPUS_CENTRE.latitude);
    const dLng = toRad(point.longitude - CAMPUS_CENTRE.longitude);
    const h =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(CAMPUS_CENTRE.latitude)) *
            Math.cos(toRad(point.latitude)) *
            Math.sin(dLng / 2) ** 2;
    return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * One row per event, not one per day it is open.
 *
 * Localist repeats a multi-day event as a separate top-level entry for every
 * day of the requested window, each carrying a single instance. A 60-day pull
 * is 1,046 rows and 324 events; a 7-day one is 236 rows and 153 events. Left
 * alone, "what is on this week" answered "245 events" when there were 153, six
 * exhibitions filled eight rows each, and `limit` was spent on repeats.
 *
 * Collapsing keeps the earliest occurrence inside the window and records how
 * many days it covers, so a run reads as one thing with a date range. Genuine
 * recurrences, such as a weekly seminar, collapse the same way and are
 * likewise reported with a count rather than repeated.
 *
 * Expects an already-filtered, already-sorted list.
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
