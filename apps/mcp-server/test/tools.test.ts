import type { McpServer } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { resetCache } from "../src/shared";
import { allergens, getMenu, mergedAllergens } from "../src/tools/dining/extract";
import { CATEGORY_LIST, registerDiningTools } from "../src/tools/dining";
import { FIXED_NOW, fixture, stubFetch } from "./fixtures";

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
                dietary: string[];
                // null when nobody read the label: [] there would read as a
                // positive claim of allergen-free.
                allergens: string[] | null;
                allergenSource: string;
                ingredientsKnown: boolean;
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
        // Same reason: the call has to go through it, because an input schema
        // that drops what it does not recognise is invisible from the handler.
        inputSchema?: {
            safeParse: (value: unknown) => {
                success: boolean;
                data?: unknown;
                error?: { message: string };
            };
        };
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
    // Go through the input schema the way the server does. Calling the handler
    // with a raw object skipped validation entirely, which is why a schema that
    // silently dropped an unknown `exclude` looked fine here while answering a
    // nut-allergy question with peanut cookies.
    if (tool.config.inputSchema) {
        const checked = tool.config.inputSchema.safeParse(args);
        if (!checked.success)
            return {
                isError: true,
                content: [{ type: "text", text: checked.error?.message ?? "invalid arguments" }],
            } as ToolResult;
        args = checked.data as Record<string, unknown>;
    }
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

    it("reads each label at the item's own serving, not at one portion", async () => {
        const log = stubFetch();
        await call("get_dining_menu", { location: "J2", meal: "Dinner", date: "10/16/2026" });
        const refs = log
            .map((entry) => /RecNumAndPort=(\d+)\*([\d/]+)/.exec(entry.url))
            .filter(Boolean)
            .map((m) => ({ number: m![1]!, serving: m![2]! }));
        expect(refs.length).toBeGreaterThan(0);
        // Crispy Chopped Bacon is served at 3, and its label at *1 says 299
        // calories where *3 says 897.
        const bacon = refs.find((r) => r.number === "081906");
        expect(bacon, "bacon was not among the labels read").toBeTruthy();
        expect(bacon!.serving).toBe("3");
        expect(refs.some((r) => r.serving !== "1")).toBe(true);
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
            // Held to the exact figure: <= distinct is also true of the total.
            const covered = new Set(items.filter((i) => i.nutrition !== null).map((i) => i.id))
                .size;
            expect(structured.nutritionCoverage.distinctWithNutrition).toBe(covered);
        },
    );

    // A client reading only the structured output was told 36 items with no sign
    // that 60 more had been held back.
    // Every item considered is either listed, withheld because its label went
    // unread, or dropped because its label named the excluded allergen. Both
    // non-listed kinds have to be exercised or the arithmetic proves nothing:
    // the first case here has no label drops, the second has 64 of them.
    it.each([
        [{ location: "JCL", meal: "Dinner", exclude: ["PNTS"] }, "count"] as const,
        [{ location: "J2", exclude: ["MLK", "WHT", "SOY", "PNTS"] }, "droppedByLabel"] as const,
    ])("accounts for every item it did not list: %j", async (args, nonZero) => {
        const res = await call("get_dining_menu", args);
        const structured = res.structuredContent!;
        const shown = structured.meals.flatMap((m) => m.sections.flatMap((s) => s.items)).length;
        expect(structured.withheld[nonZero]).toBeGreaterThan(0);
        expect(structured.withheld.count).toBeGreaterThan(0);
        expect(structured.withheld.of).toBe(
            shown + structured.withheld.count + structured.withheld.droppedByLabel,
        );
        // The lead sentence quotes both numbers, so it has to quote these.
        expect(res.content[0]!.text.split("\n")[0]!).toMatch(
            new RegExp(
                `^WITHHELD: ${structured.withheld.count} of ${structured.withheld.of} items`,
            ),
        );
    });

    // Filtering everything away is not the same as there being no menu, and the
    // reply still has to account for the items rather than print bare headings.
    it("accounts for the items when every one of them is filtered away", async () => {
        const res = await call("get_dining_menu", {
            location: "J2",
            exclude: ["MLK", "WHT", "SOY", "PNTS"],
        });
        const structured = res.structuredContent!;
        const rows = structured.meals.flatMap((m) => m.sections.flatMap((s) => s.items));
        expect(rows).toEqual([]);
        expect(structured.withheld.of).toBeGreaterThan(0);
        expect(structured.withheld.count + structured.withheld.droppedByLabel).toBe(
            structured.withheld.of,
        );
        const text = res.content.map((c) => c.text).join("\n");
        expect(text).toMatch(/WITHHELD: \d+ of \d+ items/);
        expect(text).toMatch(/dropped because their label/);
    });

    // The flag is the whole point of the guard, and the stated use for the
    // structured output is totalling macros, which is where it does the damage.
    // Crispy Chopped Bacon is published as 897 cal and 89.7 g of fat for a 3 oz
    // serving, so this meal is the one that actually has something to flag.
    // Pointed at Lunch, which has nothing implausible, every assertion about
    // the flag was skipped and removing the flag entirely kept the suite green.
    it("carries the implausible-figure warning into both copies", async () => {
        const res = await call("get_dining_menu", {
            location: "J2",
            meal: "Dinner",
            date: "10/16/2026",
        });
        const items = res
            .structuredContent!.meals.flatMap((m) => m.sections.flatMap((s) => s.items))
            .filter((i) => i.nutrition);
        expect(items.length).toBeGreaterThan(0);
        // Present on every row, so a consumer can read it unconditionally.
        for (const item of items) expect(item.nutrition).toHaveProperty("warning");
        const warned = items.filter((i) => i.nutrition?.warning);
        expect(warned.length).toBeGreaterThan(0);
        const text = res.content.map((c) => c.text).join("\n");
        expect(text).toMatch(/FIGURE LOOKS WRONG/);
        // The two copies have to name the same items.
        for (const item of warned) expect(text).toContain(item.name);
    });

    // The label budget covers the first 36 references; past it the tags are all
    // there is, and dropping them left items with tree nuts on the menu line
    // and no allergens at all in the copy the model is told to prefer.
    it("keeps menu-tag allergens for items whose label went unread", async () => {
        const res = await call("get_dining_menu", {
            location: "J2",
            meal: "Dinner",
            date: "10/16/2026",
        });
        const items = res.structuredContent!.meals.flatMap((m) =>
            m.sections.flatMap((s) => s.items),
        );
        const unread = items.filter((i) => i.allergenSource === "menu-tags");
        expect(unread.length).toBeGreaterThan(0);
        const tagged = unread.filter((i) => i.allergens !== null);
        expect(tagged.length).toBeGreaterThan(0);
        const text = res.content.map((c) => c.text).join("\n");
        for (const item of tagged) {
            expect(item.allergens).not.toEqual([]);
            // Whatever the structured copy claims has to be on the menu line.
            const line = text.split("\n").find((l) => l.includes(`#${item.id}`));
            for (const allergen of item.allergens ?? []) expect(line).toContain(allergen);
        }
    });

    // A row with no allergen note, in a list where every other row says what it
    // contains, reads as "contains none of them". Past the label budget nobody
    // checked, and 35 of this week's recipes carry no tags at all, so the note
    // has to say which of the two it is.
    it("never leaves an unchecked item looking allergen-free", async () => {
        const res = await call("get_dining_menu", { location: "JCL", meal: "Dinner" });
        const items = res.structuredContent!.meals.flatMap((m) =>
            m.sections.flatMap((s) => s.items),
        );
        const text = res.content.map((c) => c.text).join("\n");
        const lineFor = (id: string) => text.split("\n").find((l) => l.includes(`#${id}`));

        const unchecked = items.filter((i) => i.allergenSource === "menu-tags");
        expect(unchecked.length).toBeGreaterThan(0);
        for (const item of unchecked) {
            const line = lineFor(item.id);
            expect(line, item.name).toMatch(/allergens unchecked|menu tags only/);
        }
        // And a row whose label was read must not be muddied with that caveat.
        const read = items.filter((i) => i.allergenSource === "label+menu-tags");
        expect(read.length).toBeGreaterThan(0);
        for (const item of read) {
            expect(lineFor(item.id), item.name).not.toMatch(/allergens unchecked|menu tags only/);
        }
        expect(text).toMatch(/Do not read those rows as allergen-free/);
    });

    // A meal heading with nothing under it reads as "there is no peanut-free
    // dinner here", which is the opposite of what happened. This used to be
    // reachable by date, because the budget was spent in menu order and a later
    // meal could lose every item; spreading the budget across the day made that
    // scenario rare rather than impossible, so what is asserted now is the
    // invariant itself: nothing printed is empty.
    it("does not print a meal whose every item was withheld", async () => {
        const res = await call("get_dining_menu", {
            location: "JCL",
            exclude: ["PNTS"],
            date: "10/16/2026",
        });
        const structured = res.structuredContent!;
        expect(structured.meals.length).toBeGreaterThan(0);
        expect(structured.withheld.count).toBeGreaterThan(0);
        for (const entry of structured.meals)
            expect(entry.sections.length, `${entry.meal} has no sections`).toBeGreaterThan(0);
        const text = res.content.map((c) => c.text).join("\n");
        // No heading immediately followed by another heading or the footer.
        expect(text).not.toMatch(/\n(Breakfast|Lunch|Dinner)\n\s*\n\s*(\n|Figures are)/);
    });

    it("says how many items it could cover when the label budget binds", async () => {
        const out = await textOf("get_dining_menu", { location: "J2", meal: "Dinner" });
        expect(out).toMatch(/Nutrition shown for \d+ of \d+ items/);
    });

    // A restriction that silently ignores an unknown code hands someone the
    // allergen they asked to avoid.
    // Saying "nothing at this station" when an ingredient preference is what
    // emptied it is a confident false statement about what UT served.
    it("names the ingredient preference when that is what emptied the menu", async () => {
        const out = await textOf("get_dining_menu", {
            location: "J2",
            meal: "Lunch",
            station: "Baked Potato Bar",
            diet: ["HAL"],
            avoid: ["seed-oils", "gelatin"],
        });
        // Unconditional: the guarded version never ran, so deleting the whole
        // "avoiding ..." clause left the suite green. Whatever emptied it, a
        // reply that lists some filters and not others reads as a statement
        // about what UT served.
        expect(out).toMatch(/^Nothing at/);
        expect(out).toMatch(/at station "Baked Potato Bar"/);
        expect(out).toMatch(/tagged Halal Friendly/);
        expect(out).toMatch(/avoiding seed oils, gelatin/);
    });

    // Live, J2 lunch drops from 101 items to 49 with every avoid key set. The
    // only end-to-end test of this used to hide behind a condition the fixtures
    // never meet, so removing the filter altogether kept the suite green.
    it("actually drops items for an ingredient preference", async () => {
        const names = async (args: Record<string, unknown>) => {
            const res = await call("get_dining_menu", {
                location: "J2",
                meal: "Lunch",
                ...args,
            });
            return res
                .structuredContent!.meals.flatMap((m) => m.sections.flatMap((x) => x.items))
                .map((i) => i.name);
        };
        const all = await names({});
        const kept = await names({ avoid: ["seed-oils"] });
        expect(all.length).toBeGreaterThan(0);
        expect(kept.length).toBeLessThan(all.length);
        // Baked Potato and Roasted Italian Broccoli are both cooked in canola.
        expect(all).toContain("Baked Potato");
        expect(kept).not.toContain("Baked Potato");
        expect(kept).not.toContain("Roasted Italian Broccoli");
        // Green onions are green onions.
        expect(kept).toContain("Sliced Green Onion");
    });

    // Whipped Margarine is soybean oil and palm oil, so it answers to both, and
    // a key must only drop what it names.
    it("drops only what the chosen preference names", async () => {
        const names = async (avoid: string[]) => {
            const res = await call("get_dining_menu", {
                location: "J2",
                meal: "Lunch",
                ...(avoid.length ? { avoid } : {}),
            });
            return res
                .structuredContent!.meals.flatMap((m) => m.sections.flatMap((x) => x.items))
                .map((i) => i.name);
        };
        expect(await names([])).toContain("Whipped Margarine");
        expect(await names(["palm-oil"])).not.toContain("Whipped Margarine");
        // Nothing in the baked potato is palm, so that one has to stay.
        expect(await names(["palm-oil"])).toContain("Baked Potato");
        expect(await names(["gelatin"])).toContain("Whipped Margarine");
    });

    // Only rejecting an unknown diet code was tested; nothing asserted that a
    // valid one actually filters. Live, J2 lunch goes 101 -> 59 for VGN.
    it("actually filters on a dietary tag", async () => {
        const names = async (args: Record<string, unknown>) => {
            const res = await call("get_dining_menu", {
                location: "J2",
                meal: "Lunch",
                ...args,
            });
            return res
                .structuredContent!.meals.flatMap((m) => m.sections.flatMap((x) => x.items))
                .map((i) => i.name);
        };
        const all = await names({});
        const vegan = await names({ diet: ["VGN"] });
        expect(vegan.length).toBeGreaterThan(0);
        expect(vegan.length).toBeLessThan(all.length);
        const res = await call("get_dining_menu", {
            location: "J2",
            meal: "Lunch",
            diet: ["VGN"],
        });
        const items = res.structuredContent!.meals.flatMap((m) =>
            m.sections.flatMap((x) => x.items),
        );
        for (const item of items) expect(item.dietary, item.name).toContain("Vegan");
    });

    // dietTags() keeps only VGN/VGT/HAL and allergens() drops exactly those, so
    // spelling a code with the wrong one of the two gave an empty string and
    // the message read "tagged ." -- both of these codes are ones the published
    // schema invites.
    it.each([
        [{ diet: ["FSH"] }, /tagged Fish/],
        [{ diet: ["PRK"] }, /tagged Pork/],
        [{ diet: ["SFSH"] }, /tagged Shellfish/],
        // exclude is spelled by the same helper, and a diet code in it is the
        // cross-family case for that side.
        [{ diet: ["FSH"], exclude: ["VGN"] }, /without Vegan/],
        [{ diet: ["FSH"], exclude: ["VGT"] }, /without Vegetarian/],
    ])("spells %j out in the empty-menu message", async (filter, expected) => {
        const out = await textOf("get_dining_menu", {
            location: "J2",
            meal: "Dinner",
            station: "Yogurt Bar",
            ...filter,
        });
        expect(out).toMatch(/^Nothing at/);
        expect(out).toMatch(expected);
        expect(out, "a filter joined to an empty string").not.toMatch(/tagged \.|without \./);
    });

    it("rejects an unrecognised avoid key instead of filtering nothing", async () => {
        const res = await call("get_dining_menu", {
            location: "J2",
            meal: "Lunch",
            avoid: ["not-an-ingredient"],
        });
        expect(res.isError).toBe(true);
        expect(res.content.map((c) => c.text).join("")).toMatch(/not-an-ingredient/);
    });

    // Several diet tags mean all of them, not any of them.
    it("treats several dietary tags as every one of them", async () => {
        const names = async (diet: string[]) => {
            const res = await call("get_dining_menu", { location: "J2", meal: "Lunch", diet });
            return res
                .structuredContent!.meals.flatMap((m) => m.sections.flatMap((x) => x.items))
                .map((i) => i.dietary);
        };
        const both = await names(["VGN", "HAL"]);
        for (const tags of both) {
            expect(tags).toContain("Vegan");
            expect(tags).toContain("Halal Friendly");
        }
        const vegan = await names(["VGN"]);
        expect(both.length).toBeLessThan(vegan.length);
    });

    // UT publishes an empty ingredient statement for a couple of recipes, and
    // an empty avoid list on those is unknown rather than clear.
    it("says when a preference could not be checked against the ingredients", async () => {
        const out = await textOf("get_dining_menu", {
            location: "J2",
            meal: "Lunch",
            avoid: ["seed-oils"],
        });
        expect(out).toMatch(/Sour Cream[^\n]*ingredients unpublished, preference unchecked/);
        // The same fact has to reach the copy the description tells the model
        // to prefer, or the row reads as one the filter cleared.
        const res = await call("get_dining_menu", {
            location: "J2",
            meal: "Lunch",
            avoid: ["seed-oils"],
        });
        const items = res.structuredContent!.meals.flatMap((m) =>
            m.sections.flatMap((s) => s.items),
        );
        const sour = items.find((i) => i.name === "Sour Cream");
        expect(sour, "Sour Cream was dropped, not kept").toBeTruthy();
        expect(sour!.ingredientsKnown).toBe(false);
        expect(items.find((i) => i.name === "Sliced Green Onion")!.ingredientsKnown).toBe(true);
        // An item UT does publish ingredients for carries no such caveat.
        expect(out).toMatch(/Sliced Green Onion(?![^\n]*preference unchecked)/);
    });

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

    it.each([["13pm"], ["0am"], ["15am"]])("rejects %s as a 12-hour time", async (at) => {
        const out = await textOf("dining_hours", { at });
        expect(out, at).toMatch(/not a valid 12-hour time/);
    });

    it("reads a time with spaces round it", async () => {
        const out = await textOf("dining_hours", { at: "  7pm " });
        expect(out).toMatch(/at 19:00/);
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
            expect(out, location).not.toMatch(/^Nothing on the published menu/);
        }
    });

    // The header says "today first" and a student asking "can I get steak today"
    // got four days of future rows above the two for today, because the sort
    // ordered on match quality alone.
    it("puts today's rows first, as the header says it does", async () => {
        for (const query of ["chicken", "steak", "salad", "a"]) {
            const out = await textOf("search_menu_items", { query });
            const rows = out.split("\n").filter((l) => /^ {2}(today|\d{2}\/)/.test(l));
            if (!rows.length) continue;
            const lastToday = rows.map((l) => l.trimStart().startsWith("today")).lastIndexOf(true);
            const firstOther = rows.findIndex((l) => !l.trimStart().startsWith("today"));
            if (lastToday >= 0 && firstOther >= 0)
                expect(lastToday, `${query}: a later day sorted above today`).toBeLessThan(
                    firstOther,
                );
        }
    });

    // The name is tokenised on every non-alphanumeric; the query was only split
    // on whitespace, so a word with punctuation stuck to it could never match
    // and the reply was a confident "nothing on the published menu". 86 of the
    // fixture's recipe names carry one.
    it.each([
        ["peas & carrots", "Peas & Carrots", undefined],
        ["cauliflower & potatoes", "Gobi Aloo (Cauliflower & Potatoes)", undefined],
        ["s'mores", "S'mores Cloud Cake", "10/14/2026"],
        ["ham & cheese omelet", "Ham & Cheese Omelet", "10/14/2026"],
        // A curly apostrophe is what a phone keyboard produces.
        ["s\u2019mores", "S'mores Cloud Cake", "10/14/2026"],
    ])("finds %s", async (query, expected, date) => {
        const out = await textOf("search_menu_items", date ? { query, date } : { query });
        expect(out, query).not.toMatch(/^Nothing/);
        expect(out, query).toContain(expected);
    });

    // The feed is one Mon-Sun week, so by midweek some rows are days already
    // eaten. "Where can I get tacos" must not be answered with Monday.
    it("finds nothing when the only matches are on a day gone by", async () => {
        // The fixture serves Fresh Matchstick Carrots on 10/14 and nothing
        // else on the feed carries the word. FIXED_NOW is 10/15.
        const out = await textOf("search_menu_items", { query: "matchstick" });
        expect(out).toMatch(/^Nothing from today/);
        expect(out).toMatch(/not searched unless you ask for one by date/);
    });

    it("leaves out days that have already gone", async () => {
        const res = await call("search_menu_items", { query: "a" });
        const hits = (res.structuredContent as unknown as SearchStructured).hits as unknown as {
            date: string;
        }[];
        expect(hits.length).toBeGreaterThan(0);
        const iso = (mdy: string) => {
            const [m, d, y] = mdy.split("/");
            return `${y}-${m}-${d}`;
        };
        // FIXED_NOW is 10/15/2026 and the fixture week starts on 10/12.
        for (const hit of hits) expect(iso(hit.date) >= iso("10/15/2026"), hit.date).toBe(true);
    });

    it("still answers about an earlier day when asked for it by date", async () => {
        const out = await textOf("search_menu_items", { query: "matchstick", date: "10/14/2026" });
        expect(out).not.toMatch(/^Nothing/);
        expect(out).toContain("10/14/2026");
        expect(out).toContain("Fresh Matchstick Carrots");
    });

    // A query that tokenises to nothing is a miss, not a wildcard. UT runs a
    // sushi place, so a student typing the dish in Japanese is a real case.
    it.each([["\u5BFF\u53F8"], ["\uD83C\uDF55"], ["???"], ["&"], ["!!!"], ["\u2014"]])(
        "treats %s as no match rather than everything",
        async (query) => {
            const res = await call("search_menu_items", { query });
            const structured = res.structuredContent as unknown as SearchStructured;
            expect(structured.matched, query).toBe(0);
            expect(structured.hits, query).toEqual([]);
        },
    );

    // An absent query still means "show me what there is", filtered by the
    // other arguments. That is the case the empty word list is actually for.
    it("still browses when there is no query at all", async () => {
        const res = await call("search_menu_items", { query: "" });
        expect((res.structuredContent as unknown as SearchStructured).matched).toBeGreaterThan(0);
    });

    // matched is the honest total; shown is what survived the row cap.
    it("reports the true total even when the rows are capped", async () => {
        const res = await call("search_menu_items", { query: "a" });
        const structured = res.structuredContent as unknown as SearchStructured;
        expect(structured.matched).toBeGreaterThan(structured.shown);
        expect(structured.hits.length).toBe(structured.shown);
        const text = res.content.map((c) => c.text).join("\n");
        expect(text).toContain(`${structured.matched} match(es)`);
        // cap() says how many it left out, and that has to add up. This query
        // always overflows the row cap, so the line is not optional: guarded
        // behind an if, deleting the whole line left the suite green.
        const hidden = text.match(/\((\d+) of (\d+) not shown; narrow the search\)/);
        expect(hidden, "cap() did not say how many rows it hid").toBeTruthy();
        expect(Number(hidden![2])).toBe(structured.matched);
        expect(Number(hidden![1])).toBe(structured.matched - structured.shown);
    });

    // The header is the only place a partial window is disclosed on a hit.
    it("says it searched from today onwards", async () => {
        const out = await textOf("search_menu_items", { query: "chicken" });
        expect(out).toMatch(/from today onwards/);
        expect(out).toMatch(/earlier days in the published week are not searched/);
    });

    // Asked for one day, it searched that day, and saying "from today onwards"
    // over rows that are all dated earlier is simply false.
    it("does not claim to have searched from today when asked for one past day", async () => {
        const out = await textOf("search_menu_items", {
            query: "matchstick",
            date: "10/14/2026",
        });
        expect(out).not.toMatch(/from today onwards/);
        expect(out).toContain("10/14/2026");
    });

    // The allergens on a search row are menu tags only, and the prose has to
    // say so: the whole sentence could be deleted with the suite still green.
    it("says its allergens come from the menu tags only", async () => {
        const out = await textOf("search_menu_items", { query: "chicken" });
        expect(out).toMatch(/menu tags only/);
        expect(out).toMatch(/unknown rather than allergen-free/);
    });

    // The empty-result message was built from the whole published window and all
    // three halls whatever was asked for, so a filtered miss read as a
    // statement that UT does not serve the thing at all.
    it("says which location it actually searched when it finds nothing", async () => {
        const out = await textOf("search_menu_items", { query: "zzzznothing", location: "JCL" });
        expect(out).toMatch(/JCL/);
        expect(out).not.toMatch(/J2 Dining, Kins Dining/);
        expect(out).toMatch(/Only that location was searched/);
    });

    it("blames the dietary filter when that is what emptied the search", async () => {
        const plain = await textOf("search_menu_items", { query: "bacon" });
        expect(plain).not.toMatch(/^Nothing/);
        const filtered = await textOf("search_menu_items", { query: "bacon", diet: ["VGN"] });
        expect(filtered).toMatch(/^Nothing/);
        expect(filtered).toMatch(/tagged VGN/);
        expect(filtered).toMatch(/may be what emptied this/);
    });

    it("does not claim to have searched the week when asked for one day", async () => {
        const out = await textOf("search_menu_items", {
            query: "zzzznothing",
            date: "10/16/2026",
        });
        expect(out).toMatch(/Nothing on 10\/16\/2026/);
        expect(out).not.toMatch(/Days earlier in the published week/);
    });

    it("gives the feed timestamp even when nothing matched", async () => {
        const res = await call("search_menu_items", { query: "zzzznothing" });
        const structured = res.structuredContent as unknown as SearchStructured & {
            lastCached: string;
        };
        expect(structured.lastCached).not.toBe("");
    });

    // A date outside the published window and a hall with no menu both fell
    // through every loop, so "nothing matches" was said about data nobody had.
    // get_dining_menu refuses both; search said it had looked.
    it("refuses a date outside the published window rather than reporting a miss", async () => {
        const res = await call("search_menu_items", { query: "a", date: "11/20/2026" });
        expect(res.isError).toBe(true);
        const out = res.content.map((c) => c.text).join("");
        expect(out).toMatch(/No menu published for 11\/20\/2026/);
        expect(out).toMatch(/Menus cover/);
    });

    it("refuses a location with no menu rather than reporting a miss", async () => {
        const res = await call("search_menu_items", { query: "a", location: "Panda Express" });
        expect(res.isError).toBe(true);
        const out = res.content.map((c) => c.text).join("");
        expect(out).toMatch(/has no published menu/);
        expect(out).toMatch(/J2 Dining/);
    });

    // The raw word is not what was searched; the resolved date is.
    it("names the date it resolved, not the word it was given", async () => {
        const out = await textOf("search_menu_items", {
            query: "zzzznothing",
            date: "friday",
        });
        expect(out).toMatch(/Nothing on \d{2}\/\d{2}\/\d{4}/);
        expect(out).not.toMatch(/Nothing on friday/);
    });

    // "ice" is inside Sliced, Diced and Rice. Those are matches worth keeping,
    // but calling them exact makes a weak hit read as a dish by that name.
    it("marks a substring-only match as loose rather than exact", async () => {
        const res = await call("search_menu_items", { query: "ice" });
        const structured = res.structuredContent as unknown as SearchStructured;
        const loose = structured.hits.filter((h) => !h.exact);
        expect(loose.length, "nothing came back loose for a substring query").toBeGreaterThan(0);
        const text = res.content.map((c) => c.text).join("\n");
        expect(text).toMatch(/\[loose\]/);
        expect(text).toMatch(/marked \[loose\]/);
        // And a whole-word query is not downgraded.
        const exact = (
            (await call("search_menu_items", { query: "chicken" }))
                .structuredContent as unknown as SearchStructured
        ).hits;
        expect(exact.some((h) => h.exact)).toBe(true);
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

describe("dining_hours at", () => {
    // Both existing tests that pass `at` only check the shape of the echoed
    // time, so the argument could be ignored entirely and stay green.
    it("answers about the time it was given, not the time now", async () => {
        const open = async (at: string) =>
            (
                (await call("dining_hours", { at })).structuredContent as unknown as {
                    locations: { name: string; open: boolean }[];
                }
            ).locations;
        const morning = await open("09:00");
        const afterMidnight = await open("03:00");
        expect(morning.some((r) => r.open)).toBe(true);
        expect(afterMidnight.every((r) => !r.open)).toBe(true);
        const out = await textOf("dining_hours", { at: "09:00" });
        expect(out).toMatch(/at 09:00/);
    });

    // The description promises noon for a date that is not today.
    it("uses noon for another day rather than the current time", async () => {
        const out = await textOf("dining_hours", { date: "10/17/2026" });
        expect(out).toMatch(/at 12:00/);
    });
});

describe("dining_hours filtering", () => {
    // A verdict about one hall read as a verdict about the whole campus.
    it("names the location when nothing matching it is open", async () => {
        const all = await textOf("dining_hours", { openOnly: true, at: "23:30" });
        const j2 = await textOf("dining_hours", { location: "J2", openOnly: true, at: "23:30" });
        // Something is open campus-wide at that hour, but not J2.
        expect(all).not.toMatch(/Nothing is open/);
        expect(j2).toMatch(/Nothing matching "J2" is open/);
        expect(j2).toMatch(/Other locations were not considered/);
    });

    it("openOnly actually removes the closed locations", async () => {
        const rows = async (args: Record<string, unknown>) =>
            (
                (await call("dining_hours", args)).structuredContent as unknown as {
                    locations: { open: boolean }[];
                }
            ).locations;
        const all = await rows({ at: "19:30" });
        const open = await rows({ at: "19:30", openOnly: true });
        expect(all.length).toBeGreaterThan(open.length);
        expect(open.length).toBeGreaterThan(0);
        expect(open.every((r) => r.open)).toBe(true);
    });
});

describe("menu_item_nutrition", () => {
    it("accepts the reference exactly as the menu printed it", async () => {
        const log = stubFetch();
        await call("menu_item_nutrition", { itemNumber: "450231*3" });
        // The tool also reads the menu feed, for the tags the label can miss,
        // so the label fetch is not necessarily the last one.
        expect(log.some((entry) => entry.url.includes("RecNumAndPort=450231*3"))).toBe(true);
    });
});

describe("a location name that cannot be read", () => {
    // norm() strips to [a-z0-9], so a name the caller did give can come out
    // empty -- which was the same sentinel as no name at all. The result was a
    // full address card for a location the query never matched.
    it.each([["\u4E2D\u6587"], ["???"], ["\uD83C\uDF55"], ["..."], ["---"]])(
        "does not answer %s with the first location on the list",
        async (name) => {
            const out = await textOf("list_dining_locations", { name });
            expect(out, name).toMatch(/No dining location matching/);
        },
    );

    it.each([["\u4E2D\u6587"], ["???"]])(
        "does not silently drop the filter in hours: %s",
        async (location) => {
            const out = await textOf("dining_hours", { location });
            expect(out, location).toMatch(/No dining location matching/);
        },
    );

    it.each([["\u4E2D\u6587"], ["***"]])("does not hand back a menu for %s", async (location) => {
        const res = await call("get_dining_menu", { location, meal: "Lunch" });
        expect(res.isError, location).toBe(true);
    });

    it("will not answer a menu question with no hall named", async () => {
        for (const location of ["", "   "]) {
            const res = await call("get_dining_menu", { location, meal: "Lunch" });
            expect(res.isError, JSON.stringify(location)).toBe(true);
            expect(res.content.map((c) => c.text).join("")).toMatch(/Which dining hall/);
        }
    });

    // An absent name is still no filter.
    it("still lists everything when no name is given", async () => {
        const out = await textOf("list_dining_locations", {});
        expect(out).not.toMatch(/No dining location matching/);
    });
});

describe("a location name too short to mean anything", () => {
    // "a" was answering with Jester Java's full card, "o" with One Two Three
    // Sushi, "z" with Jesta Pizza -- a confident answer to an accident.
    it.each([["a"], ["i"], ["o"], ["z"], ["ch"]])(
        "does not answer %s with the first location it happens to be inside",
        async (name) => {
            const out = await textOf("list_dining_locations", { name });
            expect(out, name).toMatch(/No dining location matching/);
        },
    );

    // Three characters is enough to mean something.
    it("still answers a name that is only a fragment, once it is long enough", async () => {
        const out = await textOf("list_dining_locations", { name: "Jest" });
        expect(out).not.toMatch(/No dining location matching/);
    });
});

describe("search_menu_items filters that must not fail open", () => {
    // The schema used to ignore any key it did not declare, so a model that had
    // read get_dining_menu's schema could send exclude: ["PNTS","NTS"] for a
    // nut allergy and get the peanut cookies back, unfiltered and unhedged.
    it("drops items whose tags carry an excluded allergen", async () => {
        const plain = await call("search_menu_items", { query: "cookies" });
        const safe = await call("search_menu_items", {
            query: "cookies",
            exclude: ["PNTS", "NTS"],
        });
        const hitsOf = (res: ToolResult) =>
            (res.structuredContent as unknown as SearchStructured).hits as unknown as {
                name: string;
                allergens?: string[] | null;
                ingredientsKnown?: boolean;
            }[];
        const nutty = (res: ToolResult) =>
            hitsOf(res).filter((h) => h.allergens?.some((a) => /Peanut|Tree Nut/i.test(a))).length;
        expect(nutty(plain)).toBeGreaterThan(0); // the fixture has some
        expect(nutty(safe)).toBe(0);
        expect(hitsOf(safe).length).toBeLessThan(hitsOf(plain).length);
    });

    // Silently dropping an unknown key is how the above happened. Anything the
    // tool cannot honour has to be an error, not a shrug.
    it("refuses a key it does not implement rather than ignoring it", async () => {
        const res = await call("search_menu_items", { query: "pasta", maxCalories: 400 });
        expect(res.isError).toBe(true);
    });

    it("refuses an unknown contains key", async () => {
        const res = await call("search_menu_items", { query: "pasta", contains: ["msq"] });
        expect(res.isError).toBe(true);
        expect(res.content.map((c) => c.text).join("")).toMatch(/Unknown contains key/);
    });

    // The ingredient statement was in hand for every item and no tool would
    // search it: "give me foods that have seed oils" returned a confident
    // "nothing matches" while get_dining_menu could already hide exactly those
    // items through avoid.
    it("finds items by what is in them, not only by name", async () => {
        const res = await call("search_menu_items", { query: "", contains: ["seed-oils"] });
        const hits = (res.structuredContent as unknown as SearchStructured).hits as unknown as {
            name: string;
        }[];
        expect(hits.length).toBeGreaterThan(0);
        // Nothing here is named for a seed oil; they are found by ingredient.
        expect(hits.every((h) => !/seed|canola|soybean/i.test(h.name))).toBe(true);
    });

    it("does not claim an item contains something when no statement exists", async () => {
        const res = await call("search_menu_items", { query: "", contains: ["gelatin"] });
        const hits = (res.structuredContent as unknown as SearchStructured).hits as unknown as {
            name: string;
            ingredientsKnown?: boolean;
        }[];
        for (const hit of hits)
            expect(hit.ingredientsKnown, `${hit.name} has no ingredient statement`).not.toBe(false);
    });
});

describe("a key the tool does not implement is an error on every tool", () => {
    // search_menu_items was made strict on its own and the other four were
    // left open, which is the same bug one tool over: get_dining_menu with
    // `excludes` returned the unfiltered dinner, six tree-nut items included,
    // from the tool whose description sells it as the one that reads labels.
    // One character between a correct answer and a nut-allergy answer.
    it.each([
        ["get_dining_menu", { location: "J2", excludes: ["PNTS"] }],
        ["get_dining_menu", { location: "J2", station_name: "Garden Bar" }],
        ["search_menu_items", { query: "pasta", maxCalories: 400 }],
        ["dining_hours", { location: "J2", time: "22:30" }],
        ["list_dining_locations", { type: "Coffee Shops" }],
        ["menu_item_nutrition", { itemNumber: "140915", portion: "1/12" }],
    ])("%s refuses %o", async (tool, args) => {
        const res = await call(tool, args as Record<string, unknown>);
        expect(res.isError, `${tool} accepted ${JSON.stringify(args)}`).toBe(true);
    });

    // The near-miss that started it: the filter works, so the only thing
    // standing between a correct answer and a wrong one is the key check.
    it("does not quietly answer an allergy question unfiltered", async () => {
        const good = await call("get_dining_menu", {
            location: "J2",
            meal: "Dinner",
            exclude: ["NTS"],
        });
        const typo = await call("get_dining_menu", {
            location: "J2",
            meal: "Dinner",
            excludes: ["NTS"],
        });
        expect(typo.isError).toBe(true);
        const nuts = (res: ToolResult) =>
            res.content
                .map((c) => c.text)
                .join("\n")
                .match(/Tree Nuts/g)?.length ?? 0;
        expect(nuts(good)).toBe(0);
    });
});

describe("a serving nobody gave is a guess that has to be labelled", () => {
    // #140915 with no serving reads the recipe's base portion, which for a
    // pizza is the whole pizza: 2961 cal against the menu's own 247 for
    // #140915*1/12. Twelvefold, with nothing in the reply to catch it.
    it("says so when it falls back to the base portion", async () => {
        const out = await textOf("menu_item_nutrition", { itemNumber: "140915" });
        expect(out).toMatch(/no serving was given/);
        expect(out).toMatch(/140915\*1\/12/);
    });

    it("says nothing of the sort when the serving was given", async () => {
        const out = await textOf("menu_item_nutrition", { itemNumber: "140915*1/12" });
        expect(out).not.toMatch(/no serving was given/);
    });
});

describe("a hall is findable by the name the other tools print", () => {
    // "J2" is this tool's own documented example and returned "No dining
    // location matching". The 3-char floor that stops "a" answering with
    // Jester Java also stopped a two-character hall name, and this path never
    // consulted the alias table every other tool uses.
    it.each([["J2"], ["JCL"], ["Kinsolving"], ["Jester City Limits"]])(
        "resolves %s",
        async (name) => {
            const out = await textOf("list_dining_locations", { name });
            expect(out, name).not.toMatch(/No dining location matching/);
        },
    );

    // Still not answering a one-letter accident.
    it.each([["a"], ["i"], ["z"]])("still refuses %s", async (name) => {
        const out = await textOf("list_dining_locations", { name });
        expect(out, name).toMatch(/No dining location matching/);
    });
});

describe("an empty result says which lever emptied it", () => {
    // "cookies without nuts, milk or wheat" reported nothing matching
    // "cookie" at all, with ten cookie rows on the week's menu: a false
    // statement about the menu, where diet in the same position is named.
    it("names the exclusion rather than blaming the query", async () => {
        const out = await textOf("search_menu_items", {
            query: "cookie",
            exclude: ["PNTS", "NTS", "MLK", "WHT"],
        });
        expect(out).toMatch(/without .*Peanut/i);
        expect(out).toMatch(/try the query on its own/);
    });

    it("names the ingredient filter the same way", async () => {
        const out = await textOf("search_menu_items", { query: "cookie", contains: ["msg"] });
        expect(out).toMatch(/containing added MSG/);
        expect(out).toMatch(/try the query on its own/);
    });
});

describe("dining_hours does not borrow the menu's published week", () => {
    // parseDate falls back into the Monday-to-Sunday feed window, which
    // dining_hours does not have: it answers for any date UT has a schedule
    // for, so "what time does J2 close monday" answered about last Monday.
    it("reads a bare weekday as the one ahead", async () => {
        const out = await textOf("dining_hours", { location: "J2", date: "monday" });
        expect(out).toMatch(/10\/19\/2026/); // the Monday after the fixed now
        expect(out).not.toMatch(/10\/12\/2026/);
    });

    it("still reads it backwards for the menu, which has a week", async () => {
        const out = await textOf("get_dining_menu", { location: "J2", date: "monday" });
        expect(out).toMatch(/10\/12\/2026/);
    });
});

describe("menu_item_nutrition output", () => {
    it("prints the label, its allergens and its ingredients", async () => {
        const out = await textOf("menu_item_nutrition", { itemNumber: "450231*1" });
        expect(out).toMatch(/Serving size:/);
        expect(out).toMatch(/Calories: \d+ per serving/);
        expect(out).toMatch(/\nContains: \w/);
        expect(out).toMatch(/\nIngredients: \w/);
    });

    // 405 of this week's labels carry an empty allergen line. Printing nothing
    // there left UT declaring none indistinguishable from nothing being read,
    // in the one tool the other two point people at for allergen checks.
    it("says so when UT's label declares no allergens", async () => {
        resetCache();
        stubFetch({
            "label.aspx": fixture("foodpro-label-450231.html").replace(
                /(class="labelallergensvalue"[^>]*>)[\s\S]*?(<)/,
                "$1$2",
            ),
        });
        // Pear Crisp is tagged SOY and WHT, so a silent label is not a clean
        // one: the tags are the answer and the reply has to say so.
        const tagged = await textOf("menu_item_nutrition", { itemNumber: "450231*1" });
        expect(tagged).toMatch(/label declares none, but the menu tags/);
        // The tag spells it "Soy" where the label would say "Soybeans".
        expect(tagged).toMatch(/Soy/);
        expect(tagged).toMatch(/Wheat/);

        // Banana is tagged vegan and nothing else, so both sources are silent
        // and the reply can say so outright.
        const clean = await textOf("menu_item_nutrition", { itemNumber: "201002*1" });
        expect(clean).toMatch(/label declares no allergens, and its menu tags name none/);
    });

    // Every UT label says "Sesame" where the menu tag says "Sesame Seeds", so
    // comparing the two as substrings re-announced the tag on 67 references
    // this week. "Crustacean Shellfish" contains "Fish" the same way, which
    // would swallow a Fish tag instead of duplicating it.
    it("does not re-announce a tag the label already covers", async () => {
        const out = await textOf("menu_item_nutrition", { itemNumber: "450231*1" });
        const contains = out.split("\n").find((l) => l.startsWith("Contains:")) ?? "";
        expect(contains).toBeTruthy();
        // Whatever it lists, it must not list the same allergen twice under two
        // spellings, which is what "also list" did.
        for (const name of ["Sesame", "Soy", "Wheat", "Milk", "Fish"]) {
            const spellings = (contains.match(new RegExp(name, "gi")) ?? []).length;
            expect(spellings, `${name} appears ${spellings} times in "${contains}"`).toBeLessThan(
                2,
            );
        }
    });

    it("says what it could not read rather than echoing an empty reference", async () => {
        const res = await call("menu_item_nutrition", { itemNumber: "not-a-number" });
        expect(res.isError).toBe(true);
        const out = res.content.map((c) => c.text).join("\n");
        expect(out).toContain("not-a-number");
        expect(out).not.toMatch(/for item\s*$/);
    });

    // *999999 came back as 4,145,227,855 calories and *-1 made the nutrient-row
    // regex re-anchor on a decimal point, printing 5g where UT said -151.6g.
    it.each([["140925*abc"], ["140925*999999"], ["140925*-1"], ["170985*0"], ["450231*1/0"]])(
        "refuses the serving %s rather than reporting UT's arithmetic",
        async (itemNumber) => {
            const res = await call("menu_item_nutrition", { itemNumber });
            expect(res.isError, itemNumber).toBe(true);
            expect(res.content.map((c) => c.text).join("\n")).toMatch(
                /is not a serving|not a portion of anything/,
            );
        },
    );

    it("still takes the servings the menu actually prints", async () => {
        for (const itemNumber of ["450231*1", "450231*3", "140925*1/12"]) {
            const res = await call("menu_item_nutrition", { itemNumber });
            expect(res.isError, itemNumber).toBeFalsy();
        }
    });

    it("flags a figure that contradicts itself", async () => {
        const out = await textOf("menu_item_nutrition", { itemNumber: "081906*3" });
        expect(out).toMatch(/NOTE: this figure looks wrong/);
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

    // JCL publishes a Breakfast with no recipes on any day of the week and opens
    // at 10:30. Listing it said the hall serves a meal it does not serve.
    it("does not count a meal with nothing in it as served", async () => {
        const out = await textOf("get_dining_menu", { location: "JCL", meal: "Breakfast" });
        expect(out).toMatch(/^Nothing at JCL Dining/);
        expect(out).toMatch(/Meals served that day: Lunch, Dinner/);
        expect(out).not.toMatch(/Meals served that day:[^\n]*Breakfast/);
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

    it("never reports an empty allergen list for an item nobody checked", async () => {
        const res = await call("get_dining_menu", { location: "JCL", meal: "Dinner" });
        const items = res.structuredContent!.meals.flatMap((m) =>
            m.sections.flatMap((s) => s.items),
        );
        const unchecked = items.filter((i) => i.allergenSource === "menu-tags");
        expect(unchecked.length).toBeGreaterThan(0);
        // Tags are worth reporting; an empty list from them is not a finding.
        for (const item of unchecked) expect(item.allergens, item.name).not.toEqual([]);
        expect(unchecked.some((i) => i.allergens === null)).toBe(true);
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

    // Blank means no filter, here as in matchesLocation; a station the caller
    // did give that cannot be read is a miss, not a widening of the question.
    const stationRows = async (station: string) => {
        const res = await call("get_dining_menu", { location: "J2", meal: "Lunch", station });
        return res.structuredContent!.meals.flatMap((m) => m.sections.flatMap((s) => s.items));
    };

    it.each([["   "], ["\t"]])("treats a blank station %j as no filter", async (station) => {
        const all = await stationRows("");
        expect(await stationRows(station)).toHaveLength(all.length);
    });

    it.each([["\uD83C\uDF54"], ["\u4E2D\u6587"]])(
        "treats an unreadable station %s as a miss",
        async (station) => {
            expect(await stationRows(station)).toEqual([]);
        },
    );

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

    it("can return every category it advertises", async () => {
        for (const category of CATEGORY_LIST) {
            const out = await textOf("list_dining_locations", { category });
            expect(out, `${category} is advertised but empty`).not.toMatch(
                /No locations in category/,
            );
        }
    });

    // [] would read as "accepts no payment methods"; the detail page that
    // carries them is only fetched for a named location.
    // The hours feed and the housing pages spell some places differently, which
    // put 29 rows in the roster for 26 real locations and listed La Fonda as
    // both a Restaurant and a Food Truck.
    it("lists each location once, under the name dining_hours prints", async () => {
        const list = await call("list_dining_locations", {});
        const rows = (list.structuredContent as unknown as { locations: { name: string }[] })
            .locations;
        const keys = rows.map((r) => r.name.toLowerCase().replace(/[^a-z0-9]/g, ""));
        expect(new Set(keys).size, "a location is listed twice").toBe(keys.length);
        // No row's name is a prefix of another's: that is the shape of the
        // duplicate this merge removes.
        for (const a of keys)
            for (const b of keys)
                if (a !== b)
                    expect(b.startsWith(a), `${a} and ${b} are the same place`).toBe(false);

        const hours = await call("dining_hours", {});
        const printed = (hours.structuredContent as unknown as { locations: { name: string }[] })
            .locations;
        expect(rows.length).toBe(printed.length);
        // Every name dining_hours prints has to be in the roster verbatim.
        for (const row of printed) expect(rows.map((r) => r.name)).toContain(row.name);
    });

    // "La Fonda Food Trailer" is the feed's spelling; the detail page is filed
    // under "La Fonda". Looking it up by the name dining_hours prints used to
    // land on the feed row, which has coordinates and nothing else.
    it("fills in the detail for a location the two sources name differently", async () => {
        const out = await textOf("list_dining_locations", { name: "La Fonda Food Trailer" });
        expect(out).toMatch(/La Fonda/);
        // Something beyond the coordinates the feed row carries on its own.
        expect(out, "resolved to the bare feed row").toMatch(/Address|Payment|Source/);
    });

    // FoodPro keys its coordinates by the feed's spelling, and the roster row
    // now carries that spelling while the map key kept the housing one, so the
    // three renamed places silently lost their coordinates.
    it("keeps coordinates for a location the two sources name differently", async () => {
        const list = await call("list_dining_locations", {});
        const rows = (
            list.structuredContent as unknown as {
                locations: { name: string; latitude: number | null }[];
            }
        ).locations;
        const fonda = rows.find((r) => /La Fonda/.test(r.name));
        expect(fonda, "La Fonda is missing from the roster").toBeTruthy();
        expect(fonda!.name).toBe("La Fonda Food Trailer");
        expect(fonda!.latitude, "lost its coordinates in the merge").not.toBeNull();
    });

    it("leaves payment unknown in the list and fills it in for one location", async () => {
        const list = await call("list_dining_locations", {});
        const rows = (list.structuredContent as unknown as { locations: { payment: unknown }[] })
            .locations;
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.every((r) => r.payment === null)).toBe(true);
        const one = await call("list_dining_locations", { name: "Noodle Lab" });
        const detail = (one.structuredContent as unknown as { locations: { payment: unknown }[] })
            .locations[0]!;
        expect(Array.isArray(detail.payment)).toBe(true);
    });

    it("advertises every category it puts a location in", async () => {
        const all = await call("list_dining_locations", {});
        const present = new Set(
            (
                all.structuredContent as unknown as { locations: { category: string }[] }
            ).locations.map((l) => l.category),
        );
        expect(present.size).toBeGreaterThan(1);
        for (const category of present) {
            expect(CATEGORY_LIST as readonly string[], `${category} is not advertised`).toContain(
                category,
            );
            const out = await textOf("list_dining_locations", { category });
            expect(out, category).not.toMatch(/No locations in category/);
        }
    });

    // A model that reads a category off one tool and asks the other for it has
    // to get an answer. The two sources name one group differently, and the
    // housing spelling used to win, so dining_hours printed a Markets heading
    // over locations list_dining_locations said were not in any such category.
    it("agrees with dining_hours about what the categories are", async () => {
        const hours = await call("dining_hours", {});
        const printed = new Set(
            (
                hours.structuredContent as unknown as { locations: { category: string }[] }
            ).locations.map((l) => l.category),
        );
        expect(printed.size).toBeGreaterThan(1);
        for (const category of printed) {
            expect(CATEGORY_LIST as readonly string[], `${category} is not advertised`).toContain(
                category,
            );
            const out = await textOf("list_dining_locations", { category });
            expect(out, category).not.toMatch(/No locations in category/);
        }
    });
});
