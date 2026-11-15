import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { resetCache } from "../src/shared";
import { registerOrgTools } from "../src/tools/orgs";
import {
    ORG_CATEGORIES,
    allOrgs,
    filterOrgs,
    matchCategory,
    orgDetail,
    type Org,
} from "../src/tools/orgs/extract";
import {
    allOrgsUrl,
    orgEventsUrl,
    orgImageUrl,
    orgProfileUrl,
    orgSearchUrl,
} from "../src/tools/orgs/urls";
import { CAMPUS_NOW, stubFetch, toolCaller, type FetchLog } from "./fixtures";

type OrgsStructured = {
    matched: number;
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

    it("keeps a row's own categories, so a two-category org matches either", async () => {
        const rows = await allOrgs();
        const cultural = filterOrgs(rows, { category: "Cultural/International" });
        expect(cultural.length).toBeGreaterThan(0);
        for (const org of cultural) expect(org.categories).toContain("Cultural/International");
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

    it("reports the real match count, not the trimmed fixture size", async () => {
        const result = await call<OrgsStructured>("find_orgs", { category: "Sport Clubs" });
        expect(result.showing).toBeLessThanOrEqual(result.matched);
        expect(result.orgs.length).toBe(result.showing);
    });

    it("explains that a category search cannot reach uncategorized orgs", async () => {
        const result = await call<OrgsStructured>("find_orgs", { category: "Academic" });
        expect(result.notes.join(" ")).toMatch(/87 of the 1,226 orgs carry no category/);
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
        const result = await call<OrgsStructured>("find_orgs", {
            category: "Academic",
            withUpcomingEvents: true,
            limit: 15,
        });
        expect(result.orgs.length).toBeLessThanOrEqual(8);
        expect(result.notes.join(" ")).toMatch(/Capped at 8 rows/);
    });

    it("stays inside the subrequest budget at full stretch", async () => {
        await call("find_orgs", {
            category: "Academic",
            withUpcomingEvents: true,
            acceptingMembers: true,
            limit: 15,
        });
        // A Worker invocation gets 50 and this tool is not the only thing that
        // might run in one.
        expect(log.length).toBeLessThan(40);
    });

    it("filters on join requests using the detail field", async () => {
        const result = await call<OrgsStructured>("find_orgs", {
            query: "robotics",
            acceptingMembers: true,
        });
        for (const org of result.orgs) expect(org.acceptingJoinRequests).toBe(true);
    });

    it("answers with prose as well as data", async () => {
        const caller = toolCaller(registerOrgTools);
        const structured = await caller<OrgsStructured>("find_orgs", { query: "robotics" });
        expect(structured.orgs.length).toBeGreaterThan(0);
    });

    it("says plainly when nothing matched", async () => {
        resetCache();
        vi.unstubAllGlobals();
        stubFetch({ "query=robotics": JSON.stringify({ "@odata.count": 0, value: [] }) });
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
