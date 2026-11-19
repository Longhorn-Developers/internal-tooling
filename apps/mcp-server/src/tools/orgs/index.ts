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
import { DIRECTORY_PAGE_SIZE } from "./urls.ts";

const textWith = <T>(body: string, structuredContent: T) => ({
    content: [{ type: "text" as const, text: body }],
    structuredContent,
});

/** Answer with a readable message instead of throwing at the client. */
const guard =
    <A>(
        run: (args: A) => Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }>,
    ) =>
    async (args: A) => {
        try {
            return await run(args);
        } catch (error) {
            return {
                content: [{ type: "text" as const, text: (error as Error).message }],
                isError: true,
            };
        }
    };

const DEFAULT_ROWS = 6;
const MAX_ROWS = 15;

/** A Worker gets 50 subrequests; worst case here is 1 + 15 + 8. */
const DETAIL_BUDGET = 15;
const EVENT_BUDGET = 8;

/** Rows pulled from a keyword search when nothing else has to be filtered. */
const SEARCH_OVERFETCH = 50;

/** Rows pulled when a category has to be applied to a keyword search. */
const SEARCH_FULL = DIRECTORY_PAGE_SIZE;

const ORG_OUTPUT = z.object({
    matched: z.number(),
    /** What `matched` actually counts, because the three paths differ. */
    matchedMeaning: z.enum(["exact", "upstream-broad", "before-join-filter"]),
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
            /** False when this row matched only part of the query. */
            matchesWholeQuery: z.boolean(),
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

type Row = Org & OrgContact & { upcomingEvents: OrgEvent[] | null; matchesWholeQuery: boolean };

/** Stand-in when an org's detail request fails. */
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
    const loose = row.matchesWholeQuery ? "" : "  [matched only part of your query]";
    const lines = [
        (row.categories.length ? `${row.name} — ${row.categories.join(", ")}` : row.name) + loose,
    ];
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
                        // A very long query 404s upstream, which reads as a broken directory.
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
                // Whether the cap bites is only known once the rows are in.
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
                                matchedMeaning: "exact" as const,
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

                // A query goes upstream, where it is relevance-ranked.
                let rows: Org[];
                let matched: number;
                // Query-only path: `matched` is HornsLink's any-word total.
                let matchedIsUpstreamTotal = false;
                if (query && category) {
                    // Both filters, so the category has to see every ranked row.
                    const search = await searchOrgs(query, SEARCH_FULL);
                    rows = filterOrgs(search.rows, { category });
                    matched = rows.length;
                    notes.push(
                        "Some orgs carry no category at all, so a category search cannot reach them; a query on its own can.",
                    );
                    // The same hedge as the query-only path.
                    if (matched > 1) {
                        notes.push(
                            `HornsLink matched any word in "${query}", so these ${matched} are everything in ${category} that matched any of those words, ranked by its relevance. The lower-ranked ones may have little to do with "${query}".`,
                        );
                    }
                } else if (query) {
                    const search = await searchOrgs(query, SEARCH_OVERFETCH);
                    rows = search.rows;
                    // Upstream's own total, not the size of our fetch.
                    matched = search.total;
                    matchedIsUpstreamTotal = search.total > search.rows.length;
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
                        matchedMeaning: "exact" as const,
                        showing: 0,
                        orgs: [],
                        notes,
                    });
                }

                // Per row, not per result set.
                const relevance = query ? queryRelevance(rows, query) : null;
                const whole = new Set(relevance?.matchedAll.map((org) => org.websiteKey) ?? []);
                const matchesWholeQuery = (org: Org) => !relevance || whole.has(org.websiteKey);

                // One request per org, so only returnable rows are looked up.
                const reach = input.acceptingMembers ? DETAIL_BUDGET : limit;
                const candidates = rows.slice(0, reach);
                // allSettled: one org's 404 used to fail the whole answer.
                const settled = await Promise.allSettled(
                    candidates.map((org) => orgDetail(org.websiteKey)),
                );
                const detailed: Row[] = candidates.map((org, i) => {
                    const result = settled[i]!;
                    const contact = result.status === "fulfilled" ? result.value : UNKNOWN_CONTACT;
                    return {
                        ...org,
                        ...contact,
                        upcomingEvents: null,
                        matchesWholeQuery: matchesWholeQuery(org),
                    };
                });
                const detailFailures = settled.filter((r) => r.status === "rejected").length;
                if (detailFailures > 0) {
                    notes.push(
                        `HornsLink did not answer for ${detailFailures} org(s), so their contact details and join status are missing here rather than absent upstream.` +
                            (input.acceptingMembers
                                ? " Because this was an acceptingMembers search, those orgs were dropped from the list rather than shown without a join status."
                                : ""),
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

                if (relevance && query) {
                    const loose = kept.filter((row) => !row.matchesWholeQuery);
                    if (loose.length === kept.length) {
                        const words = relevance.found.length
                            ? `only on ${relevance.found.map((w) => `"${w}"`).join(" and ")}`
                            : "on none of those words in a name or description";
                        notes.push(
                            `No org here matched all of "${query}". These matched ${words}, so treat them as near misses rather than as what was asked for; there may be nothing at UT for this.`,
                        );
                    } else if (loose.length > 0) {
                        notes.push(
                            `${loose.length} of these matched only part of "${query}" and may be unrelated: ` +
                                `${loose.map((row) => row.name).join("; ")}. HornsLink ranks on any word, ` +
                                "including words in a description this tool does not show.",
                        );
                    }
                }

                if (capApplies && rows.length > limit) {
                    notes.push(
                        `Capped at ${limit} rows: each org's events are a separate request upstream.`,
                    );
                }

                if (wantEvents) {
                    const nowIso = new Date().toISOString();
                    // Same reason: events are opt-in and must not fail the answer.
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

                // Counted BEFORE the join filter, which only reaches `reach` rows.
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
                        matchedMeaning: input.acceptingMembers
                            ? ("before-join-filter" as const)
                            : matchedIsUpstreamTotal
                              ? ("upstream-broad" as const)
                              : ("exact" as const),
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
                            matchesWholeQuery: row.matchesWholeQuery,
                            upcomingEvents: row.upcomingEvents,
                        })),
                        notes,
                    },
                );
            },
        ),
    );
}
