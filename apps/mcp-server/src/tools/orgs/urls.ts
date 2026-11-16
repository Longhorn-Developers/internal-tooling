// HornsLink is UT's Anthology/Campus Labs Engage instance. The discovery API is
// public: no EID, no cookie, no key. Verified against the live endpoints.
//
// Member-facing actions (RSVP, your memberships, submitting an event, the org
// admin console) sit behind UT SSO and are not reachable from a Worker. The
// directory and the public event list are not, which is all this tool needs.

const ENGAGE = "https://utexas.campuslabs.com/engage";
const API = `${ENGAGE}/api/discovery`;

/**
 * WARNING: the two search endpoints disagree about their own parameters, and
 * each silently ignores the other's. An ignored parameter returns a full,
 * unfiltered result set that looks filtered, which is the same class of bug as
 * Localist's `per_page` (see ../campus/urls.ts). Measured, 2026-11-14:
 *
 *   endpoint                  page size   ignored
 *   search/organizations      `top`       `take` (falls back to 25)
 *   event/search              `take`      `top`  (falls back to 10)
 *
 * Also ignored, on both: OData `$filter`/`filter`. A
 * `filter=organizationId eq 338245` returns all 562 rows, and
 * `categoryIds=...` on the org search returns all 1,226 orgs. Category
 * filtering therefore happens in `extract.ts`, on our side, not upstream.
 */
const ORG_PAGE_PARAM = "top";
const EVENT_PAGE_PARAM = "take";

/**
 * Above the ~1,227 rows that exist, so one request covers the directory even as
 * orgs are added. The endpoint returns everything it has rather than erroring on
 * an oversized page. Exported because `find_orgs` needs the same number when it
 * has to filter a full result set itself.
 */
export const DIRECTORY_PAGE_SIZE = 1300;

/**
 * Relevance-ranked keyword search. Cheap, and the server does the ranking, so
 * this is the path for any query with words in it.
 */
export function orgSearchUrl(opts: { query: string; top: number }): string {
    const url = new URL(`${API}/search/organizations`);
    url.searchParams.set("query", opts.query);
    url.searchParams.set(ORG_PAGE_PARAM, String(opts.top));
    return url.toString();
}

/**
 * The whole directory in one request: 1,226 orgs, about 1.8 MB.
 *
 * Only needed to browse by category, because upstream ignores `categoryIds`.
 * `cached` stores the trimmed rows rather than this body, so the 1.8 MB is
 * parsed once per TTL and never held.
 */
export function allOrgsUrl(): string {
    const url = new URL(`${API}/search/organizations`);
    url.searchParams.set(ORG_PAGE_PARAM, String(DIRECTORY_PAGE_SIZE));
    url.searchParams.set("orderBy[0]", "UpperName asc");
    return url.toString();
}

/** Contact details and social links, which the search rows do not carry. */
export function orgDetailUrl(websiteKey: string): string {
    return `${API}/organization/bykey/${encodeURIComponent(websiteKey)}`;
}

/**
 * Upcoming events for ONE org.
 *
 * `organizationIds` honours only its first value: repeating the parameter or
 * passing a comma-separated list returns that first org's events, or nothing at
 * all. Measured. So this is one subrequest per org and callers have to bound
 * how many orgs they ask about.
 */
export function orgEventsUrl(organizationId: string, endsAfterIso: string, take: number): string {
    const url = new URL(`${API}/event/search`);
    url.searchParams.set("organizationIds", organizationId);
    url.searchParams.set("endsAfter", endsAfterIso);
    url.searchParams.set(EVENT_PAGE_PARAM, String(take));
    url.searchParams.set("orderByField", "endsOn");
    url.searchParams.set("orderByDirection", "ascending");
    url.searchParams.set("status", "Approved");
    return url.toString();
}

/** The page a student can actually open. */
export function orgProfileUrl(websiteKey: string): string {
    return `${ENGAGE}/organization/${websiteKey}`;
}

/**
 * Logos live on a separate CDN and need a preset: without one the bare path
 * answers 302 to HTML, so a caller that trusted it would render a broken image.
 */
export function orgImageUrl(profilePicture: string | null): string | null {
    return profilePicture
        ? `https://se-images.campuslabs.com/clink/images/${profilePicture}?preset=med-sq`
        : null;
}
