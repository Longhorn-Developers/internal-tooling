import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { resetCache } from "../src/shared";
import { registerOrgTools } from "../src/tools/orgs";
import {
    ORG_CATEGORIES,
    allOrgs,
    filterOrgs,
    matchCategory,
    orgDetail,
    queryRelevance,
    type Org,
} from "../src/tools/orgs/extract";
import {
    allOrgsUrl,
    orgEventsUrl,
    orgImageUrl,
    orgProfileUrl,
    orgSearchUrl,
} from "../src/tools/orgs/urls";
import { CAMPUS_NOW, stubFetch, toolCaller, toolTextCaller, type FetchLog } from "./fixtures";

type OrgsStructured = {
    matched: number;
    matchedMeaning: "exact" | "upstream-broad" | "before-join-filter";
    showing: number;
    notes: string[];
    orgs: {
        name: string;
        summary: string | null;
        categories: string[];
        profileUrl: string;
        imageUrl: string | null;
        email: string | null;
        instagram: string | null;
        acceptingJoinRequests: boolean;
        organizationType: string | null;
        matchesWholeQuery: boolean;
        upcomingEvents: { name: string; startsOn: string; rsvpTotal: number }[] | null;
    }[];
};

let log: FetchLog;
let call: <T>(name: string, args?: Record<string, unknown>) => Promise<T>;

beforeEach(() => {
    resetCache();
    vi.useFakeTimers();
    vi.setSystemTime(CAMPUS_NOW);
    log = stubFetch();
    call = toolCaller(registerOrgTools);
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe("urls", () => {
    // Both search endpoints silently ignore the other's page parameter and
    // return a full, unfiltered-looking result set. Getting these the wrong way
    // round is not an error upstream, it is a wrong answer.
    it("pages organizations with top and events with take", () => {
        expect(orgSearchUrl({ query: "robotics", top: 50 })).toContain("top=50");
        expect(orgSearchUrl({ query: "robotics", top: 50 })).not.toContain("take=");

        const events = orgEventsUrl("338245", "2026-11-14T00:00:00.000Z", 2);
        expect(events).toContain("take=2");
        expect(events).not.toContain("top=");
    });

    it("asks for more rows than the directory holds, so one request covers it", () => {
        // 1,226 orgs exist. A page size at the current count would start
        // truncating the moment an org is added.
        expect(allOrgsUrl()).toContain("top=1300");
    });

    it("never sends an OData filter, which upstream ignores", () => {
        const urls = [
            orgSearchUrl({ query: "x", top: 5 }),
            allOrgsUrl(),
            orgEventsUrl("1", "2026-11-14T00:00:00.000Z", 2),
        ];
        for (const url of urls) expect(url).not.toMatch(/filter=/);
    });

    it("requests one org's events, because the parameter ignores the rest", () => {
        const url = orgEventsUrl("338245", "2026-11-14T00:00:00.000Z", 2);
        expect(url.match(/organizationIds=/g)).toHaveLength(1);
        expect(url).toContain("organizationIds=338245");
    });

    it("builds a logo url with a preset, because the bare path redirects to HTML", () => {
        expect(orgImageUrl("abc.png")).toBe(
            "https://se-images.campuslabs.com/clink/images/abc.png?preset=med-sq",
        );
        expect(orgImageUrl(null)).toBeNull();
    });

    it("links to the public profile page", () => {
        expect(orgProfileUrl("unjaded")).toBe(
            "https://utexas.campuslabs.com/engage/organization/unjaded",
        );
    });
});

describe("categories", () => {
    it("takes a category as HornsLink writes it", () => {
        for (const category of ORG_CATEGORIES) expect(matchCategory(category)).toBe(category);
    });

    it('reads "sports" as Sport Clubs', () => {
        // The category is singular. A plain substring match on "sports" finds
        // nothing, which is the most likely thing a student types.
        expect(matchCategory("sports")).toBe("Sport Clubs");
        expect(matchCategory("sport")).toBe("Sport Clubs");
        expect(matchCategory("intramural")).toBe("Sport Clubs");
    });

    it("reads the other words students use", () => {
        expect(matchCategory("greek")).toBe("Sororities and Fraternities");
        expect(matchCategory("frat")).toBe("Sororities and Fraternities");
        expect(matchCategory("volunteering")).toBe("Service/Philanthropy");
        expect(matchCategory("pre-med")).toBeNull(); // a subject, not a category
    });

    it("matches a partial category name either way round", () => {
        expect(matchCategory("Cultural")).toBe("Cultural/International");
        expect(matchCategory("Sororities")).toBe("Sororities and Fraternities");
    });

    it("refuses a category that is not one", () => {
        expect(matchCategory("robotics")).toBeNull();
        expect(matchCategory("")).toBeNull();
    });

    it("refuses a fragment too short to mean a category", () => {
        // "ed" used to resolve to "Graduate Student Oriented": it contains
        // "orient-ed" and sorts before "Educational". A confident wrong
        // category is worse than refusing, because the answer looks filtered.
        expect(matchCategory("ed")).toBeNull();
        expect(matchCategory("a")).toBeNull();
        expect(matchCategory("pro")).toBeNull();
    });

    it("finds an alias inside a phrase", () => {
        expect(matchCategory("Greek life")).toBe("Sororities and Fraternities");
        expect(matchCategory("intramural sports")).toBe("Sport Clubs");
        expect(matchCategory("community service")).toBe("Service/Philanthropy");
    });

    it("refuses a phrase that points at two categories", () => {
        // "arts" and "service" each resolve on their own; together they do not.
        expect(matchCategory("arts and service")).toBeNull();
    });
});

describe("directory rows", () => {
    it("maps the legacy category names onto the published ones", async () => {
        // The category endpoint publishes 14 names; the rows carry 20. Five
        // orgs are tagged "Culture" and three "Art". Without the mapping a
        // Cultural/International filter silently drops those five.
        const rows = await allOrgs();
        const names = new Set(rows.flatMap((o) => o.categories));
        expect(names.has("Culture")).toBe(false);
        expect(names.has("Art")).toBe(false);
        expect(names.has("Student Governance")).toBe(false);
        for (const name of names) expect(ORG_CATEGORIES).toContain(name);
    });

    it("keeps a row's own categories, so a three-category org matches any of them", async () => {
        // Blanton carries Art, Culture and Educational upstream, two of which
        // are legacy names. Asserting only that every filtered row contains the
        // requested category re-states the filter's own predicate; this names
        // the org and requires it under all three, so a filter that kept just
        // the first category, or dropped the legacy mapping, fails.
        const rows = await allOrgs();
        const blanton = rows.find((org) => org.name === "Blanton Museum of Art")!;
        expect(blanton.categories).toEqual([
            "Arts/Entertainment",
            "Cultural/International",
            "Educational",
        ]);

        for (const category of blanton.categories) {
            const hits = filterOrgs(rows, { category });
            expect(hits.map((org) => org.name)).toContain("Blanton Museum of Art");
            for (const org of hits) expect(org.categories).toContain(category);
        }
    });

    it("drops rows that cannot be linked to, or are not public", async () => {
        // Synthetic, not a capture: these are the shapes the real feed is
        // documented to contain but the trimmed fixture happens not to.
        resetCache();
        vi.unstubAllGlobals();
        stubFetch({
            "top=1300": JSON.stringify({
                "@odata.count": 4,
                value: [
                    {
                        Id: "1",
                        Name: "Fine",
                        WebsiteKey: "fine",
                        Status: "Active",
                        Visibility: "Public",
                    },
                    {
                        Id: "2",
                        Name: "No key",
                        WebsiteKey: null,
                        Status: "Active",
                        Visibility: "Public",
                    },
                    {
                        Id: "3",
                        Name: "Inactive",
                        WebsiteKey: "x",
                        Status: "Inactive",
                        Visibility: "Public",
                    },
                    {
                        Id: "4",
                        Name: "Hidden",
                        WebsiteKey: "y",
                        Status: "Active",
                        Visibility: "Private",
                    },
                ],
            }),
        });
        const rows = await allOrgs();
        expect(rows.map((o) => o.name)).toEqual(["Fine"]);
    });

    it("returns a plain-text summary, never markup", async () => {
        const rows = await allOrgs();
        const withSummary = rows.filter((o) => o.summary);
        expect(withSummary.length).toBeGreaterThan(0);
        for (const org of withSummary) {
            expect(org.summary).not.toMatch(/<[a-z/]/i);
            expect(org.summary).not.toMatch(/&(nbsp|amp|#\d+);/);
        }
    });
});

describe("contact details", () => {
    it("returns the org inbox and socials", async () => {
        const contact = await orgDetail("unjaded");
        expect(contact.email).toBe("unjadedatx@gmail.com");
        expect(contact.instagram).toBe("https://www.instagram.com/unjadedatx/");
        expect(contact.website).toBe("https://www.unjadedatx.com");
        expect(contact.organizationType).toBe("Registered Student Organizations");
    });

    it("turns an empty social field into null rather than an empty string", async () => {
        // The feed writes "" for unset links, which would render as a broken
        // link if passed through.
        const contact = await orgDetail("unjaded");
        expect(contact.linkedin).toBeNull();
        expect(contact.youtube).toBeNull();
    });

    it("never carries the named officer from the feed", async () => {
        // The detail endpoint returns `primaryContact`: the officer's name, a
        // photo path, and an email field. In all five captured orgs that email
        // is null, but the NAME is populated every time, and a student's name
        // does not belong in an answer about which clubs to join.
        const raw = JSON.parse(
            await (await fetch("https://x/engage/api/discovery/organization/bykey/unjaded")).text(),
        ) as { primaryContact?: { lastName?: string } };
        const officer = raw.primaryContact?.lastName;
        expect(officer).toBeTruthy(); // it IS in the feed

        const contact = await orgDetail("unjaded");
        expect(JSON.stringify(contact)).not.toContain(officer!);
        expect(Object.keys(contact)).not.toContain("primaryContact");
    });
});

describe("find_orgs", () => {
    it("searches by keyword and returns linkable rows", async () => {
        const result = await call<OrgsStructured>("find_orgs", { query: "robotics" });
        expect(result.matched).toBe(4);
        expect(result.orgs.length).toBe(4);
        for (const org of result.orgs) {
            expect(org.profileUrl).toMatch(/^https:\/\/utexas\.campuslabs\.com\/engage\//);
            expect(org.name).toBeTruthy();
        }
        expect(result.orgs.map((o) => o.name)).toContain("Texas Robotics Graduate Students");
    });

    it("sends the query upstream rather than pulling the directory", async () => {
        await call("find_orgs", { query: "robotics" });
        // One search plus one detail per returned row. Crucially NOT the 1.8 MB
        // directory, which a client-side search would need.
        expect(log.some((entry) => entry.url.includes("top=1300"))).toBe(false);
        expect(log.filter((entry) => entry.url.includes("query=robotics"))).toHaveLength(1);
    });

    it("reports upstream's total, not the size of its own fetch", async () => {
        // The count used to be `rows.length` after a 50-row fetch, so every
        // broad query reported exactly 50 and read as a real total. Upstream
        // says 88 for "women" and 238 for "ai".
        resetCache();
        vi.unstubAllGlobals();
        stubFetch({
            "query=women": JSON.stringify({
                "@odata.count": 88,
                value: [
                    {
                        Id: "1",
                        Name: "Women in Computing",
                        WebsiteKey: "wic",
                        Status: "Active",
                        Visibility: "Public",
                        CategoryNames: ["Academic"],
                    },
                ],
            }),
        });
        const result = await toolCaller(registerOrgTools)<OrgsStructured>("find_orgs", {
            query: "women",
        });
        expect(result.matched).toBe(88);
        expect(result.showing).toBe(1);
        expect(result.notes.join(" ")).toMatch(/broad total/);
    });

    it("takes the whole ranked set when a category has to be applied too", async () => {
        // Filtering a 50-row relevance window by category drops every
        // lower-ranked match in that category and reports the survivors as the
        // total. Upstream serves its full ranked result in one request.
        await call("find_orgs", { query: "robotics", category: "Academic" });
        const searches = log.filter((entry) => entry.url.includes("query=robotics"));
        expect(searches).toHaveLength(1);
        expect(searches[0]!.url).toContain("top=1300");
    });

    it("keeps the cheap fetch when there is no category to apply", async () => {
        await call("find_orgs", { query: "robotics" });
        const searches = log.filter((entry) => entry.url.includes("query=robotics"));
        expect(searches[0]!.url).toContain("top=50");
    });

    it("reports upstream's own total on a query, not the rows it fetched", async () => {
        // The bug this pins: reporting our fetch size as the match count made
        // every broad query answer with exactly SEARCH_OVERFETCH and read as a
        // real number. Upstream's `@odata.count` here is far above the rows it
        // returns, which is what any one-word query looks like.
        resetCache();
        vi.unstubAllGlobals();
        stubFetch({
            "query=ai": JSON.stringify({
                "@odata.count": 238,
                value: [
                    { Id: "1", Name: "AI Alliance", WebsiteKey: "aialliance", CategoryNames: [] },
                    { Id: "2", Name: "Aikido Club", WebsiteKey: "aikido", CategoryNames: [] },
                ],
            }),
        });
        const result = await toolCaller(registerOrgTools)<OrgsStructured>("find_orgs", {
            query: "ai",
        });
        expect(result.matched).toBe(238);
        expect(result.showing).toBe(2);
        // And it has to say the total is broad, or 238 reads as 238 AI clubs.
        expect(result.notes.join(" ")).toMatch(/matched any word in "ai", so 238 is a broad total/);
    });

    it("counts a category browse by the rows it actually filtered", async () => {
        // The category path has no upstream count to borrow: `categoryIds` is
        // ignored, so the filtering is ours and so is the number. It must not
        // report `@odata.count` (1226) as the number of Sport Clubs.
        const result = await call<OrgsStructured>("find_orgs", { category: "Sport Clubs" });
        expect(result.matched).toBeGreaterThan(0);
        expect(result.matched).toBeLessThan(1226);
        const everything = await allOrgs();
        const expected = everything.filter((org) => org.categories.includes("Sport Clubs")).length;
        expect(result.matched).toBe(expected);
    });

    it("counts the uncategorized orgs from the directory rather than a constant", async () => {
        // The old assertion pinned the literal "87 of the 1,226", which came
        // from a hardcoded constant, so it passed happily while upstream moved
        // to 1,227 and 88. These numbers now have to match the fixture.
        const directory = await allOrgs();
        const uncategorized = directory.filter((org) => org.categories.length === 0).length;
        expect(uncategorized).toBeGreaterThan(0);

        resetCache();
        const result = await call<OrgsStructured>("find_orgs", { category: "Academic" });
        expect(result.notes.join(" ")).toContain(
            `${uncategorized} of the ${directory.length} orgs carry no category`,
        );
    });

    it("lists the categories when given one that is not a category", async () => {
        const result = await call<OrgsStructured>("find_orgs", { category: "quidditch" });
        expect(result.matched).toBe(0);
        expect(result.notes.join(" ")).toMatch(/Unknown category/);
    });

    it("says when it read a loose category word as a real category", async () => {
        const result = await call<OrgsStructured>("find_orgs", { category: "greek" });
        expect(result.notes.join(" ")).toMatch(/Sororities and Fraternities/);
    });

    it("includes events only when asked, and one request per org", async () => {
        const without = await call<OrgsStructured>("find_orgs", { query: "robotics" });
        for (const org of without.orgs) expect(org.upcomingEvents).toBeNull();
        expect(log.some((entry) => entry.url.includes("event/search"))).toBe(false);

        resetCache();
        const withEvents = await call<OrgsStructured>("find_orgs", {
            query: "robotics",
            withUpcomingEvents: true,
        });
        const eventCalls = log.filter((entry) => entry.url.includes("event/search"));
        expect(eventCalls).toHaveLength(withEvents.orgs.length);
        for (const org of withEvents.orgs) expect(org.upcomingEvents).not.toBeNull();
    });

    it("caps rows lower when events are requested, and says so", async () => {
        // The whole directory, so there really are more matches than the cap.
        // Asserting this against a 4-row category was asserting that the tool
        // announces a cap that did not bite.
        const result = await call<OrgsStructured>("find_orgs", {
            withUpcomingEvents: true,
            limit: 15,
        });
        expect(result.matched).toBeGreaterThan(8);
        expect(result.orgs.length).toBe(8);
        expect(result.notes.join(" ")).toMatch(/Capped at 8 rows/);
    });

    it("does not announce a cap when fewer orgs matched than the cap", async () => {
        // "Capped at 8 rows" on a search that matched 4 told the student
        // results were being withheld that never existed.
        const result = await call<OrgsStructured>("find_orgs", {
            query: "robotics",
            withUpcomingEvents: true,
            limit: 15,
        });
        expect(result.orgs.length).toBeLessThan(8);
        expect(result.notes.join(" ")).not.toMatch(/Capped at/);
    });

    it("stays inside the subrequest budget at full stretch", async () => {
        await call("find_orgs", {
            category: "Academic",
            withUpcomingEvents: true,
            acceptingMembers: true,
            limit: 15,
        });
        // A Worker invocation gets 50 and this tool is not the only thing that
        // might run in one. Pinned to the documented worst case (1 search + 15
        // detail + 8 event requests) rather than to the ceiling, so a
        // regression that doubles the requests fails here instead of passing
        // quietly under 50.
        expect(log.length).toBeLessThanOrEqual(24);
    });

    it("says its count is from before the join-request filter", async () => {
        // The count cannot include the filter: the field lives on the detail
        // endpoint, one request per org, so only `reach` rows are ever checked.
        const text = await toolTextCaller(registerOrgTools)("find_orgs", {
            category: "Academic",
            acceptingMembers: true,
        });
        expect(text).toMatch(/matched before the join-request filter/);
    });

    it("drops an org that is not accepting join requests", async () => {
        // Blanton Museum of Art is the one captured org with `showJoin: false`,
        // and it shares the Educational category with four that are open. The
        // unfiltered call has to show it or this proves nothing: a test that
        // only asserts every returned row is `true` passes with the filter
        // deleted, because every other fixture is `true`.
        const all = await call<OrgsStructured>("find_orgs", {
            category: "Educational",
            limit: 15,
        });
        const names = all.orgs.map((org) => org.name);
        expect(names).toContain("Blanton Museum of Art");

        resetCache();
        const open = await call<OrgsStructured>("find_orgs", {
            category: "Educational",
            acceptingMembers: true,
            limit: 15,
        });
        expect(open.orgs.map((org) => org.name)).not.toContain("Blanton Museum of Art");
        expect(open.orgs.length).toBe(all.orgs.length - 1);
        // Counted before the filter, so the total does not move.
        expect(open.matched).toBe(all.matched);
        for (const org of open.orgs) expect(org.acceptingJoinRequests).toBe(true);
    });

    it("reads the join field from the detail endpoint, not the search row", async () => {
        // The search rows carry no join field at all, so the filter can only
        // work if the per-org detail request happened.
        const directory = await allOrgs();
        expect(directory.some((org) => org.name === "Blanton Museum of Art")).toBe(true);
        expect(Object.keys(directory[0]!)).not.toContain("acceptingJoinRequests");

        const detail = await orgDetail("blantonmuseum");
        expect(detail.acceptingJoinRequests).toBe(false);
    });

    it("answers with prose as well as data, and the two agree", async () => {
        const structured = await call<OrgsStructured>("find_orgs", { query: "robotics" });
        resetCache();
        const text = await toolTextCaller(registerOrgTools)("find_orgs", { query: "robotics" });

        expect(structured.orgs.length).toBeGreaterThan(0);
        // An agent may read either half, so a name or a count that appears in
        // one and not the other is a wrong answer half the time.
        expect(text).toContain(`${structured.matched} org(s) matched`);
        for (const org of structured.orgs) {
            expect(text).toContain(org.name);
            expect(text).toContain(org.profileUrl);
        }
        for (const note of structured.notes) expect(text).toContain(note);
    });

    it("says plainly when nothing matched", async () => {
        resetCache();
        vi.unstubAllGlobals();
        stubFetch({ "query=robotics": JSON.stringify({ "@odata.count": 0, value: [] }) });
        const text = await toolTextCaller(registerOrgTools)("find_orgs", { query: "robotics" });
        // The prose has to say so too: an agent handed an empty array and no
        // sentence tends to invent an explanation for it.
        expect(text).toMatch(/No HornsLink org matched "robotics"/);

        resetCache();
        const result = await toolCaller(registerOrgTools)<OrgsStructured>("find_orgs", {
            query: "robotics",
        });
        expect(result.matched).toBe(0);
        expect(result.orgs).toEqual([]);
    });

    it("rejects an unknown argument rather than ignoring it", async () => {
        const caller = toolCaller(registerOrgTools);
        await expect(caller("find_orgs", { querry: "robotics" })).rejects.toThrow();
    });
});

/** Shapes used above that the trimmed fixture does not contain. */
const SYNTHETIC: Org = {
    id: "1",
    name: "Example",
    summary: null,
    categories: [],
    profileUrl: "https://utexas.campuslabs.com/engage/organization/example",
    imageUrl: null,
    websiteKey: "example",
};

describe("filterOrgs", () => {
    it("matches words against the name and the summary", () => {
        const rows: Org[] = [
            { ...SYNTHETIC, id: "1", name: "Climbing Club" },
            { ...SYNTHETIC, id: "2", name: "Quiet Society", summary: "We go bouldering weekly." },
            { ...SYNTHETIC, id: "3", name: "Chess" },
        ];
        expect(filterOrgs(rows, { query: "climbing" }).map((o) => o.id)).toEqual(["1"]);
        expect(filterOrgs(rows, { query: "bouldering" }).map((o) => o.id)).toEqual(["2"]);
    });

    it("ignores punctuation and case in a name", () => {
        const rows: Org[] = [{ ...SYNTHETIC, name: "(un)Jaded" }];
        expect(filterOrgs(rows, { query: "unjaded" })).toHaveLength(1);
        expect(filterOrgs(rows, { query: "UNJADED" })).toHaveLength(1);
    });

    it("returns everything when given no filters", () => {
        const rows: Org[] = [SYNTHETIC];
        expect(filterOrgs(rows, {})).toHaveLength(1);
    });
});

/**
 * Each of these answered a real student question confidently and wrongly at
 * some point, so they are the cases to re-check when the matching changes.
 */
describe("loose matches, and saying so", () => {
    it("says so when nothing matched all of the query", async () => {
        // `query: "muay thai"` returned the Thai Association of Austin and the
        // Thai Lao Cambodian Student Association with notes: [] -- there is no
        // muay thai club at UT, and upstream had matched on "thai" alone.
        resetCache();
        vi.unstubAllGlobals();
        stubFetch({
            "query=muay": JSON.stringify({
                "@odata.count": 2,
                value: [
                    {
                        Id: "1",
                        Name: "Thai Association of Austin",
                        WebsiteKey: "thaiaustin",
                        CategoryNames: ["Social"],
                        Summary: "Fostering Thai culture in Austin.",
                    },
                    {
                        Id: "2",
                        Name: "Thai Lao Cambodian Student Association",
                        WebsiteKey: "tlcsa",
                        CategoryNames: ["Culture"],
                    },
                ],
            }),
        });
        const result = await toolCaller(registerOrgTools)<OrgsStructured>("find_orgs", {
            query: "muay thai",
        });
        expect(result.orgs).toHaveLength(2);
        const notes = result.notes.join(" ");
        expect(notes).toMatch(/No org here matched all of "muay thai"/);
        // And it names which word did the matching, so the agent can say why.
        expect(notes).toMatch(/"thai"/);
        expect(notes).toMatch(/near misses/);
    });

    it("stays quiet when the rows really do match the query", async () => {
        // The hedge must not fire on a good answer, or it is noise that
        // teaches the agent to ignore it.
        const result = await call<OrgsStructured>("find_orgs", { query: "robotics" });
        expect(result.orgs.length).toBeGreaterThan(0);
        expect(result.notes.join(" ")).not.toMatch(/near misses/);
    });

    it("hedges the count on the query-plus-category path too", async () => {
        // This path had no hedge at all, and removing the top-50 relevance cut
        // made its count the least trustworthy of the three: "pre-med" in
        // Pre-Professional/Career reports 179, of which 16 mention medicine.
        const result = await call<OrgsStructured>("find_orgs", {
            query: "robotics",
            category: "Academic",
        });
        expect(result.notes.join(" ")).toMatch(/matched any word in "robotics"/);
    });

    describe('the "club" category alias', () => {
        it('does not read "<anything> club" as Recreational', async () => {
            // `category: "pre-med club"` resolved to Recreational and returned
            // 52 rows with a note claiming it had read the category.
            const result = await call<OrgsStructured>("find_orgs", { category: "pre-med club" });
            expect(result.matched).toBe(0);
            expect(result.notes.join(" ")).toMatch(/Unknown category/);
        });

        it('resolves "sports club" and "sports clubs" the same way', async () => {
            // "sports clubs" worked while "sports club" was refused as
            // ambiguous, because the second hit both `sports` and `club`.
            const plural = await call<OrgsStructured>("find_orgs", { category: "sports clubs" });
            resetCache();
            const singular = await call<OrgsStructured>("find_orgs", { category: "sports club" });
            expect(singular.matched).toBe(plural.matched);
            expect(singular.matched).toBeGreaterThan(0);
        });

        it('still accepts "club" on its own', async () => {
            const result = await call<OrgsStructured>("find_orgs", { category: "club" });
            expect(result.matched).toBeGreaterThan(0);
            expect(result.notes.join(" ")).toMatch(/as the category "Recreational"/);
        });
    });

    it("marks the count as provisional when the join filter ran", async () => {
        // The prose said "before the join-request filter" and the structured
        // half said only `matched: 43`, so an agent on the data path reported
        // 43 orgs accepting members when the tool had checked 15.
        const filtered = await call<OrgsStructured>("find_orgs", {
            category: "Educational",
            acceptingMembers: true,
        });
        expect(filtered.matchedMeaning).toBe("before-join-filter");

        resetCache();
        const plain = await call<OrgsStructured>("find_orgs", { category: "Educational" });
        expect(plain.matchedMeaning).toBe("exact");
    });

    it("still answers when one org's detail request fails", async () => {
        // Contact details are an enrichment. One 404 used to fail the whole
        // answer, losing the name, summary and link of every other org.
        resetCache();
        vi.unstubAllGlobals();
        const log = stubFetch();
        const original = globalThis.fetch;
        vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
            const url =
                typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
            if (url.includes("organization/bykey/trgs")) {
                return new Response("not found", { status: 404 });
            }
            return original(input as never, init);
        });

        const result = await toolCaller(registerOrgTools)<OrgsStructured>("find_orgs", {
            query: "robotics",
        });
        expect(result.orgs.length).toBeGreaterThan(0);
        expect(result.notes.join(" ")).toMatch(/did not answer for 1 org/);
        // The org is still listed, with what the search row carried.
        const trgs = result.orgs.find((org) => org.name === "Texas Robotics Graduate Students");
        expect(trgs).toBeTruthy();
        expect(trgs!.profileUrl).toContain("trgs");
        expect(trgs!.email).toBeNull();
        expect(log.length).toBeGreaterThan(0);
    });

    it('labels only the first of an org\'s events "Next:"', async () => {
        // Each org legitimately has one next event. The bug was WITHIN an org:
        // two events both read "Next: ... / Next: ...".
        const structured = await call<OrgsStructured>("find_orgs", {
            query: "robotics",
            withUpcomingEvents: true,
        });
        const withTwo = structured.orgs.filter((org) => (org.upcomingEvents ?? []).length > 1);
        expect(withTwo.length).toBeGreaterThan(0);

        resetCache();
        const text = await toolTextCaller(registerOrgTools)("find_orgs", {
            query: "robotics",
            withUpcomingEvents: true,
        });
        // One block per org. The rows are not blank-line separated: an org's
        // name line starts at column 0 and its detail lines are indented.
        for (const block of text.split(/\n(?=\S)/)) {
            expect((block.match(/ Next: /g) ?? []).length).toBeLessThanOrEqual(1);
        }
        expect(text).toContain("Then:");
    });
});

describe("input limits", () => {
    it("refuses an over-long query instead of passing it to a 404", async () => {
        // HornsLink answers 404 to a very long query, which surfaced as
        // "utexas.campuslabs.com returned HTTP 404" -- an agent reads that as
        // the directory being down.
        await expect(call("find_orgs", { query: "a".repeat(3000) })).rejects.toThrow(/too long/);
    });

    it("still accepts a realistic multi-word query", async () => {
        const result = await call<OrgsStructured>("find_orgs", { query: "robotics" });
        expect(result.orgs.length).toBeGreaterThan(0);
    });
});

describe("what a count means, and which rows actually matched", () => {
    it("does not claim an upstream any-word total is an exact count", async () => {
        // `query: "a cappella"` answered matched 1222 with matchedIsFinal
        // true, 1,222 being HornsLink's count of every org matching "a" OR
        // "cappella". The flag asserted finality over the least final number
        // the tool produces.
        resetCache();
        vi.unstubAllGlobals();
        stubFetch({
            "query=a": JSON.stringify({
                "@odata.count": 1222,
                value: [
                    {
                        Id: "1",
                        Name: "Re:Sound A Cappella",
                        WebsiteKey: "resound",
                        CategoryNames: [],
                    },
                ],
            }),
        });
        const result = await toolCaller(registerOrgTools)<OrgsStructured>("find_orgs", {
            query: "a cappella",
        });
        expect(result.matched).toBe(1222);
        expect(result.matchedMeaning).toBe("upstream-broad");
    });

    it("marks the irrelevant rows when only some matched the whole query", async () => {
        // "climbing" returns Texas Rock Climbing AND the American Society of
        // Mechanical Engineers, formatted identically, with notes: []. The
        // hedge was gated on NO row matching, so one good row silenced it.
        resetCache();
        vi.unstubAllGlobals();
        stubFetch({
            "query=climbing": JSON.stringify({
                "@odata.count": 2,
                value: [
                    {
                        Id: "1",
                        Name: "Texas Rock Climbing",
                        WebsiteKey: "txclimbing",
                        CategoryNames: ["Sport Clubs"],
                        Summary: "The official climbing team at UT Austin.",
                    },
                    {
                        Id: "2",
                        Name: "American Society of Mechanical Engineers",
                        WebsiteKey: "asme",
                        CategoryNames: ["Academic"],
                        Summary: "Aiding students in their professional development.",
                    },
                ],
            }),
        });
        const result = await toolCaller(registerOrgTools)<OrgsStructured>("find_orgs", {
            query: "climbing",
        });
        expect(result.orgs).toHaveLength(2);
        const byName = new Map(result.orgs.map((org) => [org.name, org]));
        expect(byName.get("Texas Rock Climbing")!.matchesWholeQuery).toBe(true);
        expect(byName.get("American Society of Mechanical Engineers")!.matchesWholeQuery).toBe(
            false,
        );
        expect(result.notes.join(" ")).toMatch(
            /1 of these matched only part of "climbing".*Mechanical Engineers/,
        );
    });

    it("can register a hyphenated query as a near miss", async () => {
        // queryRelevance split "pre-med" into "pre" and "med", which norm()
        // then found inside "president" and "media", so a hyphenated query
        // could never be reported as loose.
        const rows = [
            { name: "Presidential Media Society", summary: "About the presidency and media." },
        ].map((r, i) => ({
            id: String(i),
            name: r.name,
            summary: r.summary,
            categories: [],
            profileUrl: "https://example.test/x",
            imageUrl: null,
            websiteKey: `k${i}`,
        }));
        const relevance = queryRelevance(rows, "pre-med");
        expect(relevance.matchedAll).toHaveLength(0);
        expect(relevance.missing).toContain("pre-med");
    });

    it("matches a hyphenated query across the punctuation", async () => {
        const rows = [
            { name: "Plan II Pre Med Society", summary: "Pre-medical students." },
            { name: "Premed Longhorns", summary: "" },
        ].map((r, i) => ({
            id: String(i),
            name: r.name,
            summary: r.summary,
            categories: [],
            profileUrl: "https://example.test/x",
            imageUrl: null,
            websiteKey: `k${i}`,
        }));
        expect(queryRelevance(rows, "pre-med").matchedAll).toHaveLength(2);
    });

    it("does not hedge a one-row exact answer twice", async () => {
        // One perfect row got two notes, one of which read "these 1 are" and
        // talked about "the lower-ranked ones" that do not exist. That is how
        // an agent learns the notes are boilerplate.
        const result = await call<OrgsStructured>("find_orgs", {
            query: "robotics",
            category: "Academic",
        });
        if (result.matched === 1) {
            expect(result.notes.join(" ")).not.toMatch(/lower-ranked/);
        }
        expect(result.notes.join(" ")).not.toMatch(/these 1 are/);
    });
    it("does not hedge a single exact row about its lower-ranked siblings", async () => {
        // One perfect row got a note reading "these 1 are" and warning about
        // "the lower-ranked ones" that do not exist.
        resetCache();
        vi.unstubAllGlobals();
        stubFetch({
            "query=quilting": JSON.stringify({
                "@odata.count": 1,
                value: [
                    {
                        Id: "1",
                        Name: "Longhorn Quilting Guild",
                        WebsiteKey: "quilting",
                        CategoryNames: ["Recreational"],
                        Summary: "A quilting club.",
                    },
                ],
            }),
        });
        const result = await toolCaller(registerOrgTools)<OrgsStructured>("find_orgs", {
            query: "quilting",
            category: "Recreational",
        });
        expect(result.matched).toBe(1);
        const notes = result.notes.join(" ");
        expect(notes).not.toMatch(/lower-ranked/);
        expect(notes).not.toMatch(/these 1 are/);
    });
});
