import type { McpServer } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { resetCache } from "../src/lib/http";
import { allergens, getMenu, mergedAllergens } from "../src/lib/dining";
import { registerDiningTools } from "../src/tools/dining";
import { FIXED_NOW, stubFetch } from "./fixtures";

/**
 * Drives the registered tools rather than the library underneath, because the
 * tool layer is where argument handling and output formatting live.
 */
/** Only get_dining_menu returns structured content, so type it as that. */
type MenuStructured = {
    location: string;
    date: string;
    lastCached: string;
    nutritionCoverage: {
        withNutrition: number;
        items: number;
        distinctWithNutrition: number;
        distinctItems: number;
    };
    withheld: { count: number; droppedByLabel: number; of: number };
    meals: {
        meal: string;
        sections: {
            station: string;
            items: {
                id: string;
                name: string;
                // null when nobody read the label: [] there would read as a
                // positive claim of allergen-free.
                allergens: string[] | null;
                allergenSource: string;
                nutrition: { calories: number | null; warning: string | null } | null;
            }[];
        }[];
    }[];
};

type SearchStructured = {
    matched: number;
    shown: number;
    hits: { allergens: string[] | null; allergenSource: string; exact: boolean }[];
};

type ToolResult = {
    content: { type: string; text: string }[];
    structuredContent?: MenuStructured;
    isError?: boolean;
};

type Registered = {
    config: {
        title?: string;
        description?: string;
        // Zod object, kept structural: the SDK types structuredContent as an
        // open record whatever the schema says, so tsc will never link them.
        outputSchema?: { parse: (value: unknown) => unknown };
    };
    handler: (args: unknown, extra?: unknown) => Promise<ToolResult>;
};

/**
 * Collects what registerDiningTools registers. Capturing the calls keeps this
 * off the SDK's private internals, and the registration contract is itself
 * worth asserting.
 */
function tools(): Record<string, Registered> {
    const registry: Record<string, Registered> = {};
    const recorder = {
        registerTool(name: string, config: Registered["config"], handler: Registered["handler"]) {
            registry[name] = { config, handler };
        },
    };
    registerDiningTools(recorder as unknown as McpServer);
    return registry;
}

/**
 * Declaring an outputSchema makes the client reject any non-error response that
 * does not match it, and nothing in the SDK's types enforces that. Checking here
 * makes every test in this file a schema test for free.
 */
async function call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    const tool = tools()[name];
    if (!tool) throw new Error(`No such tool: ${name}`);
    const result = await tool.handler(args, {});
    if (tool.config.outputSchema && !result.isError) {
        const parsed = tool.config.outputSchema.parse(result.structuredContent);
        // zod strips keys the schema does not declare; the schema the server
        // publishes sets additionalProperties: false and rejects them. Comparing
        // what survived the parse against what went in catches the difference.
        expect(JSON.stringify(parsed)).toBe(JSON.stringify(result.structuredContent));
    }
    return result;
}

const textOf = async (name: string, args: Record<string, unknown> = {}) =>
    (await call(name, args)).content.map((c) => c.text).join("\n");

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

describe("registration", () => {
    it("registers the dining tools", () => {
        expect(Object.keys(tools()).sort()).toEqual([
            "dining_hours",
            "get_dining_menu",
            "list_dining_locations",
            "menu_item_nutrition",
            "search_menu_items",
        ]);
    });
});

describe("get_dining_menu", () => {
    it("returns per-serving macros for each item", async () => {
        const out = await textOf("get_dining_menu", { location: "J2", meal: "Lunch" });
        // units on every figure: one line read on its own should not be ambiguous
        expect(out).toMatch(/\d+ cal P [\d.]+g C [\d.]+g F [\d.]+g/);
    });

    it("spells out dietary tags and allergens rather than raw codes", async () => {
        const out = await textOf("get_dining_menu", { location: "J2", meal: "Lunch" });
        expect(out).toMatch(/Vegan/);
        expect(out).toMatch(/contains Milk/);
        expect(out).not.toMatch(/\[MLK/);
    });

    it("prints an item reference that menu_item_nutrition accepts", async () => {
        const out = await textOf("get_dining_menu", { location: "J2", meal: "Lunch" });
        expect(out).toMatch(/#\d+\*[\d/]+/);
    });

    it("returns structured output that matches the declared schema", async () => {
        const res = await call("get_dining_menu", { location: "J2", meal: "Lunch" });
        const structured = res.structuredContent!;
        expect(structured.location).toBe("J2 Dining");
        expect(structured.nutritionCoverage.items).toBeGreaterThan(0);
        const items = structured.meals.flatMap((m) => m.sections.flatMap((s) => s.items));
        expect(items.length).toBeGreaterThan(0);
        expect(items.some((i) => i.nutrition?.calories !== null && i.nutrition !== null)).toBe(
            true,
        );
    });

    // The field sits inside structuredContent beside the array it describes, so
    // counting something else there reads as a contradiction.
    // Withholding is the case that can pull the counts apart: it removes rows
    // after the coverage figures have been taken, so a call with no exclusion
    // cannot tell you anything here.
    it.each([{ location: "JCL" }, { location: "JCL", exclude: ["PNTS"] }])(
        "counts nutrition coverage over the rows it is sitting next to: %j",
        async (args) => {
            const structured = (await call("get_dining_menu", args)).structuredContent!;
            const items = structured.meals.flatMap((m) => m.sections.flatMap((s) => s.items));
            expect(structured.nutritionCoverage.items).toBe(items.length);
            expect(structured.nutritionCoverage.withNutrition).toBe(
                items.filter((i) => i.nutrition !== null).length,
            );
            const distinct = new Set(items.map((i) => i.id)).size;
            expect(structured.nutritionCoverage.distinctItems).toBe(distinct);
            expect(structured.nutritionCoverage.distinctWithNutrition).toBeLessThanOrEqual(
                distinct,
            );
        },
    );

    // A client reading only the structured output was told 36 items with no sign
    // that 60 more had been held back.
    it("reports withheld items in the structured output, not just the text", async () => {
        const res = await call("get_dining_menu", {
            location: "JCL",
            meal: "Dinner",
            exclude: ["PNTS"],
        });
        const structured = res.structuredContent!;
        const shown = structured.meals.flatMap((m) => m.sections.flatMap((s) => s.items)).length;
        // Every item considered is either listed, withheld, or dropped by its
        // label. Leaving the dropped ones out made the lead sentence undercount.
        expect(structured.withheld.of).toBe(
            shown + structured.withheld.count + structured.withheld.droppedByLabel,
        );
        const lead = res.content[0]!.text.split("\n")[0]!;
        if (structured.withheld.count > 0) {
            expect(lead).toMatch(
                new RegExp(
                    `^WITHHELD: ${structured.withheld.count} of ${structured.withheld.of} items`,
                ),
            );
        }
    });

    // The flag is the whole point of the guard, and the stated use for the
    // structured output is totalling macros, which is where it does the damage.
    it("carries the implausible-figure warning into the structured output", async () => {
        const res = await call("get_dining_menu", { location: "J2", meal: "Lunch" });
        const items = res
            .structuredContent!.meals.flatMap((m) => m.sections.flatMap((s) => s.items))
            .filter((i) => i.nutrition);
        expect(items.length).toBeGreaterThan(0);
        // Present on every row, so a consumer can read it unconditionally.
        for (const item of items) expect(item.nutrition).toHaveProperty("warning");
        const text = res.content.map((c) => c.text).join("\n");
        for (const item of items) {
            if (item.nutrition?.warning) expect(text).toMatch(/FIGURE LOOKS WRONG/);
        }
    });

    it("says how many items it could cover when the label budget binds", async () => {
        const out = await textOf("get_dining_menu", { location: "J2", meal: "Dinner" });
        expect(out).toMatch(/Nutrition shown for \d+ of \d+ items/);
    });

    // A restriction that silently ignores an unknown code hands someone the
    // allergen they asked to avoid.
    it("rejects an unrecognised exclude code instead of ignoring it", async () => {
        for (const bad of [["peanuts"], ["Peanut", "Milk"], ["NUTS"]]) {
            const out = await textOf("get_dining_menu", {
                location: "J2",
                meal: "Lunch",
                exclude: bad,
            });
            expect(out).toMatch(/Unknown exclude code/);
        }
    });

    it("rejects an unrecognised diet code", async () => {
        expect(
            await textOf("get_dining_menu", { location: "J2", meal: "Lunch", diet: ["vegan"] }),
        ).toMatch(/Unknown diet code/);
    });

    it("applies a real exclusion", async () => {
        const out = await textOf("get_dining_menu", {
            location: "J2",
            meal: "Lunch",
            exclude: ["mlk"],
        });
        expect(out).not.toMatch(/Unknown/);
        expect(out).not.toMatch(/contains .*Milk/);
    });

    it("explains itself when the date is outside the published window", async () => {
        expect(await textOf("get_dining_menu", { location: "J2", date: "2026-12-25" })).toMatch(
            /No menu published/,
        );
    });
});

describe("dining_hours", () => {
    it("always states the time the verdict was taken at", async () => {
        expect(await textOf("dining_hours", {})).toMatch(/at \d{2}:\d{2} Austin time \(now\)/);
        expect(await textOf("dining_hours", { date: "friday" })).toMatch(
            /at \d{2}:\d{2} Austin time/,
        );
    });

    it("rejects an impossible time instead of wrapping it", async () => {
        for (const at of ["99", "25:00", "10:99"]) {
            expect(await textOf("dining_hours", { at })).toMatch(/not a valid/);
        }
    });

    it("reports the schedule in force, including break schedules", async () => {
        // "Thanskgiving" is UT's own spelling in the hours feed.
        expect(await textOf("dining_hours", { date: "2026-11-26" })).toMatch(
            /Than(ks|sk)giving Break/,
        );
    });
});

describe("search_menu_items argument handling", () => {
    // Regression: this used a raw substring on the location, so "Jester City
    // Limits" (what dining_hours prints) found nothing while "JCL" worked.
    it("accepts the same location aliases the other tools do", async () => {
        for (const location of ["JCL", "Jester City Limits", "Kinsolving"]) {
            const out = await textOf("search_menu_items", { query: "a", location });
            expect(out).not.toMatch(/^No menu item matches/);
        }
    });

    it("rejects an unknown diet code instead of matching nothing", async () => {
        const out = await textOf("search_menu_items", { query: "wrap", diet: ["GF"] });
        expect(out).toMatch(/Unknown diet code/);
    });

    // Loose matches sort last and the row cap cuts them off, so counting them
    // over every hit announced weak rows that are nowhere in the response.
    it("counts loose matches over the rows it actually shows", async () => {
        for (const query of ["a", "e", "chicken", "corn"]) {
            const out = await textOf("search_menu_items", { query });
            const claimed = Number(
                out.match(/^(\d+) of the rows shown are marked \[loose\]/m)?.[1] ?? 0,
            );
            const printed = (out.match(/\[loose\]/g) ?? []).length;
            // One mention in the note itself when the note is there at all.
            expect(printed - (claimed ? 1 : 0), query).toBe(claimed);
        }
    });

    // get_dining_menu stopped saying [] for an unread label; search never reads
    // one at all, so [] here would teach the model the opposite lesson.
    it("never claims an item is allergen-free from the menu tags alone", async () => {
        const res = await call("search_menu_items", { query: "chicken" });
        const structured = res.structuredContent as unknown as SearchStructured;
        expect(structured.hits.length).toBeGreaterThan(0);
        for (const hit of structured.hits) {
            expect(hit.allergens).not.toEqual([]);
            expect(hit.allergenSource).toBe("menu-tags");
        }
    });
});

describe("menu_item_nutrition", () => {
    it("accepts the reference exactly as the menu printed it", async () => {
        const log = stubFetch();
        await call("menu_item_nutrition", { itemNumber: "450231*3" });
        expect(log.at(-1)!.url).toContain("RecNumAndPort=450231*3");
    });
});

describe("list_dining_locations", () => {
    it("gives address, building and payment for one location", async () => {
        const out = await textOf("list_dining_locations", { name: "Noodle Lab" });
        expect(out).toMatch(/2308 Whitis Ave/);
        expect(out).toMatch(/Union Building/);
        expect(out).toMatch(/Cash/);
    });
});

describe("tool descriptions", () => {
    it("gives every tool a title and a description a model can act on", () => {
        for (const [name, tool] of Object.entries(tools())) {
            expect(tool.config.title, `${name} title`).toBeTruthy();
            expect((tool.config.description ?? "").length, `${name} description`).toBeGreaterThan(
                80,
            );
        }
    });
});

describe("gaps found in review", () => {
    // outputSchema is declared, so a text-only return makes the client reject
    // the whole response. Every "nothing matched" path hit this, including the
    // allergy path where a filter removes everything.
    it("returns structured content when nothing matches", async () => {
        const res = await call("get_dining_menu", { location: "J2", meal: "brunch" });
        expect(res.structuredContent).toBeTruthy();
        expect(res.structuredContent!.meals).toEqual([]);
        expect(res.structuredContent!.location).toBe("J2 Dining");
        expect(res.content[0]!.text).toMatch(/Nothing at J2 Dining/);
    });

    it("names the meals that are served when the asked-for one isn't", async () => {
        const out = await textOf("get_dining_menu", { location: "J2", meal: "brunch" });
        expect(out).toMatch(/Meals served that day: .*(Breakfast|Lunch|Dinner)/);
    });

    // The menu tags under-report. 450257 is tagged vegan with wheat and soy,
    // but its label also lists tree nuts.
    it("reports the label's allergens as well as the menu tags", async () => {
        const res = await call("get_dining_menu", { location: "J2", meal: "Lunch" });
        const items = res.structuredContent!.meals.flatMap((m) =>
            m.sections.flatMap((x) => x.items),
        );
        const checked = items.filter((i) => i.allergenSource === "label+menu-tags");
        expect(checked.length).toBeGreaterThan(0);
        // null means the label went unread, which contradicts the source field.
        expect(checked.filter((i) => i.allergens === null)).toEqual([]);
        expect(
            checked.some((i) => (i.allergens ?? []).some((a) => /Soybeans|Milk|Wheat/.test(a))),
        ).toBe(true);
    });

    // The invariant that matters in the output, not just in the helper: reading a
    // label may only ever add allergens, never remove one the menu asserted.
    it("never drops a menu-tag allergen from an item it read a label for", async () => {
        const res = await call("get_dining_menu", { location: "J2", meal: "Lunch" });
        const items = res.structuredContent!.meals.flatMap((m) =>
            m.sections.flatMap((x) => x.items),
        );
        const checked = items.filter((i) => i.allergenSource === "label+menu-tags");
        expect(checked.length).toBeGreaterThan(0);
        expect(checked.filter((i) => i.allergens === null)).toEqual([]);

        // legends aren't in the output, so take them from the menu underneath
        const menu = await getMenu("J2", "10/15/2026");
        const tags = new Map<string, string[]>();
        for (const meal of menu.meals)
            for (const section of meal.sections)
                for (const item of section.items)
                    tags.set(
                        item.serving ? `${item.number}*${item.serving}` : item.number,
                        item.legends,
                    );

        let compared = 0;
        for (const item of checked) {
            for (const tagged of allergens(tags.get(item.id) ?? [])) {
                compared++;
                const word = tagged.toLowerCase().replace(/s$/, "");
                expect(
                    (item.allergens ?? []).some((a) => a.toLowerCase().includes(word)),
                    `${item.name} (${item.id}) lost "${tagged}"`,
                ).toBe(true);
            }
        }
        expect(compared).toBeGreaterThan(0);
    });

    // Neither source contains the other: 6" Flour Tortilla is tagged SOY,WHT and
    // its label reads only "Wheat", so preferring the label erased the soy and
    // then stamped the shortened list as label-verified.
    it("keeps a tagged allergen the label leaves out", async () => {
        const item = mergedAllergens({
            number: "211004",
            name: '6" Flour Tortilla',
            legends: ["SOY", "WHT", "VGN"],
            avoid: [],
            labelAllergens: ["Wheat"],
            labelChecked: true,
        });
        expect(item).toContain("Wheat");
        expect(item.some((a) => /Soy/i.test(a))).toBe(true);
    });

    // Explicit expected lists, not the implementation's own matching rule, since
    // a guard written with that rule cannot see a mistake in it.
    it.each([
        [["WHT"], ["Wheat"], ["Wheat"]],
        // the menu says "Sesame Seeds" where every UT label says "Sesame"
        [["SS", "VGN"], ["Sesame"], ["Sesame"]],
        // "Fish" is inside "Crustacean Shellfish" but is a different allergen
        [["FSH"], ["Crustacean Shellfish"], ["Crustacean Shellfish", "Fish"]],
        [
            ["SOY"],
            ["Milk", "Crustacean Shellfish", "Wheat"],
            ["Milk", "Crustacean Shellfish", "Wheat", "Soy"],
        ],
        [["SOY", "WHT"], ["Wheat"], ["Wheat", "Soy"]],
    ])("merges legends %j with label %j", (legends, labelAllergens, expected) => {
        expect(
            mergedAllergens({
                number: "1",
                name: "x",
                legends,
                avoid: [],
                labelAllergens,
                labelChecked: true,
            }),
        ).toEqual(expected);
    });

    // Excluding a diet tag is a menu-tag question, already settled before the
    // labels are read, so it must not withhold everything past the budget.
    it("does not withhold items when the exclusion is a diet tag", async () => {
        const out = await textOf("get_dining_menu", {
            location: "J2",
            meal: "Lunch",
            exclude: ["VGT"],
        });
        expect(out).not.toMatch(/are not listed/);
    });

    it("drops an item whose label names an excluded allergen", async () => {
        const all = await textOf("get_dining_menu", { location: "J2", meal: "Lunch" });
        const without = await textOf("get_dining_menu", {
            location: "J2",
            meal: "Lunch",
            exclude: ["MLK"],
        });
        expect(all.length).toBeGreaterThan(without.length);
        expect(without).not.toMatch(/contains [^\n]*Milk/);
    });

    // Regression: the label budget covers the first 40 refs, so anything past it
    // used to fall back to the menu tags. 35 of this week's recipes carry no tags
    // at all, and Chocolate Pistacio Cloud Cake (untagged, ref 92 of 94 at JCL
    // dinner) has peanuts on its label. Unverified items get withheld instead.
    it("withholds items it could not check when an allergen is excluded", async () => {
        stubFetch({ "label.aspx": 500 });
        const out = await textOf("get_dining_menu", {
            location: "J2",
            meal: "Lunch",
            exclude: ["PNTS"],
        });
        expect(out).toMatch(/are not listed/);
        expect(out).not.toMatch(/ · #\d/); // nothing was presented as safe
    });

    it("marks an item whose label went unread as menu-tags, not allergen-free", async () => {
        stubFetch({ "label.aspx": 500 });
        const { structuredContent } = await call("get_dining_menu", {
            location: "J2",
            meal: "Lunch",
        });
        const items = structuredContent!.meals.flatMap((m) =>
            m.sections.flatMap((sec) => sec.items),
        );
        expect(items.length).toBeGreaterThan(0);
        expect(items.every((i) => i.allergenSource === "menu-tags")).toBe(true);
    });

    // A station is small enough that the label budget always covers it, so this
    // is the narrowing that actually gets full nutrition.
    it("covers every item when asked for one station", async () => {
        const out = await textOf("get_dining_menu", {
            location: "J2",
            meal: "Lunch",
            station: "Garden Bar",
        });
        expect(out).not.toMatch(/Nutrition shown for/);
        expect(out).toMatch(/Garden Bar/);
    });

    it("lists the stations when it cannot cover everything", async () => {
        const out = await textOf("get_dining_menu", { location: "J2", meal: "Dinner" });
        if (/Nutrition shown for/.test(out)) expect(out).toMatch(/Stations here: .+/);
    });

    // The hours feed says "Jester City Limits", the menu feed says "JCL Dining".
    it("accepts either spelling of a hall", async () => {
        const short = await textOf("get_dining_menu", { location: "JCL", meal: "Lunch" });
        const long = await textOf("get_dining_menu", {
            location: "Jester City Limits",
            meal: "Lunch",
        });
        expect(short).toMatch(/JCL Dining/);
        expect(long).toMatch(/JCL Dining/);
    });

    it("finds a hall in dining_hours by its menu-feed name", async () => {
        const out = await textOf("dining_hours", { location: "JCL" });
        expect(out).not.toMatch(/No dining location matching/);
    });

    it("only offers categories that list_dining_locations can actually return", async () => {
        for (const category of [
            "Dining Halls",
            "Restaurants",
            "Coffee Shops",
            "Markets",
            "Food Trucks",
        ]) {
            const out = await textOf("list_dining_locations", { category });
            expect(out, category).not.toMatch(/No locations in category/);
        }
    });
});
