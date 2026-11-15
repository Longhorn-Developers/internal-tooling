// Reads the HornsLink org directory and turns it into something a model can
// answer "what clubs should I look at" from.
//
// WHAT THIS DELIBERATELY DOES NOT RETURN. The detail endpoint carries
// `primaryContact`: a named student, their personal email address, and their
// profile photo. That is a real person's contact details, and an org directory
// answer does not need them -- the org's own inbox and its Instagram do the
// same job. Only the org-level address is read; the officer block is dropped in
// `orgDetail` below and never reaches a tool response.
//
// WHY NOT AN EVENT FEED. HornsLink is where orgs register events to reserve
// rooms and meet reporting requirements, not where students find them. Over an
// 878-event pull, 823 had zero RSVPs, the highest on any event was 5, and 91%
// were occurrences of a recurring series -- 478 titles were a variant of
// "General Meeting". So this tool is the directory, and an org's events are
// opt-in and capped rather than a second events feed. Campus events come from
// Localist, through find_events.

import { cached, getText, norm, text } from "../../shared.ts";
import {
    allOrgsUrl,
    orgDetailUrl,
    orgEventsUrl,
    orgImageUrl,
    orgProfileUrl,
    orgSearchUrl,
} from "./urls.ts";

/**
 * Bump this whenever the SHAPE of anything cached below changes.
 *
 * `cached` persists its values in the Cloudflare Cache API, which outlives a
 * deploy. When `searchOrgs` started returning `{ total, rows }` instead of a
 * bare array, every key already in that cache still held an array, and the new
 * code read `.rows` off it and threw -- for as long as the old entry's TTL had
 * left. Caught on a live worker that had answered the same queries under the
 * previous shape.
 *
 * A version in the key makes an entry written by older code unreachable
 * instead of wrong.
 */
const CACHE_VERSION = 2;

/** The directory is edited by hand and changes on the order of weeks. */
const DIRECTORY_TTL_SECONDS = 21_600; // 6 hours
const SEARCH_TTL_SECONDS = 3_600;
const EVENTS_TTL_SECONDS = 1_800;

export interface Org {
    id: string;
    name: string;
    /** Plain-text blurb. The feed's own one-liner, not the HTML description. */
    summary: string | null;
    categories: string[];
    profileUrl: string;
    imageUrl: string | null;
    websiteKey: string;
}

export interface OrgContact {
    /**
     * The org-level contact address.
     *
     * Usually an org inbox, but it is a free-text field an officer fills in,
     * and some orgs put their own @utexas.edu address there (Alpha Kappa Psi
     * does). So this is "the address the org publishes", not "never a personal
     * address" -- what is guaranteed is that it never comes from the officer
     * record, which this tool does not read at all.
     */
    email: string | null;
    website: string | null;
    instagram: string | null;
    linkedin: string | null;
    youtube: string | null;
    /** Whether HornsLink is accepting join requests through the site. */
    acceptingJoinRequests: boolean;
    /** e.g. "Registered Student Organizations", "Sport Clubs". */
    organizationType: string | null;
}

export interface OrgEvent {
    name: string;
    startsOn: string;
    location: string | null;
    rsvpTotal: number;
}

/**
 * The 14 categories HornsLink publishes, as of 2026-11-14.
 *
 * Hardcoded on purpose: upstream ignores `categoryIds`, so this list is only
 * used to validate and match what a caller typed, never to build a request. The
 * live list is at `orgCategoriesUrl()` if it ever needs regenerating.
 */
export const ORG_CATEGORIES = [
    "Academic",
    "Arts/Entertainment",
    "Cultural/International",
    "Religious/Spiritual",
    "Political/Advocacy",
    "Service/Philanthropy",
    "Pre-Professional/Career",
    "Leadership/Governance",
    "Sororities and Fraternities",
    "Recreational",
    "Social",
    "Graduate Student Oriented",
    "Educational",
    "Sport Clubs",
] as const;

/**
 * Category names that appear on orgs but not in the category endpoint.
 *
 * The endpoint publishes 14 categories; the directory's rows carry 20 distinct
 * names. Measured over all 1,226 rows on 2026-11-14: Culture 5, Art 3, Service
 * and Philanthropy 2, Pre-Professional 2, Student Governance 1, Ideology and
 * Politics 1. They look like names from before a rename and nothing cleaned up
 * the rows.
 *
 * Without this, "Cultural/International" silently misses the 5 orgs tagged
 * "Culture" -- a filter that looks like it worked and quietly drops rows.
 */
const LEGACY_CATEGORY_NAMES: Record<string, string> = {
    Culture: "Cultural/International",
    Art: "Arts/Entertainment",
    "Service and Philanthropy": "Service/Philanthropy",
    "Pre-Professional": "Pre-Professional/Career",
    "Student Governance": "Leadership/Governance",
    "Ideology and Politics": "Political/Advocacy",
};

/** 87 of the 1,226 rows carry no category at all, so no category filter reaches them. */
export const ORGS_WITHOUT_CATEGORY = 87;

/**
 * Words students use that are not a category name.
 *
 * "sports" is the one that matters: the category is "Sport Clubs", and a plain
 * substring match on "sports" finds nothing because of the missing s.
 */
const CATEGORY_ALIASES: Record<string, string> = {
    sports: "Sport Clubs",
    sport: "Sport Clubs",
    club: "Recreational",
    intramural: "Sport Clubs",
    greek: "Sororities and Fraternities",
    frat: "Sororities and Fraternities",
    fraternity: "Sororities and Fraternities",
    sorority: "Sororities and Fraternities",
    volunteering: "Service/Philanthropy",
    volunteer: "Service/Philanthropy",
    service: "Service/Philanthropy",
    religious: "Religious/Spiritual",
    faith: "Religious/Spiritual",
    culture: "Cultural/International",
    cultural: "Cultural/International",
    international: "Cultural/International",
    arts: "Arts/Entertainment",
    art: "Arts/Entertainment",
    music: "Arts/Entertainment",
    career: "Pre-Professional/Career",
    professional: "Pre-Professional/Career",
    preprofessional: "Pre-Professional/Career",
    business: "Pre-Professional/Career",
    grad: "Graduate Student Oriented",
    graduate: "Graduate Student Oriented",
    politics: "Political/Advocacy",
    political: "Political/Advocacy",
    advocacy: "Political/Advocacy",
    academic: "Academic",
    social: "Social",
};

/**
 * Map what a caller typed onto one of the 14, or null.
 *
 * Deliberately conservative. An earlier version took the first category whose
 * name contained the input, which turned "ed" into "Graduate Student Oriented"
 * (it contains "orient-ed", and it sorts before "Educational") and "a" into
 * "Academic". A confident wrong category is worse than refusing, because the
 * answer that comes back looks filtered.
 */
export function matchCategory(input: string): string | null {
    const raw = input.trim();
    const wanted = norm(raw);
    if (!wanted) return null;

    const exact = ORG_CATEGORIES.find((c) => norm(c) === wanted);
    if (exact) return exact;

    const whole = CATEGORY_ALIASES[wanted];
    if (whole) return whole;

    // An alias inside a phrase, so "Greek life" and "intramural sports" work.
    // Only when the words agree: a phrase pointing at two categories is
    // ambiguous and refusing says so.
    const hits = new Set<string>();
    for (const word of raw.toLowerCase().split(/[^a-z0-9]+/)) {
        const alias = word && CATEGORY_ALIASES[norm(word)];
        if (alias) hits.add(alias);
    }
    if (hits.size === 1) return [...hits][0]!;

    // Substring, but only for an input long enough to carry meaning, and only
    // when exactly one category matches.
    if (wanted.length >= 4) {
        const partial = ORG_CATEGORIES.filter(
            (c) => norm(c).includes(wanted) || wanted.includes(norm(c)),
        );
        if (partial.length === 1) return partial[0]!;
    }
    return null;
}

interface RawSearchRow {
    Id?: string;
    Name?: string;
    ShortName?: string | null;
    WebsiteKey?: string | null;
    Summary?: string | null;
    Description?: string | null;
    ProfilePicture?: string | null;
    CategoryNames?: string[] | null;
    Status?: string | null;
    Visibility?: string | null;
}

/**
 * A row is usable only if it has the two things every answer needs: an id and a
 * website key. The key is what builds the profile link, and a row without one
 * cannot be linked to, so it is dropped rather than returned unlinkable.
 *
 * Inactive and non-public rows are dropped too. The directory carries 1,226
 * rows and the club's own daily scrape counts 1,222, so a handful are not
 * things a student should be pointed at.
 */
function toOrg(raw: RawSearchRow): Org | null {
    const id = raw.Id?.trim();
    const name = raw.Name?.trim();
    const websiteKey = raw.WebsiteKey?.trim();
    if (!id || !name || !websiteKey) return null;
    if (raw.Status && raw.Status !== "Active") return null;
    if (raw.Visibility && raw.Visibility !== "Public") return null;

    // `Summary` is the feed's own plain-text blurb, but it is not reliably
    // plain: some rows carry entities, and a few carry tags. Running it through
    // `text` costs nothing and means a description never reaches a user as
    // "&nbsp;" or with a stray <span>.
    const summary = raw.Summary ? text(raw.Summary) : raw.Description ? text(raw.Description) : "";

    return {
        id,
        name,
        summary: summary ? summary.slice(0, 400) : null,
        categories: (raw.CategoryNames ?? [])
            .filter(Boolean)
            .map((c) => LEGACY_CATEGORY_NAMES[c] ?? c),
        profileUrl: orgProfileUrl(websiteKey),
        imageUrl: orgImageUrl(raw.ProfilePicture ?? null),
        websiteKey,
    };
}

function parseOrgs(body: string): Org[] {
    const parsed = JSON.parse(body) as { value?: RawSearchRow[] };
    return (parsed.value ?? []).map(toOrg).filter((o): o is Org => o !== null);
}

export interface OrgSearch {
    /**
     * How many rows upstream says match, which is NOT how many were returned.
     *
     * Upstream matches any word in the query and ranks the result loosely, so
     * this number is broad: "pre-med" reports 469 of the 1,226 orgs and "ai"
     * reports 238. It is still the only honest total available, and reporting
     * the size of our own fetch instead would be a made-up number.
     */
    total: number;
    rows: Org[];
}

/** Relevance-ranked, upstream. Used whenever the caller gave words to match. */
export async function searchOrgs(query: string, top: number): Promise<OrgSearch> {
    return cached(
        `orgs:v${CACHE_VERSION}:q:${query.toLowerCase()}:${top}`,
        SEARCH_TTL_SECONDS,
        async () => {
            const body = await getText(orgSearchUrl({ query, top }), SEARCH_TTL_SECONDS);
            const parsed = JSON.parse(body) as { "@odata.count"?: number };
            const rows = parseOrgs(body);
            return {
                total:
                    typeof parsed["@odata.count"] === "number"
                        ? parsed["@odata.count"]
                        : rows.length,
                rows,
            };
        },
    );
}

/** The whole directory, for category browsing. One 1.8 MB request per TTL. */
export async function allOrgs(): Promise<Org[]> {
    return cached(`orgs:v${CACHE_VERSION}:all`, DIRECTORY_TTL_SECONDS, async () =>
        parseOrgs(await getText(allOrgsUrl(), DIRECTORY_TTL_SECONDS)),
    );
}

interface RawDetail {
    email?: string | null;
    showJoin?: boolean;
    organizationType?: { name?: string | null } | null;
    socialMedia?: Record<string, string | null> | null;
}

const link = (value: string | null | undefined): string | null => value?.trim() || null;

export async function orgDetail(websiteKey: string): Promise<OrgContact> {
    return cached(
        `orgs:v${CACHE_VERSION}:detail:${websiteKey}`,
        DIRECTORY_TTL_SECONDS,
        async () => {
            const raw = JSON.parse(
                await getText(orgDetailUrl(websiteKey), DIRECTORY_TTL_SECONDS),
            ) as RawDetail;
            const social = raw.socialMedia ?? {};
            // Note what is NOT read here: raw.primaryContact (a named student and
            // their personal email) and raw.contactInfo (street address, phone).
            return {
                email: link(raw.email),
                website: link(social.ExternalWebsite),
                instagram: link(social.InstagramUrl),
                linkedin: link(social.LinkedInUrl),
                youtube: link(social.YoutubeUrl),
                acceptingJoinRequests: raw.showJoin === true,
                organizationType: link(raw.organizationType?.name),
            };
        },
    );
}

interface RawEvent {
    name?: string;
    startsOn?: string;
    location?: string | null;
    rsvpTotal?: number | null;
}

export async function orgEvents(
    organizationId: string,
    nowIso: string,
    take: number,
): Promise<OrgEvent[]> {
    return cached(
        `orgs:v${CACHE_VERSION}:events:${organizationId}:${take}`,
        EVENTS_TTL_SECONDS,
        async () => {
            const parsed = JSON.parse(
                await getText(orgEventsUrl(organizationId, nowIso, take), EVENTS_TTL_SECONDS),
            ) as { value?: RawEvent[] };
            return (parsed.value ?? [])
                .filter((e): e is RawEvent & { name: string; startsOn: string } =>
                    Boolean(e.name && e.startsOn),
                )
                .map((e) => ({
                    name: text(e.name),
                    startsOn: e.startsOn,
                    location: e.location ? text(e.location) : null,
                    rsvpTotal: typeof e.rsvpTotal === "number" ? e.rsvpTotal : 0,
                }));
        },
    );
}

/**
 * Narrow a set of rows by category, and by words when the words could not be
 * handed to upstream.
 *
 * `category` is matched against the row's own CategoryNames rather than
 * re-derived, so a row carrying two categories matches either.
 */
export function filterOrgs(
    rows: Org[],
    filters: { category?: string | null; query?: string | null },
): Org[] {
    const category = filters.category ? matchCategory(filters.category) : null;
    const words = filters.query ? norm(filters.query) : "";
    return rows.filter((org) => {
        if (category && !org.categories.some((c) => c === category)) return false;
        if (words && !norm(`${org.name} ${org.summary ?? ""}`).includes(words)) return false;
        return true;
    });
}
