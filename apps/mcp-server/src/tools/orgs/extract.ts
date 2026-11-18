// Reads the HornsLink org directory. The detail endpoint's `primaryContact` -- a
// named student, their email and photo -- is dropped and never reaches a response.

import { cached, getJson, norm, text } from "../../shared.ts";
import {
    allOrgsUrl,
    orgDetailUrl,
    orgEventsUrl,
    orgImageUrl,
    orgProfileUrl,
    orgSearchUrl,
} from "./urls.ts";

/** Bump on any shape change: the CF cache outlives a deploy. */
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
    /** The address the org publishes. */
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

/** The 14 categories HornsLink publishes, 2026-11-14. */
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

/** On orgs but not in the category endpoint: 14 published, 20 in the rows. */
const LEGACY_CATEGORY_NAMES: Record<string, string> = {
    Culture: "Cultural/International",
    Art: "Arts/Entertainment",
    "Service and Philanthropy": "Service/Philanthropy",
    "Pre-Professional": "Pre-Professional/Career",
    "Student Governance": "Leadership/Governance",
    "Ideology and Politics": "Political/Advocacy",
};

/** "sports" is the one that matters: the category is "Sport Clubs". */
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

/** Whole-input only: "club" is in almost every phrase a student types. */
const WHOLE_INPUT_ONLY = new Set(["club", "clubs"]);

/** Map what a caller typed onto one of the 14, or null. */
export function matchCategory(input: string): string | null {
    const raw = input.trim();
    const wanted = norm(raw);
    if (!wanted) return null;

    const exact = ORG_CATEGORIES.find((c) => norm(c) === wanted);
    if (exact) return exact;

    const whole = CATEGORY_ALIASES[wanted];
    if (whole) return whole;

    // An alias inside a phrase, so "Greek life" and "intramural sports" work.
    const hits = new Set<string>();
    for (const word of raw.toLowerCase().split(/[^a-z0-9]+/)) {
        if (!word || WHOLE_INPUT_ONLY.has(norm(word))) continue;
        const alias = CATEGORY_ALIASES[norm(word)];
        if (alias) hits.add(alias);
    }
    if (hits.size === 1) return [...hits][0]!;

    // Substring only for a long enough input, and only on a single match.
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

/** Needs an id and a website key, which is what builds the profile link. */
function toOrg(raw: RawSearchRow): Org | null {
    const id = raw.Id?.trim();
    const name = raw.Name?.trim();
    const websiteKey = raw.WebsiteKey?.trim();
    if (!id || !name || !websiteKey) return null;
    if (raw.Status && raw.Status !== "Active") return null;
    if (raw.Visibility && raw.Visibility !== "Public") return null;

    // Not reliably plain: some rows carry entities, a few carry tags.
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

/** Takes the PARSED payload: the directory is 1.8 MB and was parsed twice. */
function parseOrgs(parsed: { value?: RawSearchRow[] }): Org[] {
    return (parsed.value ?? []).map(toOrg).filter((o): o is Org => o !== null);
}

export interface OrgSearch {
    /** What upstream says matches, which is NOT how many were returned. */
    total: number;
    rows: Org[];
}

/** Relevance-ranked, upstream. Used whenever the caller gave words to match. */
export async function searchOrgs(query: string, top: number): Promise<OrgSearch> {
    return cached(
        `orgs:v${CACHE_VERSION}:q:${query.toLowerCase()}:${top}`,
        SEARCH_TTL_SECONDS,
        async () => {
            const parsed = await getJson<{ "@odata.count"?: number; value?: RawSearchRow[] }>(
                orgSearchUrl({ query, top }),
                SEARCH_TTL_SECONDS,
            );
            const rows = parseOrgs(parsed);
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
        parseOrgs(await getJson<{ value?: RawSearchRow[] }>(allOrgsUrl(), DIRECTORY_TTL_SECONDS)),
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
            const raw = await getJson<RawDetail>(orgDetailUrl(websiteKey), DIRECTORY_TTL_SECONDS);
            const social = raw.socialMedia ?? {};
            // Not read: raw.primaryContact (a named student, personal email) and
            // raw.contactInfo (street address, phone).
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
            const parsed = await getJson<{ value?: RawEvent[] }>(
                orgEventsUrl(organizationId, nowIso, take),
                EVENTS_TTL_SECONDS,
            );
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

/** Which query words the rows actually contain. HornsLink ranks on ANY word. */
export function queryRelevance(
    rows: Org[],
    query: string,
): { matchedAll: Org[]; found: string[]; missing: string[] } {
    const haystack = (org: Org) => `${org.name} ${org.summary ?? ""}`.toLowerCase();

    // Whitespace, not every non-alphanumeric: splitting "pre-med" into "pre" and
    // "med" found both inside "president" and "media".
    const words = query
        .toLowerCase()
        .split(/\s+/)
        .filter((word) => word.replace(/[^a-z0-9]/g, "").length > 1);
    if (!words.length) return { matchedAll: rows, found: [], missing: [] };

    // Anchored at a word start and flexible across punctuation, so "pre-med"
    // finds "Pre Med Society" and "pre-medical" but not "president".
    const test = (word: string) => {
        const parts = word
            .split(/[^a-z0-9]+/)
            .filter(Boolean)
            .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
        if (!parts.length) return () => false;
        const pattern = new RegExp(`\\b${parts.join("[^a-z0-9]*")}`);
        return (org: Org) => pattern.test(haystack(org));
    };
    const tests = words.map((word) => [word, test(word)] as const);

    const found: string[] = [];
    const missing: string[] = [];
    for (const [word, matches] of tests) {
        (rows.some(matches) ? found : missing).push(word);
    }
    return {
        matchedAll: rows.filter((org) => tests.every(([, matches]) => matches(org))),
        found,
        missing,
    };
}

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
