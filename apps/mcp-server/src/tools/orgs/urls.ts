// HornsLink is UT's Anthology/Campus Labs Engage instance. The discovery API is public; member
// actions like RSVP need UT SSO and are not used here.

const ENGAGE = "https://utexas.campuslabs.com/engage";
const API = `${ENGAGE}/api/discovery`;

// Each search endpoint ignores the other's page parameter and returns a full result set that looks
// filtered. Both ignore OData `filter=`, and the org search ignores `categoryIds=`, so category
// filtering happens in extract.ts.
const ORG_PAGE_PARAM = "top"; // search/organizations; `take` falls back to 25
const EVENT_PAGE_PARAM = "take"; // event/search; `top` falls back to 10

/** Above the ~1,227 orgs that exist, so one request covers the directory. */
export const DIRECTORY_PAGE_SIZE = 1300;

/** Relevance-ranked keyword search, ranked server-side. */
export function orgSearchUrl(opts: { query: string; top: number }): string {
    const url = new URL(`${API}/search/organizations`);
    url.searchParams.set("query", opts.query);
    url.searchParams.set(ORG_PAGE_PARAM, String(opts.top));
    return url.toString();
}

/** The whole directory, ~1.8 MB. Only needed to browse by category. */
export function allOrgsUrl(): string {
    const url = new URL(`${API}/search/organizations`);
    url.searchParams.set(ORG_PAGE_PARAM, String(DIRECTORY_PAGE_SIZE));
    url.searchParams.set("orderBy[0]", "UpperName asc");
    return url.toString();
}

/** Contact details and socials, which the search rows do not carry. */
export function orgDetailUrl(websiteKey: string): string {
    return `${API}/organization/bykey/${encodeURIComponent(websiteKey)}`;
}

/** One org's events. `organizationIds` honours only its first value. */
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

export function orgProfileUrl(websiteKey: string): string {
    return `${ENGAGE}/organization/${websiteKey}`;
}

/** Needs `preset`; the bare path 302s to HTML. */
export function orgImageUrl(profilePicture: string | null): string | null {
    return profilePicture
        ? `https://se-images.campuslabs.com/clink/images/${profilePicture}?preset=med-sq`
        : null;
}
