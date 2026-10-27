import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import {
    DIET_LEGENDS,
    allergens,
    austinNow,
    dietTags,
    getLocationDetail,
    getLocations,
    getMenu,
    getMenuWindow,
    getNutrition,
    hoursForDate,
    labelHasAllergen,
    matchesLocation,
    parseDate,
    searchMenuItems,
    statusAt,
    withNutrition,
    type MenuItem,
} from "../lib/dining";

const MAX_ROWS = 60;

/** A code that isn't recognised would silently filter nothing, so reject it. */
const codes = (list: string[] | undefined, field: string) => {
    const out = (list ?? []).map((code) => code.trim().toUpperCase());
    const bad = out.filter((code) => !DIET_LEGENDS[code]);
    if (bad.length) {
        throw new Error(
            `Unknown ${field} code(s): ${bad.join(", ")}. Valid codes are ` +
                `${Object.entries(DIET_LEGENDS)
                    .map(([code, label]) => `${code} (${label})`)
                    .join(", ")}.`,
        );
    }
    return out;
};

const text = (body: string) => ({ content: [{ type: "text" as const, text: body }] });

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

function cap<T>(rows: T[], limit: number, render: (row: T) => string): string {
    const shown = rows.slice(0, limit).map(render).join("\n");
    return rows.length > limit
        ? `${shown}\n\n(${rows.length - limit} of ${rows.length} not shown; narrow the search)`
        : shown;
}

const minutes = (n: number) => (n >= 60 ? `${Math.floor(n / 60)}h ${n % 60}m` : `${n}m`);

const CODES = Object.entries(DIET_LEGENDS)
    .map(([code, label]) => `${code} (${label})`)
    .join(", ");

/** The six categories UT groups locations under. */
const CATEGORIES =
    "Dining Halls, Restaurants, Coffee Shops, Markets, Food Trucks, Convenience Stores";

const NUTRITION_SHAPE = z
    .object({
        calories: z.number().nullable(),
        protein: z.number().nullable(),
        carbs: z.number().nullable(),
        fat: z.number().nullable(),
        fiber: z.number().nullable(),
        sugar: z.number().nullable(),
        sodium: z.number().nullable(),
    })
    .nullable();

const MENU_OUTPUT = z.object({
    location: z.string(),
    date: z.string(),
    lastCached: z.string(),
    nutritionCoverage: z.object({ withNutrition: z.number(), items: z.number() }),
    meals: z.array(
        z.object({
            meal: z.string(),
            sections: z.array(
                z.object({
                    station: z.string(),
                    items: z.array(
                        z.object({
                            id: z.string(),
                            name: z.string(),
                            serving: z.string().nullable(),
                            dietary: z.array(z.string()),
                            allergens: z.array(z.string()),
                            allergenSource: z.string(),
                            nutrition: NUTRITION_SHAPE,
                        }),
                    ),
                }),
            ),
        }),
    ),
});

export function registerDiningTools(server: McpServer): void {
    server.registerTool(
        "get_dining_menu",
        {
            title: "Get dining menu",
            description:
                "Get a UT Austin dining hall menu for one day and meal, with per-serving nutrition for every item: " +
                "calories, protein, carbs, fat, fiber and sodium, plus allergens and dietary tags. " +
                "Built for meal planning: one call returns what is needed to assemble meals against calorie or " +
                "macro targets and dietary restrictions. Menus cover the current week only, and only the dining " +
                "halls (J2, Kins, JCL). Prefer the structured output when totalling macros.",
            inputSchema: z.object({
                location: z.string().describe('Dining hall: "J2", "Kins" or "JCL"'),
                date: z
                    .string()
                    .optional()
                    .describe('"today" (default), "tomorrow", "friday", or "2026-10-16"'),
                meal: z
                    .string()
                    .optional()
                    .describe('"Breakfast", "Lunch" or "Dinner". Omit for all three.'),
                diet: z
                    .array(z.string())
                    .optional()
                    .describe(
                        `Keep only items carrying every one of these. Usually a dietary tag: ` +
                            `VGN (Vegan), VGT (Vegetarian), HAL (Halal Friendly). All codes: ${CODES}`,
                    ),
                exclude: z
                    .array(z.string())
                    .optional()
                    .describe(
                        `Drop items carrying any of these, for allergies and restrictions, ` +
                            `e.g. ["PNTS","NTS"] for a nut allergy. All codes: ${CODES}`,
                    ),
                station: z
                    .string()
                    .optional()
                    .describe(
                        'Only this serving station, e.g. "Garden Bar" or "Comfort Table". ' +
                            "A station is small enough that every item comes back with nutrition.",
                    ),
            }),
            outputSchema: MENU_OUTPUT,
        },
        guard(
            async ({
                location,
                date,
                meal,
                diet,
                exclude,
                station,
            }: {
                location: string;
                date?: string;
                meal?: string;
                diet?: string[];
                exclude?: string[];
                station?: string;
            }) => {
                const mdy = parseDate(date);

                // An unrecognised code must never pass silently: a dietary
                // restriction that fails open hands someone an allergen.
                const want = codes(diet, "diet");
                const avoid = codes(exclude, "exclude");

                const menu = await getMenu(location, mdy, meal);
                const keep = (item: MenuItem) =>
                    (!want.length || want.every((tag) => item.legends.includes(tag))) &&
                    (!avoid.length || !avoid.some((tag) => item.legends.includes(tag)));

                const meals = menu.meals
                    .map((entry) => ({
                        meal: entry.meal,
                        sections: entry.sections
                            .filter(
                                (section) =>
                                    !station ||
                                    section.section
                                        .toLowerCase()
                                        .includes(station.trim().toLowerCase()),
                            )
                            .map((section) => ({ ...section, items: section.items.filter(keep) }))
                            .filter((section) => section.items.length),
                    }))
                    .filter((entry) => entry.sections.length);

                if (!meals.length) {
                    const why = [
                        meal ? `for ${meal}` : "",
                        station ? `at station "${station}"` : "",
                        want.length ? `tagged ${want.join(", ")}` : "",
                        avoid.length ? `without ${avoid.join(", ")}` : "",
                    ]
                        .filter(Boolean)
                        .join(" ");
                    const served = meal
                        ? (await getMenu(location, mdy)).meals.map((entry) => entry.meal)
                        : [];
                    // An empty result still has to satisfy outputSchema, or the
                    // client rejects the whole response instead of showing this.
                    return {
                        content: [
                            {
                                type: "text" as const,
                                text:
                                    `Nothing at ${menu.location} on ${mdy} ${why || "matched"}.` +
                                    (served.length
                                        ? ` Meals served that day: ${served.join(", ")}.`
                                        : ""),
                            },
                        ],
                        structuredContent: {
                            location: menu.location,
                            date: mdy,
                            lastCached: menu.lastCached,
                            nutritionCoverage: { withNutrition: 0, items: 0 },
                            meals: [],
                        },
                    };
                }

                // Only now, once filters have cut the list, spend the label budget.
                const shown = meals.flatMap((entry) =>
                    entry.sections.flatMap((section) => section.items),
                );
                const { covered, total } = await withNutrition(shown);

                // Menu tags under-report: 450257 is tagged vegan with wheat and
                // soy, but its label also lists tree nuts. Now that the labels
                // are here, drop anything they reveal.
                //
                // An item whose label went unread has nothing behind it but the
                // tags, and 35 of this week's recipes carry none at all. Chocolate
                // Pistacio Cloud Cake is untagged and its label lists peanuts, so
                // unverified items are held back rather than shown as safe.
                let caughtByLabel = 0;
                let withheld = 0;
                if (avoid.length) {
                    for (const entry of meals) {
                        for (const section of entry.sections) {
                            const kept: MenuItem[] = [];
                            for (const item of section.items) {
                                if (avoid.some((code) => labelHasAllergen(item, code)))
                                    caughtByLabel++;
                                else if (!item.labelChecked) withheld++;
                                else kept.push(item);
                            }
                            section.items = kept;
                        }
                        entry.sections = entry.sections.filter((section) => section.items.length);
                    }
                }

                const line = (item: MenuItem) => {
                    const n = item.nutrition;
                    const macro = n
                        ? [
                              n.calories !== undefined ? `${Math.round(n.calories)} cal` : "",
                              n.protein !== undefined ? `P ${n.protein}` : "",
                              n.carbs !== undefined ? `C ${n.carbs}` : "",
                              n.fat !== undefined ? `F ${n.fat}` : "",
                              n.fiber ? `fib ${n.fiber}` : "",
                              n.sodium ? `Na ${Math.round(n.sodium)}mg` : "",
                          ]
                              .filter(Boolean)
                              .join(" ")
                        : "nutrition unavailable";
                    const allergenList = item.labelAllergens?.length
                        ? item.labelAllergens
                        : allergens(item.legends);
                    const notes = [
                        ...dietTags(item.legends),
                        ...(allergenList.length ? [`contains ${allergenList.join("/")}`] : []),
                    ].join(", ");
                    const ref = item.serving ? `${item.number}*${item.serving}` : item.number;
                    return `    ${item.name}${item.serving ? ` (${item.serving})` : ""} · ${macro}${notes ? ` · ${notes}` : ""} · #${ref}`;
                };

                const caught = caughtByLabel
                    ? `
${caughtByLabel} item(s) were dropped because their label lists an allergen the menu tags omit.`
                    : "";
                const unverified = withheld
                    ? `
${withheld} item(s) are not listed: their labels could not all be read in one request, and the menu tags alone are not enough to call an item safe. Narrow by meal or station to have those checked too.`
                    : "";
                const coverage =
                    covered < total
                        ? `\nNutrition shown for ${covered} of ${total} items; UT publishes it one item at a time. ` +
                          "Ask for a single station to get every item covered, or call " +
                          "menu_item_nutrition for one item. Stations here: " +
                          meals
                              .flatMap((entry) => entry.sections.map((section) => section.section))
                              .join(", ")
                        : "";

                const body =
                    `${menu.location} — ${mdy}\n\n` +
                    meals
                        .map(
                            (entry) =>
                                `${entry.meal}\n` +
                                entry.sections
                                    .map(
                                        (section) =>
                                            `  ${section.section}\n` +
                                            section.items.map(line).join("\n"),
                                    )
                                    .join("\n"),
                        )
                        .join("\n\n") +
                    `\n\nPer serving. P/C/F are grams. Menu data cached by UT at ${menu.lastCached}.${coverage}${caught}${unverified}`;

                const structuredContent = {
                    location: menu.location,
                    date: mdy,
                    lastCached: menu.lastCached,
                    nutritionCoverage: { withNutrition: covered, items: total },
                    meals: meals.map((entry) => ({
                        meal: entry.meal,
                        sections: entry.sections.map((section) => ({
                            station: section.section,
                            items: section.items.map((item) => ({
                                id: item.serving ? `${item.number}*${item.serving}` : item.number,
                                name: item.name,
                                serving: item.serving ?? null,
                                dietary: dietTags(item.legends),
                                allergens: item.labelAllergens?.length
                                    ? item.labelAllergens
                                    : allergens(item.legends),
                                // "menu-tags" means nobody read the label, so an
                                // empty list there is unknown, not allergen-free.
                                allergenSource: item.labelChecked ? "label" : "menu-tags",
                                nutrition: item.nutrition
                                    ? {
                                          calories: item.nutrition.calories ?? null,
                                          protein: item.nutrition.protein ?? null,
                                          carbs: item.nutrition.carbs ?? null,
                                          fat: item.nutrition.fat ?? null,
                                          fiber: item.nutrition.fiber ?? null,
                                          sugar: item.nutrition.sugar ?? null,
                                          sodium: item.nutrition.sodium ?? null,
                                      }
                                    : null,
                            })),
                        })),
                    })),
                };

                return { content: [{ type: "text" as const, text: body }], structuredContent };
            },
        ),
    );

    server.registerTool(
        "dining_hours",
        {
            title: "Dining hours",
            description:
                "Get UT Austin dining hours, including which locations are open right now in Austin time and when " +
                "they close. Defaults to today. Handles special schedules such as finals, breaks and holidays.",
            inputSchema: z.object({
                date: z
                    .string()
                    .optional()
                    .describe('"today" (default), "tomorrow", "friday", or "2026-10-16"'),
                location: z.string().optional().describe('Only this location, e.g. "J2"'),
                openOnly: z.boolean().optional().describe("Only locations open at the given time"),
                at: z
                    .string()
                    .optional()
                    .describe('Time to check, e.g. "19:30". Defaults to now for today.'),
            }),
        },
        guard(
            async ({
                date,
                location,
                openOnly,
                at,
            }: {
                date?: string;
                location?: string;
                openOnly?: boolean;
                at?: string;
            }) => {
                const mdy = parseDate(date);
                const now = austinNow();
                const isToday = mdy === now.mdy;

                const DEFAULT_HOUR = 12;
                let when = isToday ? now.minutes : DEFAULT_HOUR * 60;
                if (at) {
                    const parsed = at.match(/^(\d{1,2}):?(\d{2})?\s*(am|pm)?$/i);
                    if (!parsed)
                        return text(`Couldn't read time "${at}". Try "19:30" or "7:30pm".`);
                    let hour = Number(parsed[1]);
                    const minute = Number(parsed[2] ?? 0);
                    const suffix = (parsed[3] ?? "").toLowerCase();
                    if (suffix && (hour < 1 || hour > 12))
                        return text(`"${at}" is not a valid 12-hour time.`);
                    if (!suffix && hour > 23) return text(`"${at}" is not a valid time of day.`);
                    if (minute > 59) return text(`"${at}" is not a valid time of day.`);
                    if (suffix === "pm" && hour < 12) hour += 12;
                    if (suffix === "am" && hour === 12) hour = 0;
                    when = hour * 60 + minute;
                }

                const period = await hoursForDate(mdy);
                let rows = await statusAt(mdy, when);
                if (location) {
                    rows = rows.filter((row) => matchesLocation(row.name, location));
                    if (!rows.length) return text(`No dining location matching "${location}".`);
                }
                if (openOnly) rows = rows.filter((row) => row.open);
                if (!rows.length) return text(`Nothing is open at that time on ${mdy}.`);

                const clock = `${String(Math.floor(when / 60)).padStart(2, "0")}:${String(when % 60).padStart(2, "0")}`;
                const groups = new Map<string, typeof rows>();
                for (const row of rows)
                    groups.set(row.category, [...(groups.get(row.category) ?? []), row]);

                const body = [...groups]
                    .map(
                        ([category, items]) =>
                            `${category}\n` +
                            items
                                .map((row) => {
                                    const state = row.open
                                        ? `OPEN  (closes in ${minutes(row.closesIn!)})`
                                        : row.opensIn
                                          ? `closed (opens in ${minutes(row.opensIn)})`
                                          : "closed";
                                    return `  ${row.name.padEnd(28)} ${row.hours.padEnd(34)} ${state}`;
                                })
                                .join("\n"),
                    )
                    .join("\n\n");

                return text(
                    `Dining hours for ${mdy} at ${clock} Austin time${isToday && !at ? " (now)" : ""}\n` +
                        `Schedule: ${period.label}\n\n${body}`,
                );
            },
        ),
    );

    server.registerTool(
        "list_dining_locations",
        {
            title: "List dining locations",
            description:
                "List UT Austin campus dining locations: dining halls, restaurants, coffee shops, convenience " +
                "stores and food trucks. Pass a name for one location's detail: description, street address, " +
                "building and accepted payment methods.",
            inputSchema: z.object({
                name: z
                    .string()
                    .optional()
                    .describe('A specific location, e.g. "J2" or "Noodle Lab"'),
                category: z.string().optional().describe(`Filter by type. One of: ${CATEGORIES}`),
            }),
        },
        guard(async ({ name, category }: { name?: string; category?: string }) => {
            if (name) {
                const location = await getLocationDetail(name);
                if (!location) {
                    return text(
                        `No dining location matching "${name}". Call this tool with no arguments to list them.`,
                    );
                }
                return text(
                    [
                        `${location.name} (${location.category})`,
                        "",
                        location.description ?? "",
                        location.address ? `\nAddress: ${location.address}` : "",
                        location.building ? `Building: ${location.building}` : "",
                        location.payment?.length ? `Payment: ${location.payment.join(", ")}` : "",
                        location.lat ? `Coordinates: ${location.lat}, ${location.lon}` : "",
                        location.url ? `\nSource: ${location.url}` : "",
                    ]
                        .filter(Boolean)
                        .join("\n"),
                );
            }

            const all = await getLocations();
            const query = (category ?? "").toLowerCase();
            const rows = all.filter((row) => !query || row.category.toLowerCase().includes(query));
            if (!rows.length) {
                const real = [...new Set(all.map((row) => row.category))].sort((a, b) =>
                    a.localeCompare(b),
                );
                return text(
                    `No locations in category "${category}". Categories are: ${real.join(", ")}.`,
                );
            }

            const groups = new Map<string, typeof rows>();
            for (const row of rows)
                groups.set(row.category, [...(groups.get(row.category) ?? []), row]);
            return text(
                [...groups]
                    .map(
                        ([name_, items]) =>
                            `${name_}\n` + items.map((item) => `  ${item.name}`).join("\n"),
                    )
                    .join("\n\n"),
            );
        }),
    );

    server.registerTool(
        "search_menu_items",
        {
            title: "Search menu items",
            description:
                "Search every UT Austin dining hall menu in the published week for a dish, to find where and when " +
                "it is served. Use when the hall is not known yet; use get_dining_menu when it is.",
            inputSchema: z.object({
                query: z.string().describe('Words in the item name, e.g. "chicken tikka"'),
                date: z.string().optional().describe('Restrict to one day, e.g. "friday"'),
                location: z.string().optional().describe("Restrict to one dining hall"),
                diet: z
                    .array(z.string())
                    .optional()
                    .describe(`Keep only items carrying every one of these. All codes: ${CODES}`),
            }),
        },
        guard(
            async ({
                query,
                date,
                location,
                diet,
            }: {
                query: string;
                date?: string;
                location?: string;
                diet?: string[];
            }) => {
                const { hits, lastCached } = await searchMenuItems(query, {
                    date: date ? parseDate(date) : undefined,
                    location,
                    diet: diet ? codes(diet, "diet") : undefined,
                });
                if (!hits.length) {
                    const window = await getMenuWindow();
                    return text(
                        `No menu item matches "${query}" between ${window.dates[0]} and ` +
                            `${window.dates[window.dates.length - 1]} at ${window.locations.join(", ")}.`,
                    );
                }
                const body = cap(hits, MAX_ROWS, (hit) => {
                    const allergenList = allergens(hit.item.legends);
                    const notes = [
                        ...dietTags(hit.item.legends),
                        ...(allergenList.length ? [`contains ${allergenList.join("/")}`] : []),
                    ].join(", ");
                    const ref = hit.item.serving
                        ? `#${hit.item.number}*${hit.item.serving}`
                        : `#${hit.item.number}`;
                    return `  ${hit.date}  ${hit.meal.padEnd(9)} ${hit.location.padEnd(12)} ${hit.item.name}${notes ? ` · ${notes}` : ""}  (${ref})`;
                });
                return text(
                    `${hits.length} match(es) for "${query}":\n\n${body}\n\n` +
                        `Menu data cached by UT at ${lastCached}. ` +
                        "For nutrition, call menu_item_nutrition with an item reference, or get_dining_menu for a meal.",
                );
            },
        ),
    );

    server.registerTool(
        "menu_item_nutrition",
        {
            title: "Menu item nutrition",
            description:
                "Get the full nutrition label and ingredient list for one UT Austin dining item, by the reference " +
                "shown in get_dining_menu or search_menu_items. Returns every nutrient plus the complete " +
                "ingredient statement, which the menu does not carry. Useful for allergen checks.",
            inputSchema: z.object({
                itemNumber: z
                    .string()
                    .describe(
                        'The item reference exactly as the menu printed it, e.g. "450178*4" or "450178"',
                    ),
                serving: z
                    .string()
                    .optional()
                    .describe(
                        "Serving size, if not already part of itemNumber. Nutrition is per serving.",
                    ),
            }),
        },
        guard(async ({ itemNumber, serving }: { itemNumber: string; serving?: string }) => {
            const [number, embedded] = itemNumber.split("*");
            const label = await getNutrition(
                (number ?? "").replace(/\D/g, ""),
                serving ?? embedded,
            );
            return text(
                [
                    label.name,
                    label.servingSize ? `Serving size: ${label.servingSize}` : "",
                    label.calories ? `Calories: ${label.calories} per serving` : "",
                    "",
                    ...label.nutrients.map(
                        (row) =>
                            `  ${row.name.padEnd(22)} ${row.amount.padEnd(10)}${row.dv ? ` ${row.dv} DV` : ""}`,
                    ),
                    label.allergens ? `\nContains: ${label.allergens}` : "",
                    label.ingredients ? `\nIngredients: ${label.ingredients}` : "",
                ]
                    .filter(Boolean)
                    .join("\n"),
            );
        }),
    );
}
