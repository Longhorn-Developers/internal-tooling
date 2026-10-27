import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { resetCache } from "../src/lib/http";
import {
    LABEL_BUDGET,
    austinNow,
    getLocationDetail,
    getLocations,
    getMenu,
    getNutrition,
    getFeedHours,
    hoursForDate,
    parseDate,
    searchMenuItems,
    statusAt,
    withNutrition,
} from "../src/lib/dining";
import { FIXED_NOW, fixture, stubFetch } from "./fixtures";

beforeEach(() => {
    resetCache();
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    stubFetch();
});
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe("austinNow", () => {
    it("reports Austin local time, not UTC", () => {
        const now = austinNow();
        expect(now.hour).toBe(15); // 20:44 UTC is 15:44 CDT
        expect(now.mdy).toBe("10/15/2026");
        expect(now.weekday).toBe("Thursday");
    });

    it("indexes Monday as 0 to match the hours feed", () => {
        expect(austinNow().dayIndex).toBe(3); // Thursday
    });

    it("handles the UTC date being a day ahead of Austin", () => {
        vi.setSystemTime(new Date("2026-10-16T02:30:00Z")); // 9:30pm Oct 15 in Austin
        const now = austinNow();
        expect(now.mdy).toBe("10/15/2026");
        expect(now.hour).toBe(21);
    });

    it("follows the switch from CDT to CST", () => {
        // DST ends 2026-11-01. 2026-11-15 06:30 UTC is 00:30 CST, still the 15th.
        vi.setSystemTime(new Date("2026-11-15T06:30:00Z"));
        const now = austinNow();
        expect(now.mdy).toBe("11/15/2026");
        expect(now.hour).toBe(0);
    });
});

describe("parseDate", () => {
    it("defaults to today in Austin", () => {
        expect(parseDate()).toBe("10/15/2026");
        expect(parseDate("today")).toBe("10/15/2026");
    });

    it("reads relative, weekday, ISO and US forms", () => {
        expect(parseDate("tomorrow")).toBe("10/16/2026");
        expect(parseDate("yesterday")).toBe("10/14/2026");
        expect(parseDate("friday")).toBe("10/16/2026");
        expect(parseDate("2026-11-26")).toBe("11/26/2026");
        expect(parseDate("11/26/2026")).toBe("11/26/2026");
        expect(parseDate("1/5")).toBe("01/05/2026");
    });

    it("treats a bare weekday as the next one, today included", () => {
        expect(parseDate("thursday")).toBe("10/15/2026"); // today
        expect(parseDate("wednesday")).toBe("10/21/2026"); // a week out
    });

    it("rolls over a month boundary", () => {
        vi.setSystemTime(new Date("2026-10-31T20:00:00Z"));
        expect(parseDate("tomorrow")).toBe("11/01/2026");
    });

    it("rolls over a year boundary", () => {
        vi.setSystemTime(new Date("2026-12-31T20:00:00Z"));
        expect(parseDate("tomorrow")).toBe("01/01/2027");
    });

    it("rejects nonsense rather than guessing", () => {
        expect(() => parseDate("whenever")).toThrow(/Couldn't read date/);
    });
});

describe("hours parsing", () => {
    it("parses a plain range into minutes past midnight", async () => {
        const period = await hoursForDate("10/15/2026");
        const j2 = period.locations.find((l) => l.name === "J2 Dining")!;
        expect(j2.week[0]).toEqual([{ start: 420, end: 1320, label: "7:00am-10:00pm" }]);
    });

    it("splits a two-service day into separate ranges", async () => {
        const period = await hoursForDate("10/15/2026");
        const j2 = period.locations.find((l) => l.name === "J2 Dining")!;
        expect(j2.week[5]).toHaveLength(2); // Saturday: 9-2 and 4:30-9
        expect(j2.week[5]![1]).toMatchObject({ start: 16 * 60 + 30, end: 21 * 60 });
    });

    it("treats Midnight as the end of the day, not the start", async () => {
        const period = await hoursForDate("10/15/2026");
        const jesta = period.locations.find((l) => l.name === "Jesta Pizza")!;
        expect(jesta.week[0]).toEqual([{ start: 16 * 60, end: 24 * 60, label: "4:00pm-Midnight" }]);
    });

    it("parses Noon as midday", async () => {
        const period = await hoursForDate("10/15/2026");
        const longhorn = period.locations.find((l) => l.name === "Longhorn Coffee Co.")!;
        expect(longhorn.week[6]).toEqual([{ start: 12 * 60, end: 17 * 60, label: "Noon-5:00pm" }]);
    });

    it("maps Closed to null", async () => {
        const period = await hoursForDate("10/15/2026");
        const jcl = period.locations.find((l) => l.name === "Jester City Limits")!;
        expect(jcl.week[5]).toBeNull();
        expect(jcl.week[6]).toBeNull();
    });
});

describe("hoursForDate picks the most specific schedule", () => {
    // Regression: break schedules are nested inside the semester's date range,
    // so a naive "first period that covers this date" returns the semester one.
    it("uses the Thanksgiving break schedule inside the semester range", async () => {
        const period = await hoursForDate("11/26/2026");
        // UT misspells this one in the feed ("Thanskgiving"), so match the range.
        expect(period.label).toMatch(/Break \(11\/23\/26 - 11\/29\/26\)/);
        const j2 = period.locations.find((l) => l.name === "J2 Dining")!;
        expect(j2.week[3]).toBeNull(); // Thanksgiving Day, closed
    });

    // Regression: the feed holds every period, not just the semester, and reading
    // only the first one had J2 open on Thanksgiving.
    it("reads every period the feed publishes, not just the first", async () => {
        const periods = await getFeedHours();
        expect(periods.length).toBeGreaterThan(1);
        expect(periods.map((p) => p.label).join("|")).toMatch(/Than(ks|sk)giving Break/);
        expect(periods.every((p) => p.locations.length > 0)).toBe(true);
    });

    it("still uses the semester schedule on an ordinary day", async () => {
        const period = await hoursForDate("10/20/2026");
        expect(period.label).toMatch(/Fall 2026 Semester/);
    });

    it("trusts the live feed for today", async () => {
        const period = await hoursForDate("10/15/2026");
        expect(period.label).toMatch(/Fall 2026 Semester/);
    });
});

describe("open/closed status", () => {
    it("reports a location open mid-service with the right countdown", async () => {
        const rows = await statusAt("10/15/2026", 15 * 60 + 44);
        const j2 = rows.find((r) => r.name === "J2 Dining")!;
        expect(j2.open).toBe(true);
        expect(j2.closesIn).toBe(6 * 60 + 16);
    });

    it("reports closed between two services, with time until reopening", async () => {
        // Saturday: 9:00-2:00 then 4:30-9:00. At 3pm it is between services.
        const rows = await statusAt("10/17/2026", 15 * 60);
        const j2 = rows.find((r) => r.name === "J2 Dining")!;
        expect(j2.open).toBe(false);
        expect(j2.opensIn).toBe(90);
    });

    it("counts a late-night location as open before midnight", async () => {
        const rows = await statusAt("10/15/2026", 23 * 60 + 30);
        const jesta = rows.find((r) => r.name === "Jesta Pizza")!;
        expect(jesta.open).toBe(true);
        expect(jesta.closesIn).toBe(30);
    });

    it("is closed on a day with no service", async () => {
        const rows = await statusAt("10/17/2026", 12 * 60); // Saturday
        const panda = rows.find((r) => r.name === "Panda Express")!;
        expect(panda.open).toBe(false);
        expect(panda.hours).toBe("Closed");
    });

    it("maps each weekday to the right column", async () => {
        // Jester City Limits closes early Friday (3pm) and is shut at weekends.
        const friday = await statusAt("10/16/2026", 16 * 60);
        expect(friday.find((r) => r.name === "Jester City Limits")!.open).toBe(false);
        const thursday = await statusAt("10/15/2026", 16 * 60);
        expect(thursday.find((r) => r.name === "Jester City Limits")!.open).toBe(true);
    });
});

describe("locations", () => {
    it("lists every location the hours feed knows, including food trucks", async () => {
        const locs = await getLocations();
        expect(locs.length).toBeGreaterThanOrEqual(26);
        expect(locs.map((l) => l.name)).toContain("La Fonda Food Trailer");
        expect(locs.find((l) => l.name === "La Fonda Food Trailer")!.category).toBe("Food Trucks");
    });

    it("attaches coordinates where FoodPro publishes them", async () => {
        const locs = await getLocations();
        const j2 = locs.find((l) => l.name === "J2 Dining")!;
        expect(j2.lat).toBeCloseTo(30.28, 1);
        expect(j2.lon).toBeCloseTo(-97.73, 1);
    });

    it("reads description, address, building and payment from a detail page", async () => {
        const noodle = await getLocationDetail("Noodle Lab");
        expect(noodle!.description).toMatch(/ramen/i);
        expect(noodle!.address).toMatch(/2308 Whitis Ave/);
        expect(noodle!.building).toBe("Union Building");
        expect(noodle!.payment).toEqual(["Cash", "Credit Debit", "Dine In Dollars"]);
    });

    it("matches a location on a partial name", async () => {
        expect((await getLocationDetail("noodle"))!.name).toBe("Noodle Lab");
    });

    it("returns null for an unknown location", async () => {
        expect(await getLocationDetail("Taco Bell")).toBeNull();
    });
});

describe("menus", () => {
    it("groups items under meal and station", async () => {
        const menu = await getMenu("J2", "10/15/2026");
        expect(menu.location).toBe("J2 Dining");
        expect(menu.meals.map((m) => m.meal)).toEqual(["Breakfast", "Lunch", "Dinner"]);
        const stations = menu.meals[0]!.sections.map((s) => s.section);
        expect(stations).toContain("Breakfast Bakery");
        expect(stations.every((s) => !s.includes("--"))).toBe(true);
    });

    it("never emits a section marker as a food item", async () => {
        const menu = await getMenu("J2", "10/15/2026");
        const items = menu.meals.flatMap((m) => m.sections.flatMap((s) => s.items));
        expect(items.every((i) => i.number !== "")).toBe(true);
        expect(items.some((i) => i.name.startsWith("--"))).toBe(false);
    });

    it("carries diet tags from the recipe table", async () => {
        const menu = await getMenu("J2", "10/15/2026");
        const items = menu.meals.flatMap((m) => m.sections.flatMap((s) => s.items));
        expect(items.some((i) => i.legends.includes("VGN"))).toBe(true);
        expect(items.every((i) => i.name.length > 0)).toBe(true);
    });

    // The feed holds one nutrient array per recipe, but a recipe is served at
    // different portions in different halls and the array matches neither
    // consistently. Recipe 081906 reports 299 kcal at portionSize "3 oz" and is
    // served at serv=3, while its label for 081906*3 says 897.
    it("never takes nutrition from the feed, even for a whole serving", async () => {
        const menu = await getMenu("J2", "10/14/2026", "Dinner");
        const items = menu.meals.flatMap((m) => m.sections.flatMap((s) => s.items));
        const bacon = items.find((i) => i.number === "081906")!;
        expect(bacon.serving).toBe("3");

        await withNutrition([bacon]);
        expect(bacon.nutrition?.source).toBe("label");
        expect(Math.round(bacon.nutrition!.calories!)).toBe(897); // not the feed's 299
        expect(Math.round(bacon.nutrition!.protein!)).toBe(22);
    });

    it("reuses one label for items repeated across stations", async () => {
        const log = stubFetch();
        const menu = await getMenu("J2", "10/14/2026", "Dinner");
        const items = menu.meals.flatMap((m) => m.sections.flatMap((s) => s.items));
        const bacon = items.filter((i) => i.number === "081906");
        await withNutrition([...bacon, ...bacon]);
        expect(log.filter((c) => c.url.includes("RecNumAndPort=081906"))).toHaveLength(1);
    });

    it("reports how many items it could cover", async () => {
        const menu = await getMenu("J2", "10/14/2026", "Dinner");
        const items = menu.meals.flatMap((m) => m.sections.flatMap((s) => s.items));
        const { covered, total } = await withNutrition(items);
        expect(total).toBeGreaterThan(covered); // a full dinner exceeds the budget
        expect(covered).toBe(LABEL_BUDGET);
        expect(items.filter((i) => i.nutrition).length).toBeGreaterThan(0);
    });

    it("filters to one meal", async () => {
        const menu = await getMenu("J2", "10/15/2026", "Dinner");
        expect(menu.meals).toHaveLength(1);
        expect(menu.meals[0]!.meal).toBe("Dinner");
    });

    it("explains itself when the date is outside the published window", async () => {
        await expect(getMenu("J2", "12/25/2026")).rejects.toThrow(/No menu published/);
    });

    it("names the halls that do have menus when asked for one that does not", async () => {
        await expect(getMenu("Panda Express", "10/15/2026")).rejects.toThrow(/J2 Dining/);
    });
});

describe("menu search", () => {
    it("finds an item across halls and days", async () => {
        const { hits } = await searchMenuItems("pancake");
        expect(hits.length).toBeGreaterThan(0);
        expect(hits.every((h) => h.item.name.toLowerCase().includes("pancake"))).toBe(true);
        expect(hits.every((h) => h.date && h.location && h.meal)).toBe(true);
    });

    it("requires every word to match", async () => {
        const { hits } = await searchMenuItems("scrambled eggs");
        expect(hits.every((h) => /scrambled/i.test(h.item.name) && /eggs/i.test(h.item.name))).toBe(
            true,
        );
    });

    it("applies diet filters as AND", async () => {
        const { hits } = await searchMenuItems("", { diet: ["VGN", "SS"] });
        expect(hits.length).toBeGreaterThan(0);
        expect(
            hits.every((h) => h.item.legends.includes("VGN") && h.item.legends.includes("SS")),
        ).toBe(true);
    });

    it("restricts to one day and one location", async () => {
        const { hits } = await searchMenuItems("banana", { date: "10/16/2026", location: "Kins" });
        expect(hits.every((h) => h.date === "10/16/2026" && h.location === "Kins Dining")).toBe(
            true,
        );
    });

    it("returns nothing for an item UT does not serve", async () => {
        expect((await searchMenuItems("wagyu katsu sando")).hits).toHaveLength(0);
    });
});

describe("nutrition labels", () => {
    it("reads the dish, serving, calories, allergens and ingredients", async () => {
        const n = await getNutrition("450231");
        expect(n.name).toBe("Pear Crisp");
        expect(n.servingSize).toBe("1 each");
        expect(n.calories).toBe("226");
        expect(n.allergens).toBe("Wheat, Soybeans");
        expect(n.ingredients).toMatch(/Streusel/);
    });

    // The label prints an FDA panel and then a fuller table, so every nutrient
    // appears twice under slightly different names.
    it("reports each nutrient once", async () => {
        const names = (await getNutrition("450231")).nutrients.map((n) => n.name.toLowerCase());
        expect(new Set(names).size).toBe(names.length);
        expect(names).not.toContain("total fat"); // folded into "Fat"
    });

    it("keeps the richer detail row, including micronutrients", async () => {
        const n = await getNutrition("450231");
        const byName = Object.fromEntries(n.nutrients.map((x) => [x.name, x]));
        expect(byName["Fat"]).toMatchObject({ amount: "5.4g", dv: "7%" });
        expect(byName["Potassium"]).toMatchObject({ amount: "41.3mg" });
        expect(byName["Iron"]).toBeDefined();
    });

    it("pairs each daily value with its own nutrient", async () => {
        const n = await getNutrition("450231");
        const sodium = n.nutrients.find((x) => x.name === "Sodium")!;
        expect(sodium.amount).toBe("135.4mg");
        expect(sodium.dv).toBe("6%");
    });
});

describe("audit regressions", () => {
    // Impossible dates used to roll over silently and be answered with some
    // other day's hours.
    it("rejects dates that do not exist", () => {
        expect(() => parseDate("13/45")).toThrow(/not a real date/);
        expect(() => parseDate("2/30/26")).toThrow(/not a real date/);
        expect(() => parseDate("2026-02-30")).toThrow(/not a real date/);
        expect(() => parseDate("0/5")).toThrow(/not a real date/);
    });

    it("accepts a real leap day", () => {
        expect(parseDate("2/29/28")).toBe("02/29/2028");
        expect(() => parseDate("2/29/26")).toThrow(/not a real date/); // 2026 is not a leap year
    });

    // Answering an out-of-range date with the current period produced a
    // confident "OPEN" under a schedule that does not cover that date.
    it("refuses a date beyond every published schedule", async () => {
        await expect(hoursForDate("03/05/2027")).rejects.toThrow(/has not published dining hours/);
    });

    it("still answers inside the published range", async () => {
        await expect(hoursForDate("12/10/2026")).resolves.toBeTruthy();
    });

    // The nutrition label is per serving, so the menu must publish the serving
    // it quoted its calories for.
    it("keeps the serving alongside each menu item", async () => {
        const menu = await getMenu("J2", "10/15/2026");
        const items = menu.meals.flatMap((m) => m.sections.flatMap((s) => s.items));
        expect(items.filter((i) => i.serving).length / items.length).toBeGreaterThan(0.8);
    });

    it("requests the serving it was given rather than defaulting to 1", async () => {
        const log = stubFetch();
        await getNutrition("450231", "3");
        expect(log.at(-1)!.url).toContain("RecNumAndPort=450231*3");
    });

    it("parses a period label whose dates are not zero-padded", async () => {
        stubFetch({
            "hours-of-operation":
                "<details><summary>Test Term (8/3/26 - 9/4/26)</summary><h5>Dining Halls</h5>" +
                "<table><tbody><tr><td>J2 Dining</td><td>7:00am-10:00pm</td><td>Closed</td><td>Closed</td>" +
                "<td>Closed</td><td>Closed</td><td>Closed</td><td>Closed</td></tr></tbody></table></details>",
        });
        const period = await hoursForDate("08/15/2026");
        expect(period.label).toContain("Test Term");
    });

    it("names the problem when the menu feed changes shape", async () => {
        stubFetch({ "data_all_endpoint.php?menu=1": '{"last_cached":"x","days":{}}' });
        await expect(getMenu("J2", "10/15/2026")).rejects.toThrow(/contained no days/);
    });

    it("reports an unreadable nutrition label instead of echoing the number", async () => {
        stubFetch({ "label.aspx": "<html><body>temporarily unavailable</body></html>" });
        await expect(getNutrition("450231")).rejects.toThrow(/No nutrition label/);
    });
});

describe("hour ranges the fixtures do not exercise", () => {
    const scheduleWith = (cells: string[]) => ({
        "hours-of-operation":
            "<details><summary>Edge Term (02/01/27 - 02/28/27)</summary><h5>Dining Halls</h5>" +
            `<table><tbody><tr><td>Night Owl</td>${cells.map((c) => `<td>${c}</td>`).join("")}</tr></tbody></table></details>`,
    });

    // "Midnight" means 00:00 when it opens a range and 24:00 when it closes one.
    it("reads Midnight as the start of the day when it opens a range", async () => {
        stubFetch(scheduleWith(["Midnight-8:00am", ...Array(6).fill("Closed")]));
        const period = await hoursForDate("02/08/2027"); // a Monday
        const owl = period.locations.find((l) => l.name === "Night Owl")!;
        expect(owl.week[0]).toEqual([{ start: 0, end: 8 * 60, label: "Midnight-8:00am" }]);
    });

    it("carries a range past midnight into the next day", async () => {
        stubFetch(scheduleWith(["10:00pm-2:00am", ...Array(6).fill("Closed")]));
        const period = await hoursForDate("02/08/2027");
        const owl = period.locations.find((l) => l.name === "Night Owl")!;
        expect(owl.week[0]).toEqual([{ start: 22 * 60, end: 26 * 60, label: "10:00pm-2:00am" }]);
    });

    it("counts a past-midnight range as open just before closing", async () => {
        stubFetch(scheduleWith(["10:00pm-2:00am", ...Array(6).fill("Closed")]));
        const rows = await statusAt("02/08/2027", 25 * 60); // 1am, still the Monday entry
        const owl = rows.find((r) => r.name === "Night Owl")!;
        expect(owl.open).toBe(true);
        expect(owl.closesIn).toBe(60);
    });
});

describe("feed formatting tolerance", () => {
    // UT serves the feed compact. A formatter once pretty-printed the fixture
    // and every item silently lost its tags, because the scan assumed
    // `"legends":[` with no spaces.
    it("still reads names and tags from a pretty-printed feed", async () => {
        const compact = fixture("foodpro-menu.json");
        stubFetch({ "data_all_endpoint.php?menu=1": JSON.stringify(JSON.parse(compact), null, 2) });

        const menu = await getMenu("J2", "10/15/2026", "Dinner");
        const items = menu.meals.flatMap((m) => m.sections.flatMap((s) => s.items));
        expect(items.length).toBeGreaterThan(10);
        expect(items.every((i) => i.name.length > 0)).toBe(true);
        expect(items.some((i) => i.legends.includes("VGN"))).toBe(true);
    });
});
