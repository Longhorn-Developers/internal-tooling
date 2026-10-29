import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import {
    AVOID_INGREDIENTS,
    DIET_LEGENDS,
    allergens,
    austinNow,
    dietTags,
    getLocationDetail,
    getLocations,
    getMenu,
    getMenuWindow,
    getNutrition,
    implausible,
    macrosFromLabel,
    isAllergenCode,
    hoursForDate,
    labelHasAllergen,
    matchesLocation,
    mergedAllergens,
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
const AVOID_KEYS = Object.entries(AVOID_INGREDIENTS)
    .map(([key, v]) => `${key} (${v.label})`)
    .join(", ");

const CATEGORIES =
    "Dining Halls, Restaurants, Coffee Shops, Markets, Food Trucks, Convenience Stores";

const NUTRITION_SHAPE = z
    .object({
        servingSize: z.string().nullable(),
        calories: z.number().nullable(),
        protein: z.number().nullable(),
        carbs: z.number().nullable(),
        fat: z.number().nullable(),
        fiber: z.number().nullable(),
        sugar: z.number().nullable(),
        sodium: z.number().nullable(),
    })
    .nullable();

const HOURS_OUTPUT = z.object({
    date: z.string(),
    at: z.string(),
    timezone: z.string(),
    schedule: z.string(),
    locations: z.array(
        z.object({
            name: z.string(),
            category: z.string(),
            hours: z.string(),
            open: z.boolean(),
            minutesToClose: z.number().nullable(),
            minutesToOpen: z.number().nullable(),
        }),
    ),
});

const SEARCH_OUTPUT = z.object({
    query: z.string(),
    matched: z.number(),
    shown: z.number(),
    lastCached: z.string(),
    hits: z.array(
        z.object({
            id: z.string(),
            name: z.string(),
            date: z.string(),
            isToday: z.boolean(),
            meal: z.string(),
            location: z.string(),
            station: z.string(),
            dietary: z.array(z.string()),
            allergens: z.array(z.string()),
            exact: z.boolean(),
        }),
    ),
});

const LOCATIONS_OUTPUT = z.object({
    locations: z.array(
        z.object({
            name: z.string(),
            category: z.string(),
            building: z.string().nullable(),
            address: z.string().nullable(),
            latitude: z.number().nullable(),
            longitude: z.number().nullable(),
            payment: z.array(z.string()),
        }),
    ),
});

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
                            allergens: z.array(z.string()).nullable(),
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
                "halls (J2, Kins, JCL). Prefer the structured output when totalling macros. " +
                "Each line ends with a reference like #081906*3, which is the recipe and its serving. " +
                "Pass it to menu_item_nutrition for an item this call could not cover, or for the " +
                "ingredient statement. Keep the serving: the same recipe is different nutrition at a " +
                "different portion. It is for calling the other tools, not for showing to the person " +
                "asking, who wants the dish name.",
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
                avoid: z
                    .array(z.string())
                    .optional()
                    .describe(
                        `Drop items whose ingredient list contains one of these. Preference, not ` +
                            `allergy -- use exclude for allergens, which reads the label. One of: ` +
                            `${AVOID_KEYS}.`,
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
                avoid: avoidIngredients,
                station,
            }: {
                location: string;
                date?: string;
                meal?: string;
                diet?: string[];
                exclude?: string[];
                avoid?: string[];
                station?: string;
            }) => {
                const mdy = parseDate(date);

                // An unrecognised code must never pass silently: a dietary
                // restriction that fails open hands someone an allergen.
                const want = codes(diet, "diet");
                const avoid = codes(exclude, "exclude");

                // Preference, not safety: these come from the feed's ingredient text, which
                // is not the allergen label. An unknown key is rejected the same way a bad
                // diet code is, so a filter never silently does nothing.
                const unknownAvoid = (avoidIngredients ?? []).filter((k) => !AVOID_INGREDIENTS[k]);
                if (unknownAvoid.length) {
                    throw new Error(
                        `Unknown avoid key(s): ${unknownAvoid.join(", ")}. Valid keys are ${AVOID_KEYS}.`,
                    );
                }
                const skip = avoidIngredients ?? [];

                const menu = await getMenu(location, mdy, meal);
                const keep = (item: MenuItem) =>
                    (!want.length || want.every((tag) => item.legends.includes(tag))) &&
                    (!avoid.length || !avoid.some((tag) => item.legends.includes(tag))) &&
                    (!skip.length || !skip.some((k) => item.avoid.includes(k)));

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
                // Only allergens need the label. Excluding VGT is a menu-tag
                // question and already settled, so it shouldn't withhold anything.
                const needsLabel = avoid.filter(isAllergenCode);
                if (needsLabel.length) {
                    for (const entry of meals) {
                        for (const section of entry.sections) {
                            const kept: MenuItem[] = [];
                            for (const item of section.items) {
                                if (needsLabel.some((code) => labelHasAllergen(item, code)))
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
                              n.protein !== undefined ? `P ${n.protein}g` : "",
                              n.carbs !== undefined ? `C ${n.carbs}g` : "",
                              n.fat !== undefined ? `F ${n.fat}g` : "",
                              n.fiber ? `fib ${n.fiber}g` : "",
                              n.sodium ? `Na ${Math.round(n.sodium)}mg` : "",
                          ]
                              .filter(Boolean)
                              .join(" ")
                        : "nutrition unavailable";
                    const allergenList = mergedAllergens(item);
                    const notes = [
                        ...dietTags(item.legends),
                        ...(allergenList.length ? [`contains ${allergenList.join("/")}`] : []),
                    ].join(", ");
                    const ref = item.serving ? `${item.number}*${item.serving}` : item.number;
                    // serving is a multiplier on the recipe's base portion, so "(3)"
                    // means nothing on its own. The label prints "3 oz"; use that.
                    const portion = n?.servingSize ?? (item.serving ? `${item.serving}x` : "");
                    const odd = n ? implausible(n) : undefined;
                    return `    ${item.name}${portion ? ` (${portion})` : ""} · ${macro}${notes ? ` · ${notes}` : ""}${odd ? ` · FIGURE LOOKS WRONG: ${odd}, treat as unverified` : ""} · #${ref}`;
                };

                // A warning under four thousand characters of menu is one nobody reads.
                // Anything that withholds items belongs above them.
                const shownItems = meals.flatMap((entry) =>
                    entry.sections.flatMap((section) => section.items),
                );
                const coveredRows = shownItems.filter((item) => item.nutrition).length;
                const caught = caughtByLabel
                    ? `
${caughtByLabel} item(s) were dropped because their label lists an allergen the menu tags omit.`
                    : "";
                const unverified = withheld
                    ? `
${withheld} item(s) are not listed: their labels could not all be read in one request, and the menu tags alone are not enough to call an item safe. Narrow by meal or station to have those checked too.`
                    : "";
                const coverage =
                    coveredRows < shownItems.length
                        ? `\nNutrition shown for ${coveredRows} of ${shownItems.length} items listed (${covered} of ${total} distinct recipes); UT publishes it one item at a time. ` +
                          "Ask for a single station to get every item covered, or call " +
                          "menu_item_nutrition for one item. Stations here: " +
                          meals
                              .flatMap((entry) => entry.sections.map((section) => section.section))
                              .join(", ")
                        : "";

                const lead = withheld
                    ? `WITHHELD: ${withheld} of ${shownItems.length + withheld} items are not listed ` +
                      `below. Their allergen labels could not all be read in one request, and the menu ` +
                      `tags alone cannot clear them, so this is not the full menu. Ask for one meal or ` +
                      `station to have the rest checked.\n\n`
                    : "";
                const body =
                    lead +
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
                    `\n\nFigures are per serving; the size in brackets is what the label prints. Menu data cached by UT at ${menu.lastCached}.${coverage}${caught}${unverified}`;

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
                                // null, not [], when nobody read the label: an empty list there is
                                // unknown, and [] reads as a positive claim of allergen-free.
                                allergens: item.labelChecked ? mergedAllergens(item) : null,
                                // Both sources miss things the other catches, so
                                // the list is the union. "menu-tags" means nobody
                                // read the label, and an empty list there is
                                // unknown rather than allergen-free.
                                allergenSource: item.labelChecked ? "label+menu-tags" : "menu-tags",
                                nutrition: item.nutrition
                                    ? {
                                          servingSize: item.nutrition.servingSize ?? null,
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
            outputSchema: HOURS_OUTPUT,
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

                // Declaring an outputSchema makes every non-error return answer to it, so the
                // explanatory paths carry an empty payload rather than text on its own.
                const nothing = (why: string) =>
                    textWith(why, {
                        date: mdy,
                        at: "",
                        timezone: "America/Chicago",
                        schedule: "",
                        locations: [],
                    });

                const DEFAULT_HOUR = 12;
                let when = isToday ? now.minutes : DEFAULT_HOUR * 60;
                if (at) {
                    const parsed = at.match(/^(\d{1,2}):?(\d{2})?\s*(am|pm)?$/i);
                    if (!parsed)
                        return nothing(`Couldn't read time "${at}". Try "19:30" or "7:30pm".`);
                    let hour = Number(parsed[1]);
                    const minute = Number(parsed[2] ?? 0);
                    const suffix = (parsed[3] ?? "").toLowerCase();
                    if (suffix && (hour < 1 || hour > 12))
                        return nothing(`"${at}" is not a valid 12-hour time.`);
                    if (!suffix && hour > 23) return nothing(`"${at}" is not a valid time of day.`);
                    if (minute > 59) return nothing(`"${at}" is not a valid time of day.`);
                    if (suffix === "pm" && hour < 12) hour += 12;
                    if (suffix === "am" && hour === 12) hour = 0;
                    when = hour * 60 + minute;
                }

                const period = await hoursForDate(mdy);
                let rows = await statusAt(mdy, when);
                if (location) {
                    rows = rows.filter((row) => matchesLocation(row.name, location));
                    if (!rows.length) return nothing(`No dining location matching "${location}".`);
                }
                if (openOnly) rows = rows.filter((row) => row.open);
                if (!rows.length) return nothing(`Nothing is open at that time on ${mdy}.`);

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

                return textWith(
                    `Dining hours for ${mdy} at ${clock} Austin time${isToday && !at ? " (now)" : ""}\n` +
                        `Schedule: ${period.label}\n\n${body}`,
                    {
                        date: mdy,
                        at: clock,
                        timezone: "America/Chicago",
                        schedule: period.label,
                        locations: rows.map((row) => ({
                            name: row.name,
                            category: row.category,
                            hours: row.hours,
                            open: row.open,
                            minutesToClose: row.closesIn ?? null,
                            minutesToOpen: row.opensIn ?? null,
                        })),
                    },
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
            outputSchema: LOCATIONS_OUTPUT,
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
                    return textWith(
                        `No dining location matching "${name}". Call this tool with no arguments to list them.`,
                        { locations: [] },
                    );
                }
                return textWith(
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
                    {
                        locations: [location].map((row) => ({
                            name: row.name,
                            category: row.category,
                            building: row.building ?? null,
                            address: row.address ?? null,
                            latitude: row.lat ?? null,
                            longitude: row.lon ?? null,
                            payment: row.payment ?? [],
                        })),
                    },
                );
            }

            const all = await getLocations();
            const query = (category ?? "").toLowerCase();
            const rows = all.filter((row) => !query || row.category.toLowerCase().includes(query));
            if (!rows.length) {
                const real = [...new Set(all.map((row) => row.category))].sort((a, b) =>
                    a.localeCompare(b),
                );
                return textWith(
                    `No locations in category "${category}". Categories are: ${real.join(", ")}.`,
                    { locations: [] },
                );
            }

            const groups = new Map<string, typeof rows>();
            for (const row of rows)
                groups.set(row.category, [...(groups.get(row.category) ?? []), row]);
            return textWith(
                [...groups]
                    .map(
                        ([name_, items]) =>
                            `${name_}\n` +
                            items
                                .map(
                                    (item) =>
                                        `  ${item.name.padEnd(30)}${item.building ?? item.address ?? ""}`,
                                )
                                .join("\n"),
                    )
                    .join("\n\n"),
                {
                    locations: rows.map((row) => ({
                        name: row.name,
                        category: row.category,
                        building: row.building ?? null,
                        address: row.address ?? null,
                        latitude: row.lat ?? null,
                        longitude: row.lon ?? null,
                        payment: row.payment ?? [],
                    })),
                },
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
            outputSchema: SEARCH_OUTPUT,
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
                    return textWith(
                        `Nothing on the published menu (${window.dates[0]} to ` +
                            `${window.dates[window.dates.length - 1]}, at ${window.locations.join(", ")}) ` +
                            `matches "${query}". This searches item names and station names only, not ` +
                            `ingredients, and the feed carries no drinks at all, so a miss here does not ` +
                            `mean UT never serves it.`,
                        { query, matched: 0, shown: 0, lastCached: "", hits: [] },
                    );
                }
                // Whole-word matches first; searchMenuItems already put today first.
                hits.sort((x, y) => x.tier - y.tier);
                const loose = hits.filter((h) => h.tier === 2).length;
                const body = cap(hits, MAX_ROWS, (hit) => {
                    const allergenList = allergens(hit.item.legends);
                    const notes = [
                        ...dietTags(hit.item.legends),
                        ...(allergenList.length ? [`contains ${allergenList.join("/")}`] : []),
                    ].join(", ");
                    const ref = hit.item.serving
                        ? `#${hit.item.number}*${hit.item.serving}`
                        : `#${hit.item.number}`;
                    // Saying "today" spares the model dating the row itself.
                    const when = (hit.isToday ? "today" : hit.date).padEnd(10);
                    return `  ${when}  ${hit.meal.padEnd(9)} ${hit.location.padEnd(12)} ${hit.item.name}${notes ? ` · ${notes}` : ""}  (${ref})${hit.tier === 2 ? "  [loose]" : ""}`;
                });
                return textWith(
                    `${hits.length} match(es) for "${query}", today first:\n\n${body}\n\n` +
                        (loose
                            ? `${loose} of these are marked [loose]: the query appears inside a ` +
                              `longer word rather than as a word of its own. Treat them as weak matches.
`
                            : "") +
                        `Menu data cached by UT at ${lastCached}. ` +
                        "For nutrition, call menu_item_nutrition with an item reference, or get_dining_menu for a meal.",
                    {
                        query,
                        matched: hits.length,
                        shown: Math.min(hits.length, MAX_ROWS),
                        lastCached,
                        hits: hits.slice(0, MAX_ROWS).map((hit) => ({
                            id: hit.item.serving
                                ? `${hit.item.number}*${hit.item.serving}`
                                : hit.item.number,
                            name: hit.item.name,
                            date: hit.date,
                            isToday: hit.isToday,
                            meal: hit.meal,
                            location: hit.location,
                            station: hit.section,
                            dietary: dietTags(hit.item.legends),
                            allergens: allergens(hit.item.legends),
                            exact: hit.tier === 1,
                        })),
                    },
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
            const odd = implausible(macrosFromLabel(label));
            return text(
                [
                    label.name,
                    label.servingSize ? `Serving size: ${label.servingSize}` : "",
                    odd
                        ? `NOTE: this figure looks wrong -- ${odd}. It is what UT publishes;` +
                          ` treat it as unverified.`
                        : "",
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
