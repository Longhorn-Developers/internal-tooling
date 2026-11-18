// UT's central event calendar runs Localist. Public JSON, no EID.

const CALENDAR_API = "https://calendar.utexas.edu/api/2/events";

/** Page size is `pp`. `per_page` is ignored and falls back to 10 per page. */
export const PAGE_SIZE = 100;

export function calendarUrl(opts: { days: number; page: number; groupId?: number }): string {
    const url = new URL(CALENDAR_API);
    url.searchParams.set("days", String(opts.days));
    url.searchParams.set("pp", String(PAGE_SIZE));
    url.searchParams.set("page", String(opts.page));
    // `group_id` is the only filter Localist honours. `department_id` and
    // `dept_id` are ignored and return the unfiltered feed.
    if (opts.groupId !== undefined) url.searchParams.set("group_id", String(opts.groupId));
    return url.toString();
}

export function eventUrl(slug: string | null, id: number): string {
    return slug
        ? `https://calendar.utexas.edu/event/${slug}`
        : `https://calendar.utexas.edu/event/${id}`;
}
