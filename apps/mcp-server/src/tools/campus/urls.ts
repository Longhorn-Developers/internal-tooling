// UT's central event calendar runs Localist. Everything here is public JSON,
// no EID.

const CALENDAR_API = "https://calendar.utexas.edu/api/2/events";

/**
 * The page-size parameter is `pp`. It is NOT `per_page`.
 *
 * Localist ignores an unknown parameter rather than erroring, and falls back to
 * 10 per page. Longhorn-Loop's texasToday scraper sends `per_page=100` and so
 * walks 80 pages where 8 would do, which is over a Worker's subrequest budget,
 * which is why that scraper has never ingested a row. Filed as
 * Longhorn-Developers/Longhorn-Loop#472. Measured, 30-day window:
 *
 *   per_page=100  ->  size 10,  80 pages
 *   pp=100        ->  size 100,  8 pages
 */
export const PAGE_SIZE = 100;

export function calendarUrl(opts: { days: number; page: number; groupId?: number }): string {
    const url = new URL(CALENDAR_API);
    url.searchParams.set("days", String(opts.days));
    url.searchParams.set("pp", String(PAGE_SIZE));
    url.searchParams.set("page", String(opts.page));
    // `group_id` is the only filter Localist honours here. `department_id` and
    // `dept_id` are both silently ignored and return the unfiltered feed, so a
    // caller reaching for the obvious name gets a result that looks filtered
    // and is not.
    if (opts.groupId !== undefined) url.searchParams.set("group_id", String(opts.groupId));
    return url.toString();
}

/** The human page for an event, for handing back to the user. */
export function eventUrl(slug: string | null, id: number): string {
    return slug
        ? `https://calendar.utexas.edu/event/${slug}`
        : `https://calendar.utexas.edu/event/${id}`;
}
