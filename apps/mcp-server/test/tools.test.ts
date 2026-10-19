import type { McpServer } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { resetCache } from "../src/lib/http";
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
    nutritionCoverage: { withNutrition: number; items: number };
    meals: {
        meal: string;
        sections: {
            station: string;
            items: {
                id: string;
                name: string;
                allergens: string[];
                allergenSource: string;
                nutrition: { calories: number | null } | null;
            }[];
        }[];
    }[];
};

type ToolResult = {
    content: { type: string; text: string }[];
    structuredContent?: MenuStructured;
    isError?: boolean;
};

type Registered = {
    config: { title?: string; description?: string };
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

async function call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    const tool = tools()[name];
    if (!tool) throw new Error(`No such tool: ${name}`);
    return tool.handler(args, {});
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
        expect(out).toMatch(/\d+ cal P [\d.]+ C [\d.]+ F [\d.]+/);
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
        expect(await textOf("dining_hours", { date: "2026-11-26" })).toMatch(/Thanksgiving Break/);
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
    it("prefers the label's allergen list over the menu tags", async () => {
        const res = await call("get_dining_menu", { location: "J2", meal: "Lunch" });
        const items = res.structuredContent!.meals.flatMap((m) =>
            m.sections.flatMap((x) => x.items),
        );
        const fromLabel = items.filter((i) => i.allergenSource === "label");
        expect(fromLabel.length).toBeGreaterThan(0);
        expect(fromLabel.some((i) => i.allergens.some((a) => /Soybeans|Milk|Wheat/.test(a)))).toBe(
            true,
        );
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
