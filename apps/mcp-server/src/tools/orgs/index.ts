import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import {
    ORG_CATEGORIES,
    allOrgs,
    filterOrgs,
    matchCategory,
    orgDetail,
    orgEvents,
    queryRelevance,
    searchOrgs,
    type Org,
    type OrgContact,
    type OrgEvent,
} from "./extract.ts";
import { guard, textWith } from "../respond.ts";
import { DIRECTORY_PAGE_SIZE } from "./urls.ts";

const DEFAULT_ROWS = 6;
const MAX_ROWS = 15;

/**
 * Subrequest budget. A Worker invocation gets 50 and this tool is not the only
 * thing that might run in one.
 *
 * Worst case here is 1 search + DETAIL_BUDGET detail + EVENT_BUDGET event
 * requests, because `organizationIds` honours only its first value so an org's
 * events cannot be batched (see urls.ts). 1 + 15 + 8 = 24.
 */
const DETAIL_BUDGET = 15;
const EVENT_BUDGET = 8;

/**
 * Rows pulled from a keyword search when nothing else has to be filtered.
 *
 * Enough to serve any `limit`, and no more: upstream has already ranked them.
 */
const SEARCH_OVERFETCH = 50;

/**
 * Rows pulled when a category has to be applied to a keyword search.
 *
 * Filtering a 50-row relevance window by category drops every lower-ranked
 * match in that category and then reports the survivors as the total, which is
 * a confident wrong count. Upstream serves its whole ranked result set in one
 * request, so take it and filter that. Above the 1,226 orgs that exist, so one
 * request always covers it.
 */
const SEARCH_FULL = DIRECTORY_PAGE_SIZE;

const ORG_OUTPUT = z.object({
    matched: z.number(),
    /**
     * False when `matched` was counted before the join-request filter.
     *
     * The prose says "43 org(s) matched before the join-request filter" and the
     * structured half said only `matched: 43`, so an agent reading the data
     * reported 43 orgs accepting members when the tool had checked 15 and found
     * 10. Either half has to be safe to read on its own.
     */
    matchedIsFinal: z.boolean(),
    showing: z.number(),
    orgs: z.array(
        z.object({
            name: z.string(),
            summary: z.string().nullable(),
            categories: z.array(z.string()),
            profileUrl: z.string(),
            imageUrl: z.string().nullable(),
            email: z.string().nullable(),
            website: z.string().nullable(),
            instagram: z.string().nullable(),
            linkedin: z.string().nullable(),
            youtube: z.string().nullable(),
            acceptingJoinRequests: z.boolean(),
            organizationType: z.string().nullable(),
            upcomingEvents: z
                .array(
                    z.object({
                        name: z.string(),
                        startsOn: z.string(),
                        location: z.string().nullable(),
                        rsvpTotal: z.number(),
                    }),
                )
                .nullable(),
        }),
    ),
    notes: z.array(z.string()),
});

type Row = Org & OrgContact & { upcomingEvents: OrgEvent[] | null };

/**
 * Stand-in when an org's detail request fails.
 *
 * `acceptingJoinRequests: false` is deliberate: it means "not shown as open",
 * so `acceptingMembers` drops the row rather than promising a student they can
 * join something we could not read. The accompanying note says the difference.
 */
const UNKNOWN_CONTACT: OrgContact = {
    email: null,
    website: null,
    instagram: null,
    linkedin: null,
    youtube: null,
    acceptingJoinRequests: false,
    organizationType: null,
};

function describe(row: Row): string {
    const lines = [row.categories.length ? `${row.name} — ${row.categories.join(", ")}` : row.name];
    if (row.summary) lines.push(`  ${row.summary}`);

    const links = [
        row.profileUrl,
        row.instagram ? `Instagram: ${row.instagram}` : "",
        row.website ? `Site: ${row.website}` : "",
        row.email ? `Email: ${row.email}` : "",
    ].filter(Boolean);
    lines.push(`  ${links.join(" · ")}`);

    if (!row.acceptingJoinRequests) {
        lines.push("  Not accepting join requests through HornsLink.");
    }
    // "Next:" only on the first, or two events read "Next: ... / Next: ...".
    const events = row.upcomingEvents ?? [];
    for (const [i, event] of events.entries()) {
        const when = new Date(event.startsOn).toLocaleString("en-US", {
            timeZone: "America/Chicago",
            weekday: "short",
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
        });
        const where = event.location ? `, ${event.location}` : "";
        lines.push(`  ${i === 0 ? "Next" : "Then"}: ${event.name} — ${when}${where}`);
    }
    return lines.join("\n");
}

export function registerOrgTools(server: McpServer) {
    server.registerTool(
        "find_orgs",
        {
            title: "Find UT student organizations",
            description:
                "Search UT's HornsLink directory of 1,200+ registered student organizations. " +
                "Give a query for what the student is interested in, a category, or both. " +
                "Returns what each org does, its HornsLink page, its Instagram and public " +
                "email, and whether it is taking join requests. Optionally its next events. " +
                "This is the org directory, not an events feed: for things happening on " +
                "campus use find_events instead.",
            outputSchema: ORG_OUTPUT,
            inputSchema: z
                .object({
                    query: z
                        .string()
                        // HornsLink answers 404 to a very long query string,
                        // which reached the client as "HTTP 404" and reads as
                        // "the directory is broken" rather than "your query was
                        // too long". No real search needs more than this.
                        .max(200, "query is too long; a few words is what this searches best")
                        .optional()
                        .describe('What to look for, e.g. "robotics", "climbing", "pre-med"'),
                    category: z
                        .string()
                        .optional()
                        .describe(`One of: ${ORG_CATEGORIES.join(", ")}`),
                    acceptingMembers: z
                        .boolean()
                        .optional()
                        .describe("Only orgs taking join requests through HornsLink"),
                    withUpcomingEvents: z
                        .boolean()
                        .optional()
                        .describe(
                            "Include each org's next events. Costs one request per org, so it caps results lower.",
                        ),
                    limit: z
                        .number()
                        .int()
                        .positive()
                        .max(MAX_ROWS)
                        .optional()
                        .describe(`Rows to return. Default ${DEFAULT_ROWS}, max ${MAX_ROWS}.`),
                })
                .strict(),
        },
        guard(
            async (input: {
                query?: string;
                category?: string;
                acceptingMembers?: boolean;
                withUpcomingEvents?: boolean;
                limit?: number;
            }) => {
                const notes: string[] = [];
                const query = input.query?.trim() || null;
                const wantEvents = input.withUpcomingEvents === true;
                const limit = Math.min(
                    input.limit ?? DEFAULT_ROWS,
                    wantEvents ? EVENT_BUDGET : MAX_ROWS,
                );
                // Whether the cap BIT is only known once the rows are in, so
                // the note is deferred. Announcing "Capped at 8 rows" for a
                // search that matched 2 told the student results were withheld
                // that never existed.
                const capApplies = input.limit !== undefined && input.limit > limit;

                let category: string | null = null;
                if (input.category?.trim()) {
                    category = matchCategory(input.category);
                    if (!category) {
                        return textWith(
                            `"${input.category}" is not a HornsLink category. The categories are: ` +
                                `${ORG_CATEGORIES.join(", ")}.`,
                            {
                                matched: 0,
                                matchedIsFinal: true,
                                showing: 0,
                                orgs: [],
                                notes: ["Unknown category."],
                            },
                        );
                    }
                    if (category !== input.category.trim()) {
                        notes.push(`Read "${input.category}" as the category "${category}".`);
                    }
                }

                // A query goes upstream, where it is relevance-ranked. Without
                // one there is nothing to rank by, so the directory is pulled
                // and filtered here -- upstream ignores `categoryIds`.
                let rows: Org[];
                let matched: number;
                if (query && category) {
                    // Both filters, so the category has to see every ranked row.
                    const search = await searchOrgs(query, SEARCH_FULL);
                    rows = filterOrgs(search.rows, { category });
                    matched = rows.length;
                    notes.push(
                        "Some orgs carry no category at all, so a category search cannot reach them; a query on its own can.",
                    );
                    // The same hedge as the query-only path. Narrowing by
                    // category removed the warning AND the top-50 relevance
                    // cut, so the count was least trustworthy exactly where it
                    // looked most precise: "pre-med" in Pre-Professional/Career
                    // reports 179, of which 16 mention medicine at all, and the
                    // tail is the Actuarial Science Club and Longhorn Baja
                    // Racing.
                    notes.push(
                        `HornsLink matched any word in "${query}", so these ${matched} are everything in ${category} that matched any of those words, ranked by its relevance. The lower-ranked ones may have little to do with "${query}".`,
                    );
                } else if (query) {
                    const search = await searchOrgs(query, SEARCH_OVERFETCH);
                    rows = search.rows;
                    // Upstream's own total, not the size of our fetch. It is
                    // broad because HornsLink matches any word in the query.
                    matched = search.total;
                    if (search.total > search.rows.length) {
                        notes.push(
                            `HornsLink matched any word in "${query}", so ${search.total} is a broad total; these are its top-ranked rows. Add a category, or use more specific words, to narrow it.`,
                        );
                    }
                } else {
                    const directory = await allOrgs();
                    rows = filterOrgs(directory, { category });
                    matched = rows.length;
                    if (category) {
                        // Counted from the directory in hand, not hardcoded.
                        // The constants said "87 of the 1,226" and upstream is
                        // already at 1,227 and 88; a number a student could
                        // check is a number that has to be measured.
                        const uncategorized = directory.filter(
                            (org) => org.categories.length === 0,
                        ).length;
                        notes.push(
                            `${uncategorized} of the ${directory.length} orgs carry no category, so a category search cannot reach them; a query search can.`,
                        );
                    }
                    if (!category) {
                        notes.push(
                            "No query or category given, so this is the directory in alphabetical order. Pass a query to rank by relevance.",
                        );
                    }
                }

                if (rows.length === 0) {
                    const tried = [query && `"${query}"`, category].filter(Boolean).join(" in ");
                    return textWith(`No HornsLink org matched ${tried}.`, {
                        matched: 0,
                        matchedIsFinal: true,
                        showing: 0,
                        orgs: [],
                        notes,
                    });
                }

                // Said before the rows are trimmed, because the question is
                // whether UPSTREAM understood the query, not whether this page
                // of it happens to look relevant.
                if (query) {
                    const relevance = queryRelevance(rows, query);
                    if (relevance.matchedAll.length === 0) {
                        const words = relevance.found.length
                            ? `only on ${relevance.found.map((w) => `"${w}"`).join(" and ")}`
                            : "on none of those words in a name or description";
                        notes.push(
                            `No org matched all of "${query}". These matched ${words}, so treat them as near misses rather than as what was asked for; there may be nothing at UT for this.`,
                        );
                    }
                }

                // Contact details need one request per org, so only the rows
                // that could be returned are looked up. `acceptingMembers`
                // filters on a detail-only field, which is why it reaches
                // further down the list than `limit` alone would.
                const reach = input.acceptingMembers ? DETAIL_BUDGET : limit;
                const candidates = rows.slice(0, reach);
                // allSettled, not all: contact details are an enrichment, and
                // one org's 404 used to fail the whole answer. The org still
                // has a name, a summary and a HornsLink link, which is most of
                // what the student needs.
                const settled = await Promise.allSettled(
                    candidates.map((org) => orgDetail(org.websiteKey)),
                );
                const detailed: Row[] = candidates.map((org, i) => {
                    const result = settled[i]!;
                    return result.status === "fulfilled"
                        ? { ...org, ...result.value, upcomingEvents: null }
                        : { ...org, ...UNKNOWN_CONTACT, upcomingEvents: null };
                });
                const detailFailures = settled.filter((r) => r.status === "rejected").length;
                if (detailFailures > 0) {
                    notes.push(
                        `HornsLink did not answer for ${detailFailures} org(s), so their contact details and join status are missing here rather than absent upstream.`,
                    );
                }

                let kept = detailed;
                if (input.acceptingMembers) {
                    kept = detailed.filter((row) => row.acceptingJoinRequests);
                    if (matched > reach) {
                        notes.push(
                            `Checked the first ${reach} of ${matched} matches for open join requests; narrow the search to see further.`,
                        );
                    }
                }
                kept = kept.slice(0, limit);

                if (capApplies && rows.length > limit) {
                    notes.push(
                        `Capped at ${limit} rows: each org's events are a separate request upstream.`,
                    );
                }

                if (wantEvents) {
                    const nowIso = new Date().toISOString();
                    // allSettled for the same reason as the details above:
                    // events are opt-in garnish and must not fail the answer.
                    await Promise.all(
                        kept.map(async (row) => {
                            row.upcomingEvents = await orgEvents(row.id, nowIso, 2).catch(
                                () => null,
                            );
                        }),
                    );
                    notes.push(
                        "Most HornsLink events are recurring general meetings with no RSVPs; treat an empty list as 'nothing posted', not 'inactive'.",
                    );
                }

                // `matched` is counted BEFORE the join-request filter, which
                // needs a per-org request and so only reaches `reach` rows.
                // Presenting it as the number accepting members would be wrong
                // wherever some of them refuse.
                const countLabel = input.acceptingMembers
                    ? `${matched} org(s) matched before the join-request filter`
                    : `${matched} org(s) matched`;
                const header =
                    countLabel + (kept.length < matched ? `, showing ${kept.length}:` : ":");
                const body = [header, "", ...kept.map(describe)].join("\n");

                return textWith(
                    body + (notes.length ? `\n\n${notes.map((n) => `NOTE: ${n}`).join("\n")}` : ""),
                    {
                        matched,
                        matchedIsFinal: input.acceptingMembers !== true,
                        showing: kept.length,
                        orgs: kept.map((row) => ({
                            name: row.name,
                            summary: row.summary,
                            categories: row.categories,
                            profileUrl: row.profileUrl,
                            imageUrl: row.imageUrl,
                            email: row.email,
                            website: row.website,
                            instagram: row.instagram,
                            linkedin: row.linkedin,
                            youtube: row.youtube,
                            acceptingJoinRequests: row.acceptingJoinRequests,
                            organizationType: row.organizationType,
                            upcomingEvents: row.upcomingEvents,
                        })),
                        notes,
                    },
                );
            },
        ),
    );
}
