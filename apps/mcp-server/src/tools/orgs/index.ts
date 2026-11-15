import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import {
    ORGS_WITHOUT_CATEGORY,
    ORG_CATEGORIES,
    allOrgs,
    filterOrgs,
    matchCategory,
    orgDetail,
    orgEvents,
    searchOrgs,
    type Org,
    type OrgContact,
    type OrgEvent,
} from "./extract.ts";

/** Text plus the same answer as data, for clients that would rather not parse prose. */
const textWith = <T>(body: string, structuredContent: T) => ({
    content: [{ type: "text" as const, text: body }],
    structuredContent,
});

/** Tool handlers answer with a readable message instead of throwing at the client. */
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

/** Rows pulled from a keyword search before our own filters narrow them. */
const SEARCH_OVERFETCH = 50;

const ORG_OUTPUT = z.object({
    matched: z.number(),
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
    for (const event of row.upcomingEvents ?? []) {
        const when = new Date(event.startsOn).toLocaleString("en-US", {
            timeZone: "America/Chicago",
            weekday: "short",
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
        });
        const where = event.location ? `, ${event.location}` : "";
        lines.push(`  Next: ${event.name} — ${when}${where}`);
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
                if (input.limit && input.limit > limit) {
                    notes.push(
                        `Capped at ${limit} rows: each org's events are a separate request upstream.`,
                    );
                }

                let category: string | null = null;
                if (input.category?.trim()) {
                    category = matchCategory(input.category);
                    if (!category) {
                        return textWith(
                            `"${input.category}" is not a HornsLink category. The categories are: ` +
                                `${ORG_CATEGORIES.join(", ")}.`,
                            { matched: 0, showing: 0, orgs: [], notes: ["Unknown category."] },
                        );
                    }
                    if (category !== input.category.trim()) {
                        notes.push(`Read "${input.category}" as the category "${category}".`);
                    }
                    notes.push(
                        `${ORGS_WITHOUT_CATEGORY} of the 1,226 orgs carry no category, so a category search cannot reach them; a query search can.`,
                    );
                }

                // A query goes upstream, where it is relevance-ranked. Without
                // one there is nothing to rank by, so the directory is pulled
                // and filtered here -- upstream ignores `categoryIds`.
                let rows: Org[];
                if (query) {
                    rows = filterOrgs(await searchOrgs(query, SEARCH_OVERFETCH), { category });
                } else {
                    rows = filterOrgs(await allOrgs(), { category });
                    if (!category) {
                        notes.push(
                            "No query or category given, so this is the directory in alphabetical order. Pass a query to rank by relevance.",
                        );
                    }
                }

                const matched = rows.length;
                if (matched === 0) {
                    const tried = [query && `"${query}"`, category].filter(Boolean).join(" in ");
                    return textWith(`No HornsLink org matched ${tried}.`, {
                        matched: 0,
                        showing: 0,
                        orgs: [],
                        notes,
                    });
                }

                // Contact details need one request per org, so only the rows
                // that could be returned are looked up. `acceptingMembers`
                // filters on a detail-only field, which is why it reaches
                // further down the list than `limit` alone would.
                const reach = input.acceptingMembers ? DETAIL_BUDGET : limit;
                const candidates = rows.slice(0, reach);
                const detailed = await Promise.all(
                    candidates.map(async (org): Promise<Row> => {
                        const contact = await orgDetail(org.websiteKey);
                        return { ...org, ...contact, upcomingEvents: null };
                    }),
                );

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

                if (wantEvents) {
                    const nowIso = new Date().toISOString();
                    await Promise.all(
                        kept.map(async (row) => {
                            row.upcomingEvents = await orgEvents(row.id, nowIso, 2);
                        }),
                    );
                    notes.push(
                        "Most HornsLink events are recurring general meetings with no RSVPs; treat an empty list as 'nothing posted', not 'inactive'.",
                    );
                }

                const header =
                    `${matched} org(s) matched` +
                    (kept.length < matched ? `, showing ${kept.length}:` : ":");
                const body = [header, "", ...kept.map(describe)].join("\n");

                return textWith(
                    body + (notes.length ? `\n\n${notes.map((n) => `NOTE: ${n}`).join("\n")}` : ""),
                    {
                        matched,
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
