import { cached, getText, UpstreamError } from "./http";
import { decode, norm, text } from "./html";

const FOODPRO = "https://hf-foodpro.austin.utexas.edu/foodpro";
const ENDPOINT = `${FOODPRO}/data_all_endpoint.php`;
const HOUSING = "https://housing.utexas.edu";

export const DIET_LEGENDS: Record<string, string> = {
    BF: "Contains Beef",
    EG: "Contains Egg",
    FSH: "Contains Fish",
    MLK: "Contains Milk",
    PNTS: "Contains Peanuts",
    PRK: "Contains Pork",
    SFSH: "Contains Shellfish",
    SOY: "Contains Soy",
    NTS: "Contains Tree Nuts",
    VGN: "Vegan",
    VGT: "Vegetarian",
    WHT: "Contains Wheat",
    HAL: "Halal Friendly",
    SS: "Contains Sesame Seeds",
};

const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export function austinNow(now = new Date()) {
    const p = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Chicago",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        weekday: "long",
    }).formatToParts(now);
    const get = (t: string) => p.find((x) => x.type === t)!.value;
    const hour = Number(get("hour")) % 24;
    return {
        year: Number(get("year")),
        month: Number(get("month")),
        day: Number(get("day")),
        hour,
        minute: Number(get("minute")),
        weekday: get("weekday"),
        /** 0 = Monday, like the hours feed. */
        dayIndex: DAY_NAMES.indexOf(get("weekday")),
        minutes: hour * 60 + Number(get("minute")),
        mdy: `${get("month")}/${get("day")}/${get("year")}`,
        iso: `${get("year")}-${get("month")}-${get("day")}`,
    };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "2/30" would otherwise roll into March. */
function calendarDate(month: number, day: number, year: number, input: string): string {
    const d = new Date(Date.UTC(year, month - 1, day));
    const real =
        d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
    if (!real) throw new Error(`"${input}" is not a real date.`);
    return `${pad(month)}/${pad(day)}/${year}`;
}

/** "today", "tomorrow", "friday", "2026-10-16", "10/16/2026" -> MM/DD/YYYY. */
export function parseDate(input?: string): string {
    const now = austinNow();
    const s = (input ?? "").trim().toLowerCase();
    if (!s || s === "today") return now.mdy;

    const base = Date.UTC(now.year, now.month - 1, now.day);
    const fromOffset = (days: number) => {
        const d = new Date(base + days * 86400000);
        return `${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}/${d.getUTCFullYear()}`;
    };
    if (s === "tomorrow") return fromOffset(1);
    if (s === "yesterday") return fromOffset(-1);

    const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (iso) return calendarDate(Number(iso[2]), Number(iso[3]), Number(iso[1]), input!);

    const us = s.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
    if (us) {
        const year = us[3] ? (us[3].length === 2 ? 2000 + Number(us[3]) : Number(us[3])) : now.year;
        return calendarDate(Number(us[1]), Number(us[2]), year, input!);
    }

    // Match the whole word, not its first three characters: "saturday nov 7"
    // used to resolve to Saturday and quietly drop the rest of what was asked.
    const asWeekday = s.replace(/^(?:next|this|coming|last)\s+/, "").trim();
    const wd = /^[a-z]+$/.test(asWeekday)
        ? DAY_NAMES.findIndex(
              (d) => d.toLowerCase() === asWeekday || d.toLowerCase().slice(0, 3) === asWeekday,
          )
        : -1;
    if (wd >= 0) {
        const offset = (wd - now.dayIndex + 7) % 7;
        // "next thursday" can never mean today, and plain "thursday" on a
        // Thursday does.
        const forwardOnly = /^(?:next|coming)\s/.test(s);
        if (offset === 0 && forwardOnly) return fromOffset(7);
        if (/^last\s/.test(s)) return fromOffset(offset - 7);
        // The feed is one Monday-to-Sunday week, so on a Thursday "monday" is a
        // day that has already happened and is still published. Resolved
        // forward it landed in next week, and the reply refused with "no menu
        // published for 11/02" while printing a window that contained the
        // Monday being asked about. DAY_NAMES runs Monday..Sunday, so anything
        // past this week's Sunday belongs to the week already in hand.
        const toSunday = DAY_NAMES.length - 1 - now.dayIndex;
        return fromOffset(!forwardOnly && offset > toSunday ? offset - 7 : offset);
    }

    throw new Error(`Couldn't read date "${input}". Try "today", "friday", or "2026-10-16".`);
}

export type Range = { start: number; end: number; label: string };
export type LocationHours = { name: string; category: string; week: (Range[] | null)[] };
export type HoursPeriod = {
    label: string;
    start?: string;
    end?: string;
    locations: LocationHours[];
};

/** "7:00am" | "Noon" | "Midnight" -> minutes past midnight. */
function parseClock(token: string, isEnd: boolean): number | null {
    const s = token.trim().toLowerCase();
    if (!s) return null;
    if (s === "noon") return 12 * 60;
    if (s === "midnight") return isEnd ? 24 * 60 : 0;
    const m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*([ap])m?$/);
    if (!m) return null;
    let h = Number(m[1]) % 12;
    if (m[3] === "p") h += 12;
    return h * 60 + Number(m[2] ?? 0);
}

/** "9:00am-2:00pm|4:30pm-9:00pm" -> two ranges. "Closed" -> null. */
function parseDayHours(cell: string): Range[] | null {
    const s = cell.trim();
    if (!s || /^closed$/i.test(s)) return null;
    const out: Range[] = [];
    for (const part of s.split("|")) {
        const [a, b] = part.split(/\s*[-–]\s*/);
        if (!a || !b) continue;
        const start = parseClock(a, false);
        const end = parseClock(b, true);
        if (start === null || end === null) continue;
        // A close time at or before the open time means it runs past midnight.
        out.push({ start, end: end <= start ? end + 24 * 60 : end, label: part.trim() });
    }
    return out.length ? out : null;
}

function parseRangeLabel(label: string) {
    // Dates are normally zero-padded, but accept single digits so a stray
    // "8/24/26" doesn't drop a whole period out of the schedule lookup.
    const m = label.match(
        /\((\d{1,2})\/(\d{1,2})\/(\d{2,4})\s*-\s*(\d{1,2})\/(\d{1,2})\/(\d{2,4})\)/,
    );
    if (!m) return {};
    const yr = (y: string) => (y.length === 2 ? `20${y}` : y);
    return {
        start: `${yr(m[3]!)}-${pad(Number(m[1]))}-${pad(Number(m[2]))}`,
        end: `${yr(m[6]!)}-${pad(Number(m[4]))}-${pad(Number(m[5]))}`,
    };
}

function periodFromObject(
    label: string,
    cats: Record<string, Record<string, string[]>>,
): HoursPeriod {
    const locations: LocationHours[] = [];
    for (const [category, rows] of Object.entries(cats)) {
        for (const [name, week] of Object.entries(rows)) {
            locations.push({
                name: name.trim(),
                category,
                week: Array.from({ length: 7 }, (_, i) => parseDayHours(week[i] ?? "")),
            });
        }
    }
    return { label, ...parseRangeLabel(label), locations };
}

/** Every period the feed publishes, in feed order. ~12 KB. */
export function getFeedHours(): Promise<HoursPeriod[]> {
    return cached("dining:hours:feed", 3600, async () => {
        const body = await getText(`${ENDPOINT}?hours=1`, 3600);
        const marker = body.indexOf("diningHours");
        const start = marker < 0 ? -1 : body.indexOf("{", marker);
        const end = body.lastIndexOf("}");
        if (start < 0 || end <= start)
            throw new UpstreamError("Could not read the dining hours feed");
        const raw = JSON.parse(body.slice(start, end + 1)) as Record<
            string,
            Record<string, Record<string, string[]>>
        >;
        const periods = Object.entries(raw).map(([label, cats]) => periodFromObject(label, cats));
        if (!periods.length) throw new UpstreamError("The dining hours feed was empty");
        return periods;
    });
}

/** Shortest period covering d, since breaks and finals sit inside the semester. */
const mostSpecific = (periods: HoursPeriod[], iso: string): HoursPeriod | undefined => {
    const span = (p: HoursPeriod) => Date.parse(p.end!) - Date.parse(p.start!);
    return periods
        .filter((p) => p.start && p.end && iso >= p.start && iso <= p.end)
        .sort((a, b) => span(a) - span(b))[0];
};

/** The period in force today. */
export async function getCurrentHours(): Promise<HoursPeriod> {
    const periods = await getFeedHours();
    return mostSpecific(periods, austinNow().iso) ?? periods[0]!;
}

/** Every published period. Only needed for dates outside the current one. */
export function getAllHours(): Promise<HoursPeriod[]> {
    return cached("dining:hours:all", 21600, async () => {
        const html = await getText(`${HOUSING}/dining/hours-of-operation`, 21600);
        const periods: HoursPeriod[] = [];
        for (const chunk of html.split("<details>").slice(1)) {
            const label = text(chunk.match(/<summary>([\s\S]*?)<\/summary>/)?.[1] ?? "");
            if (!label) continue;
            const cats: Record<string, Record<string, string[]>> = {};
            const parts = chunk.split(/<h5[^>]*>/).slice(1);
            for (const part of parts) {
                const category = text(part.slice(0, part.indexOf("</h5>")));
                const body = part.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1];
                if (!category || !body) continue;
                const rows: Record<string, string[]> = {};
                for (const tr of body.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
                    const cells = [...tr[1]!.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(
                        (c) => c[1]!,
                    );
                    if (cells.length < 8) continue;
                    // two services in a day come as sibling <div>s
                    rows[text(cells[0]!)] = cells.slice(1, 8).map((c) => text(c, "|"));
                }
                if (Object.keys(rows).length) cats[category] = rows;
            }
            if (Object.keys(cats).length) periods.push(periodFromObject(label, cats));
        }
        if (!periods.length) throw new UpstreamError("Could not read the hours-of-operation page");
        return periods;
    });
}

/**
 * Any date takes the shortest period covering it, since break and finals
 * schedules sit inside the semester range. Today is no exception: the feed
 * lists every period, not just the semester, so reading only the first one
 * reported J2 open on Thanksgiving.
 */
export async function hoursForDate(mdy: string): Promise<HoursPeriod> {
    const [mm, dd, yyyy] = mdy.split("/");
    const iso = `${yyyy}-${mm}-${dd}`;

    const feed = await getFeedHours();
    const fromFeed = mostSpecific(feed, iso);
    if (fromFeed) return fromFeed;

    // The feed only carries the current term; the housing page goes further out.
    const all = await getAllHours().catch(() => [] as HoursPeriod[]);
    const covering = mostSpecific(all, iso);
    if (covering) return covering;

    const known = all.length ? all : feed;
    const latest = known
        .map((p) => p.end)
        .filter(Boolean)
        .sort((a, b) => a!.localeCompare(b!))
        .at(-1);
    throw new Error(
        `UT has not published dining hours for ${mdy}.` +
            (latest ? ` The schedule currently runs through ${latest}.` : ""),
    );
}

export type OpenStatus = {
    name: string;
    category: string;
    open: boolean;
    hours: string;
    closesIn?: number;
    opensIn?: number;
};

export async function statusAt(mdy: string, minutes: number): Promise<OpenStatus[]> {
    const period = await hoursForDate(mdy);
    const [mm, dd, yyyy] = mdy.split("/").map(Number);
    const idx = (new Date(Date.UTC(yyyy!, mm! - 1, dd!)).getUTCDay() + 6) % 7; // 0 = Monday
    return period.locations.map((loc) => {
        const ranges = loc.week[idx];
        const hours = ranges?.map((r) => r.label).join(", ") ?? "Closed";
        const active = ranges?.find((r) => minutes >= r.start && minutes < r.end);
        const next = ranges?.find((r) => r.start > minutes);
        return {
            name: loc.name,
            category: loc.category,
            open: Boolean(active),
            hours,
            closesIn: active ? active.end - minutes : undefined,
            opensIn: !active && next ? next.start - minutes : undefined,
        };
    });
}

export type DiningLocation = {
    name: string;
    category: string;
    slug?: string;
    url?: string;
    description?: string;
    address?: string;
    building?: string;
    payment?: string[];
    lat?: number;
    lon?: number;
};

const CATEGORY_PAGES = [
    ["Dining Halls", "dining-halls"],
    ["Restaurants", "restaurants"],
    ["Coffee Shops", "coffee-shops"],
    // UT's hours feed calls these Markets, and that is what dining_hours
    // prints, so take the feed's name for them here rather than publishing a
    // category that no location can ever be in.
    ["Markets", "convenience-stores"],
] as const;

/** Coordinates live inline in the FoodPro app shell. */
function getCoordinates(): Promise<Record<string, { lat: number; lon: number }>> {
    return cached("dining:coords", 86400, async () => {
        try {
            const html = await getText(`${FOODPRO}/`, 86400);
            const out: Record<string, { lat: number; lon: number }> = {};
            const block = html.match(/location_coordinates\s*=\s*\{([\s\S]*?)\n\s*\}/)?.[1] ?? "";
            for (const m of block.matchAll(
                /"([^"]+)"\s*:\s*\{\s*"lat"\s*:\s*(-?[\d.]+)\s*,\s*"lon"\s*:\s*(-?[\d.]+)/g,
            )) {
                out[norm(m[1]!)] = { lat: Number(m[2]), lon: Number(m[3]) };
            }
            return out;
        } catch {
            return {}; // coordinates are a nice-to-have
        }
    });
}

export function getLocations(): Promise<DiningLocation[]> {
    return cached("dining:locations", 86400, async () => {
        // The housing pages and the hours feed each carry locations the other
        // misses, so losing one should cost those rows, not the whole list.
        const [coords, period] = await Promise.all([
            getCoordinates(),
            getCurrentHours().catch((): HoursPeriod => ({
                label: "(hours unavailable)",
                locations: [],
            })),
        ]);
        const found = new Map<string, DiningLocation>();

        const pages = await Promise.all(
            CATEGORY_PAGES.map(async ([category, slug]) => {
                try {
                    return [
                        category,
                        await getText(`${HOUSING}/dining/dining-locations/${slug}`, 86400),
                    ] as const;
                } catch {
                    return [category, ""] as const;
                }
            }),
        );
        for (const [category, html] of pages) {
            for (const card of html.split("<article").slice(1)) {
                const link = card.match(
                    /<h3 class="ut-headline">\s*<a href="(\/dining\/dining-locations\/[^"]+)"[^>]*>\s*<span>([^<]*)<\/span>/,
                );
                if (!link) continue;
                const name = decode(link[2]!).trim();
                const blurb = card.match(
                    /field--name-field-uhd-dl-short-desc[\s\S]*?<div class="field__item[^"]*">([\s\S]*?)<\/div>/,
                )?.[1];
                // Cypress Bend Cafe and Littlefield Patio Cafe are on both the
                // Restaurants and the Coffee Shops page, and Restaurants is walked
                // first, which is also how the hours feed categorises them. A plain
                // set here let the second page relabel them and they stopped coming
                // back under Restaurants at all.
                if (found.has(norm(name))) continue;
                found.set(norm(name), {
                    name,
                    category,
                    slug: link[1]!,
                    url: `${HOUSING}${link[1]!}`,
                    description: blurb ? text(blurb) : undefined,
                });
            }
        }

        // the hours feed lists food trucks too, which have no detail page
        for (const loc of period.locations) {
            const key = norm(loc.name);
            let hit = found.get(key);
            // The two sources spell three places differently, so the roster
            // carried 29 rows for 26 real locations: "Prufrock's" beside
            // "Prufrock's Coffee", "Tower Burger" beside "Tower Burgers and
            // Fries", and La Fonda listed as both a Restaurant and a Food
            // Truck. One name being the start of the other is what separates a
            // second spelling of one place from two places in one building.
            if (!hit)
                for (const [known, entry] of found)
                    if (known.startsWith(key) || key.startsWith(known)) {
                        hit = entry;
                        break;
                    }
            // The feed is what dining_hours prints, so its spelling and its
            // category are what any follow-up call will be made with. The
            // housing site files Jester City Market under convenience-stores
            // while the feed calls it a Market, and keeping the housing value
            // meant asking for a category the other tool had just shown you
            // came back "no locations in that category". The housing row keeps
            // its slug, address and description.
            if (hit) {
                hit.name = loc.name;
                hit.category = loc.category || hit.category;
            } else found.set(key, { name: loc.name, category: loc.category });
        }

        for (const [key, loc] of found) {
            // Keyed by the housing name, but the row now carries the feed's,
            // and FoodPro keys its coordinates the same way the feed does.
            const c = coords[key] ?? coords[norm(loc.name)];
            if (c) {
                loc.lat = c.lat;
                loc.lon = c.lon;
            }
        }
        return [...found.values()].sort(
            (a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name),
        );
    });
}

export async function getLocationDetail(name: string): Promise<DiningLocation | null> {
    const locs = await getLocations();
    const q = norm(name);
    // A name given but unreadable is not the same as no name: norm() strips to
    // [a-z0-9], and an empty q makes every prefix test below true, so the first
    // row on the list came back as a confident answer complete with address.
    if (!q) return null;
    // The hours feed and the housing pages spell some places differently --
    // "Tower Burger" against "Tower Burgers and Fries", "Prufrock's" against
    // "Prufrock's Coffee" -- so both end up in the list, and only the housing
    // one has a detail page behind it. The feed spelling is the one dining_hours
    // prints, so looking a place up by the name you were just shown used to
    // return coordinates and nothing else. Among equally good name matches,
    // prefer the row that can actually be filled in.
    const byName = [
        locs.filter((l) => norm(l.name) === q),
        // The floor applies to the prefix tier too: "o" is the start of One Two
        // Three Sushi and "ch" of Chick-fil-A, which is an accident, not a name.
        q.length >= 3
            ? locs.filter((l) => norm(l.name).startsWith(q) || q.startsWith(norm(l.name)))
            : [],
        // A substring that short matches by accident: "a" was answering with a
        // description, an address and a source link for Jester Java.
        q.length >= 3 ? locs.filter((l) => norm(l.name).includes(q)) : [],
    ];
    // A row with a slug can be filled in; one without is all there will ever be.
    // Exact-but-empty used to win outright, which is the case that matters here:
    // "Tower Burger" is exactly the feed's spelling and exactly the stub.
    const loc = byName.flatMap((list) => list.filter((l) => l.slug))[0] ?? byName.flat()[0];
    if (!loc) return null;
    if (!loc.slug) return loc;

    return cached(`dining:location:${loc.slug}`, 86400, async () => {
        const html = await getText(`${HOUSING}${loc.slug}`, 86400);
        // description sits behind a visually-hidden "Description" label
        const descBlock =
            html.match(
                />Description<\/div>([\s\S]*?)(?:<div class="visually-hidden">|<\/article>)/,
            )?.[1] ?? "";
        const description = [...descBlock.matchAll(/<p>([\s\S]*?)<\/p>/g)]
            .map((p) => text(p[1]!))
            .filter(Boolean)
            .join("\n\n");
        const addr = html.match(/<p class="address"[^>]*>([\s\S]*?)<\/p>/)?.[1];
        const payment = [
            ...html.matchAll(/vocabulary-uhd-dining-location-payment[\s\S]*?alt="([^"]*)"/g),
        ]
            .map((m) =>
                decode(m[1]!)
                    .replace(/\s*payment icon\s*$/i, "")
                    .trim(),
            )
            .filter(Boolean);
        return {
            ...loc,
            description: description || loc.description,
            address: addr ? text(addr, " ").replace(/\s*,\s*/g, ", ") : undefined,
            building:
                text(
                    html.match(
                        /field--name-field-uhd-building-link[\s\S]*?<a href="[^"]*"[^>]*>([^<]*)<\/a>/,
                    )?.[1] ?? "",
                ) || undefined,
            payment: payment.length ? [...new Set(payment)] : undefined,
        };
    });
}

/** Per serving. Grams unless the name says mg or mcg. */
/** The numeric fields only, so a label row can be assigned by key. */
type MacroAmounts = {
    calories?: number;
    protein?: number;
    carbs?: number;
    fat?: number;
    saturatedFat?: number;
    transFat?: number;
    fiber?: number;
    sugar?: number;
    addedSugar?: number;
    sodium?: number;
    cholesterol?: number;
    calcium?: number;
    iron?: number;
    potassium?: number;
    vitaminD?: number;
};

export type Macros = MacroAmounts & {
    /** As the label prints it, e.g. "3 oz". The feed's serv is only a multiplier. */
    servingSize?: string;
};

/** Same figures, spelled the way label.aspx spells them. */
const LABEL_KEYS: Record<string, keyof MacroAmounts> = {
    calories: "calories",
    protein: "protein",
    carbohydrates: "carbs",
    fat: "fat",
    "saturated fat": "saturatedFat",
    "trans fatty acid": "transFat",
    "dietary fiber": "fiber",
    "total sugars": "sugar",
    "added sugar": "addedSugar",
    sodium: "sodium",
    cholesterol: "cholesterol",
    calcium: "calcium",
    iron: "iron",
    potassium: "potassium",
    "vitamin d - mcg": "vitaminD",
};

const DIET_TAGS = new Set(["VGN", "VGT", "HAL"]);

/**
 * The same hall is spelled differently per source: the hours feed says "Jester
 * City Limits", the menu feed says "JCL Dining". These are the extra spellings
 * to accept, on top of plain substring matching.
 */
const LOCATION_ALIASES: Record<string, string[]> = {
    jcl: ["jcldining", "jestercitylimits"],
    jcldining: ["jestercitylimits"],
    jestercitylimits: ["jcldining"],
    jester: ["jestercitylimits", "jcldining"],
    j2: ["j2dining"],
    kins: ["kinsdining"],
    kinsolving: ["kinsdining"],
};

/** Does `candidate` name the location the caller asked for? */
/** The menu is always about one hall, so there is no "all of them" here. */
export const requireLocation = (query: string): string => {
    if (!query.trim())
        throw new Error(
            "Which dining hall? get_dining_menu covers one at a time: J2, Kins or JCL.",
        );
    return query;
};

/**
 * Does `candidate` answer to `query`? norm() strips to [a-z0-9], so a query the
 * caller did give can come out empty, and "" is the sentinel for no filter at
 * all -- which quietly widens the question instead of answering it. "早餐" as a
 * meal used to return the whole day: 217 items for a one-meal question.
 */
export const matchesNormalised = (candidate: string, query: string | undefined): boolean => {
    if (query === undefined || !query.trim()) return true; // no filter asked for
    const q = norm(query);
    return q ? norm(candidate).includes(q) : false;
};

export const matchesLocation = (candidate: string, query: string): boolean => {
    const c = norm(candidate);
    const q = norm(query);
    // No query at all is no filter. A query that survives normalisation as
    // nothing is a query that matched nothing, not a missing one.
    if (!q) return !query.trim();
    if (c === q || c.includes(q)) return true;
    return (LOCATION_ALIASES[q] ?? []).some((alias) => c === alias || c.includes(alias));
};

export const dietTags = (legends: string[]): string[] =>
    legends.filter((l) => DIET_TAGS.has(l)).map((l) => DIET_LEGENDS[l] ?? l);

/** How each legend code appears on the label's CONTAINS line. */
const LABEL_ALLERGEN_WORDS: Record<string, RegExp> = {
    BF: /\bbeef\b/i,
    EG: /\begg/i,
    FSH: /\bfish\b/i,
    MLK: /\bmilk\b/i,
    PNTS: /\bpeanut/i,
    PRK: /\bpork\b/i,
    SFSH: /\bshellfish\b|\bcrustacean/i,
    SOY: /\bsoy/i,
    NTS: /\btree nut/i,
    WHT: /\bwheat\b/i,
    SS: /\bsesame\b/i,
};

/** Does this item's label name an allergen the caller is avoiding? */
/** VGN, VGT and HAL are diet tags; a label never names them. */
export const isAllergenCode = (code: string): boolean => code in LABEL_ALLERGEN_WORDS;

export const labelHasAllergen = (item: MenuItem, code: string): boolean => {
    const word = LABEL_ALLERGEN_WORDS[code];
    if (!word || !item.labelAllergens?.length) return false;
    return item.labelAllergens.some((a) => word.test(a));
};

/** "Tree Nuts, Wheat, Soybeans" -> ["Tree Nuts", "Wheat", "Soybeans"] */
export const splitAllergens = (contains: string): string[] =>
    contains
        .split(/\s*,\s*/)
        .map((a) => a.trim())
        .filter(Boolean);

/**
 * Neither source is a superset of the other. 6" Flour Tortilla is tagged SOY,WHT
 * but its label reads only "Wheat", while Chocolate Pistacio Cloud Cake carries
 * no tags and its label lists peanuts. Both get reported.
 */
/**
 * Things people avoid that are not allergens and are not tagged anywhere. The
 * feed carries an ingredient statement for 995 of 997 recipes and we parse past
 * it already, so these cost nothing to answer. Each is a phrase specific enough
 * to mean what it says: an open ingredient search is useless, because "oil"
 * matches 712 of 997 recipes, and of the 128 whose ingredients mention "soda", 80
 * are baking soda.
 *
 * This is a preference filter, not a safety one. Allergens stay on the label's
 * CONTAINS line, where a wrong answer matters more than a missed dish.
 */
export const AVOID_INGREDIENTS: Record<string, { label: string; test: RegExp }> = {
    "seed-oils": {
        label: "seed oils",
        test: /\bcanola\b|soybean oil|sunflower oil|vegetable oil|vegetable shortening|\bcorn oil\b|cottonseed|safflower oil|grapeseed/i,
    },
    hfcs: { label: "high fructose corn syrup", test: /high.fructose/i },
    "palm-oil": { label: "palm oil", test: /palm (?:fruit )?oil|palm kernel/i },
    gelatin: { label: "gelatin", test: /\bgelatin\b/i },
    msg: { label: "added MSG", test: /monosodium glutamate|\bMSG\b/i },
    "artificial-color": {
        label: "artificial colour",
        test: /\b(red|blue|yellow)\s*#?\s*\d|artificial color|fd&c/i,
    },
};

export const hasAvoided = (ingredients: string | undefined, key: string): boolean =>
    !!ingredients && (AVOID_INGREDIENTS[key]?.test.test(ingredients) ?? false);

const OUNCE_G = 28.3495;

/**
 * UT's label scales most recipes correctly per unit, but a few treat the base
 * figure as per-unit when it is already the whole portion, so a *3 triples a
 * full serving. Crispy Chopped Bacon comes back as 897 cal and 89.7 g of fat
 * for 3 oz, which is more fat than the food weighs. Roughly one multi-portion
 * recipe in twenty is like this. We cannot tell which figure UT meant, so the
 * number is passed through and flagged rather than quietly corrected.
 */
export const implausible = (m: Macros): string | undefined => {
    const grams = (() => {
        // Servings come as "3 oz", "1/2 oz" and "1 1/2 oz", and all three have to
        // read as themselves. An optional leading number anchored to nothing lets
        // "1 1/2 oz" re-anchor on the fraction and lose the whole part, which
        // under-reads the serving and fires the guard on a label that is fine.
        // UT also prints "4 ozL" on about ninety rows a week; that is ounces.
        const oz = m.servingSize?.match(
            /(?:(\d+)[\s-]+)?(?:(\d+)\s*\/\s*(\d+)|([\d.]+))\s*ozl?\b/i,
        );
        if (oz) {
            const [, whole, numerator, denominator, plain] = oz;
            const ounces =
                plain === undefined
                    ? Number(whole ?? 0) + Number(numerator) / Number(denominator)
                    : Number(plain);
            return ounces * OUNCE_G;
        }
        const g = m.servingSize?.match(/([\d.]+)\s*g\b/i);
        return g ? Number(g[1]) : undefined;
    })();
    // Fat alone cannot supply more energy than the label's own calorie figure.
    // This needs no serving weight, so it reaches the labels the weight rule
    // cannot see: seven references this week print a dessert at 140 calories
    // with 22 g of fat, which is 199 calories of fat. The margin leaves room
    // for the rounding UT prints at; at 1.15 it fires on those seven and on
    // nothing else across the 1039 labels that parse.
    if (
        m.fat !== undefined &&
        m.fat > 1 &&
        m.calories !== undefined &&
        m.fat * 9 > m.calories * 1.15
    )
        return "more fat than the calorie figure allows";
    // The panel's own protein, carbs and fat imply a calorie figure. When that
    // disagrees with the printed one by more than rounding can explain, one of
    // the two is wrong, and this needs no serving weight either. Parslied
    // Noodles prints 18 calories over 7.3 g protein, 40.8 g carbs and 4.5 g fat,
    // which is 233. Across the 1039 labels that parse it fires on eight, and on
    // the same eight at a 40% tolerance, so it is not sitting on a knife edge.
    if (
        m.protein !== undefined &&
        m.carbs !== undefined &&
        m.fat !== undefined &&
        m.calories !== undefined
    ) {
        const implied = 4 * m.protein + 4 * m.carbs + 9 * m.fat;
        const gap = Math.abs(implied - m.calories);
        if (gap > 50 && gap / Math.max(m.calories, 1) > 0.3)
            return `its own protein, carbs and fat come to ${Math.round(implied)} cal, not ${m.calories}`;
    }
    if (!grams || !Number.isFinite(grams) || grams <= 0) return undefined;
    if (m.fat !== undefined && m.fat > grams) return "more fat than the serving weighs";
    if (m.calories !== undefined && m.calories / grams > 9.5)
        return "more calories than pure fat of the same weight";
    return undefined;
};

export const mergedAllergens = (item: MenuItem): string[] => {
    const out = [...(item.labelAllergens ?? [])];
    for (const code of item.legends) {
        if (DIET_TAGS.has(code)) continue;
        // Match on the code's own word, not on the two strings looking alike. The
        // menu says "Sesame Seeds" where the label says "Sesame", and "Fish" is a
        // substring of "Crustacean Shellfish" without being the same allergen.
        const word = LABEL_ALLERGEN_WORDS[code];
        if (word && out.some((a) => word.test(a))) continue;
        const name = (DIET_LEGENDS[code] ?? code).replace(/^Contains /, "");
        if (!out.includes(name)) out.push(name);
    }
    return out;
};

/**
 * The menu tags for one recipe, for a caller that has a recipe number and no
 * menu row. menu_item_nutrition needs them: UT's label and UT's menu tags each
 * miss things the other catches, and 2 of this week's 1039 labels declare
 * nothing while the tags name an allergen -- Hot Hearty Oatmeal (Wheat), on J2
 * breakfast six days in seven, and Honey Chipotle Chicken Taco (Pork).
 */
export async function recipeLegends(number: string): Promise<string[]> {
    const feed = await getMenuFeed();
    return feed.recipes[number]?.legends ?? [];
}

/**
 * One code, in words. dietTags() and allergens() each keep only their own
 * family, so asking either to spell a code from the other gives an empty
 * string; this answers for any code and falls back to the code itself.
 */
export const spellCode = (code: string): string =>
    (DIET_LEGENDS[code] ?? code).replace(/^Contains /, "");

export const allergens = (legends: string[]): string[] =>
    legends
        .filter((l) => !DIET_TAGS.has(l))
        .map((l) => (DIET_LEGENDS[l] ?? l).replace(/^Contains /, ""));

export type MenuItem = {
    number: string;
    name: string;
    serving?: string;
    legends: string[];
    /** Keys from AVOID_INGREDIENTS found in the feed's ingredient text. */
    avoid: string[];
    /**
     * False when UT published no ingredient statement for the recipe, which
     * makes an empty `avoid` unknown rather than clear. Two of this week's 997
     * recipes are in that state.
     */
    ingredientsKnown?: boolean;
    /** Per serving, from the item's label. Missing if the label wouldn't parse. */
    nutrition?: Macros & { source: "label" };
    /** From the label's CONTAINS line. More complete than the menu tags. */
    labelAllergens?: string[];
    /** Whether the label was actually read. Without it the allergen list is menu tags only. */
    labelChecked?: boolean;
};
export type MenuSection = { section: string; items: MenuItem[] };
export type MenuMeal = { meal: string; sections: MenuSection[] };

/**
 * Name and tags only. The feed's `nutrients` array is not per serving: one array
 * per recipe, but a recipe is served at different portions in different halls.
 * 081906 reports 299 kcal at portionSize "3 oz" and is served at serv=3, while
 * its label for 081906*3 says 897. Use label.aspx for nutrition.
 */
type RecipeMeta = {
    name: string;
    legends: string[];
    avoid: string[];
    /** False when UT published no ingredient statement, so `avoid` means nothing. */
    ingredientsKnown: boolean;
};

type RawDays = Record<
    string,
    {
        locations: {
            locationNum: string;
            locationName: string;
            meals: {
                mealName: string;
                recipes: { number: string; name: string; serv: string }[];
            }[];
        }[];
    }
>;
type MenuFeed = {
    lastCached: string;
    dates: string[];
    days: RawDays;
    recipes: Record<string, RecipeMeta>;
};

/**
 * The feed is ~1.9 MB, mostly ingredient text. Parsing all of it measured ~8 ms,
 * most of the CPU budget, so slice out `days` and scan the rest for names/tags.
 */
function getMenuFeed(): Promise<MenuFeed> {
    return cached("dining:menu", 3600, async () => {
        const body = await getText(`${ENDPOINT}?menu=1`, 3600);

        // UT serves this compact; allow whitespace so a reformat doesn't drop every tag
        const key = (name: string) => new RegExp(`"${name}"\\s*:`);
        const daysAt = body.search(key("days"));
        if (daysAt < 0) throw new UpstreamError("Could not read the dining menu feed");
        let days: RawDays;
        try {
            const open = body.indexOf("{", daysAt);
            days = JSON.parse(body.slice(open, body.lastIndexOf("}"))) as RawDays;
        } catch {
            // the slice assumes `days` is the last top-level key
            throw new UpstreamError("The dining menu feed changed shape and could not be read");
        }
        if (!days || !Object.keys(days).length)
            throw new UpstreamError("The dining menu feed contained no days");

        // normally before `days`, but don't lose the tags if that ever flips
        const recipesAt = body.search(key("recipes_data"));
        const table =
            recipesAt >= 0
                ? recipesAt < daysAt
                    ? body.slice(recipesAt, daysAt)
                    : body.slice(recipesAt)
                : "";
        const recipes: Record<string, RecipeMeta> = {};
        const starts = [...table.matchAll(/"(\d+)"\s*:\s*\{\s*"number"\s*:/g)];
        for (const [i, m] of starts.entries()) {
            // name and tags come before the ingredient string
            const end = Math.min(starts[i + 1]?.index ?? table.length, m.index! + 6000);
            const win = table.slice(m.index, end);
            const name = win.match(/"name"\s*:\s*"((?:[^"\\]|\\.)*)"/)?.[1];
            if (!name) continue;
            const legends = win.match(/"legends"\s*:\s*\[([^\]]*)\]/)?.[1] ?? "";
            // Keep the flags, not the 538 KB of ingredient text: storing that would
            // triple the cached feed and it gets JSON-parsed on every cache read.
            const ingredients = win.match(/"ingredients"\s*:\s*"((?:[^"\\]|\\.)*)"/)?.[1];
            const avoid = ingredients
                ? Object.keys(AVOID_INGREDIENTS).filter((k) => hasAvoided(ingredients, k))
                : [];
            recipes[m[1]!] = {
                name: JSON.parse(`"${name}"`) as string,
                legends: [...legends.matchAll(/"([^"]+)"/g)].map((l) => l[1]!),
                avoid,
                // UT publishes an empty string, not a missing field, for the two
                // recipes it has no statement for, so presence is not the test.
                ingredientsKnown: !!ingredients,
            };
        }

        return {
            lastCached: body.match(/"last_cached"\s*:\s*"([^"]*)"/)?.[1] ?? "",
            dates: Object.keys(days),
            days,
            recipes,
        };
    });
}

export async function getMenuWindow(): Promise<{
    dates: string[];
    lastCached: string;
    locations: string[];
}> {
    const feed = await getMenuFeed();
    const locations = new Set<string>();
    for (const day of Object.values(feed.days))
        for (const l of day.locations) locations.add(l.locationName);
    return { dates: feed.dates, lastCached: feed.lastCached, locations: [...locations] };
}

export function macrosFromLabel(n: Nutrition): Macros {
    const out: Macros = {};
    for (const row of n.nutrients) {
        const key = LABEL_KEYS[row.name.toLowerCase()];
        if (!key) continue;
        const value = Number(row.amount.replace(/[^\d.]/g, ""));
        if (Number.isFinite(value)) out[key] = Math.round(value * 10) / 10;
    }
    // use the big printed number, so we match what a student reads off the label
    const printed = Number((n.calories ?? "").replace(/[^\d.]/g, ""));
    if (Number.isFinite(printed) && printed > 0) out.calories = printed;
    if (n.servingSize) out.servingSize = n.servingSize;
    return out;
}

/**
 * The free plan allows 50 subrequests, and cache reads and writes count too. A
 * cold call spends 3 on the menu feed, 2 on the label batch and one fetch per
 * label, so this leaves a few spare rather than sitting on the limit.
 */
export const LABEL_BUDGET = 36;

export async function withNutrition(
    items: MenuItem[],
): Promise<{ covered: number; total: number }> {
    const byRef = new Map<string, MenuItem[]>();
    for (const item of items) {
        const ref = `${item.number}*${item.serving ?? "1"}`;
        byRef.set(ref, [...(byRef.get(ref) ?? []), item]);
    }

    const refs = [...byRef.keys()];
    // Taking the first 36 took them in feed order, which is meal order then
    // station order, so a whole-hall call read every garnish station and no
    // entree station: "the highest-protein thing at J2 dinner" came back as
    // Diced Chicken Breast at 11.4g off the salad bar, when Halal Grilled
    // Chicken at 22.4g was on the same menu unread. An even stride spends the
    // same budget across every meal and station instead.
    // Stride first so every part of the menu is represented, then fill the rest
    // of the budget with what the stride skipped: `ceil` leaves the spread
    // short of the budget whenever the count is not a clean multiple, and an
    // unspent label is coverage given away for nothing.
    const step = Math.max(1, Math.ceil(refs.length / LABEL_BUDGET));
    const slice = [
        ...refs.filter((_, i) => i % step === 0),
        ...refs.filter((_, i) => i % step !== 0),
    ].slice(0, LABEL_BUDGET);

    // Cloudflare counts cache.match and cache.put against the same per-request
    // budget as fetch, so a label each going through the cache cost three
    // subrequests apiece -- 123 for an unfiltered menu, over the free plan's 50,
    // and 41 even when every label was already cached. The whole set shares one
    // entry instead, which puts a cold call at 41 and a warm one at 2.
    const labels = await cached(
        `dining:labels:${slice.join(",")}`,
        86400,
        async () => {
            const out: Record<string, Nutrition | null> = {};
            await Promise.all(
                slice.map(async (ref) => {
                    const [number, serving] = ref.split("*");
                    try {
                        out[ref] = await fetchLabel(number!, serving);
                    } catch {
                        out[ref] = null;
                    }
                }),
            );
            return out;
        },
        // A label that failed is stored as null, and pinning that for a day would
        // blank the item colo-wide off one blip. Keep a partial set for minutes.
        (bundle) => (Object.values(bundle).some((v) => v === null) ? 300 : 86400),
    );

    let covered = 0;
    await Promise.all(
        slice.map(async (ref) => {
            try {
                const label = labels[ref];
                if (!label) return;
                const macros = macrosFromLabel(label);
                if (!Object.keys(macros).length) return;
                covered++;
                for (const item of byRef.get(ref)!) {
                    item.nutrition = { ...macros, source: "label" };
                    // The label's CONTAINS line is the authoritative allergen
                    // list. Menu tags miss some: 450257 is tagged vegan with
                    // wheat and soy, but its label also says tree nuts.
                    item.labelChecked = true;
                    item.labelAllergens = splitAllergens(label.allergens ?? "");
                }
            } catch {}
        }),
    );
    return { covered, total: refs.length };
}

export async function getMenu(locationName: string, mdy: string, mealFilter?: string) {
    const feed = await getMenuFeed();
    const day = feed.days[mdy];
    if (!day) {
        throw new Error(
            `No menu published for ${mdy}. Menus cover ${feed.dates[0]} to ${feed.dates[feed.dates.length - 1]}.`,
        );
    }
    const loc =
        day.locations.find((l) => norm(l.locationName) === norm(locationName)) ??
        day.locations.find((l) => matchesLocation(l.locationName, locationName));
    if (!loc) {
        throw new Error(
            `"${locationName}" has no published menu. Menus exist for: ${day.locations.map((l) => l.locationName).join(", ")}.`,
        );
    }

    const meals: MenuMeal[] = [];
    for (const meal of loc.meals) {
        if (!matchesNormalised(meal.mealName, mealFilter)) continue;
        const sections: MenuSection[] = [];
        let current: MenuSection = { section: "", items: [] };
        for (const r of meal.recipes) {
            // Rows with no recipe number are section headers: "-- Garden Bar --".
            if (!r.number) {
                if (current.items.length) sections.push(current);
                current = { section: r.name.replace(/^-+\s*|\s*-+$/g, "").trim(), items: [] };
                continue;
            }
            const meta = feed.recipes[r.number];
            const serving = r.serv || undefined;
            current.items.push({
                number: r.number,
                name: meta?.name ?? r.name,
                serving,
                legends: meta?.legends ?? [],
                avoid: meta?.avoid ?? [],
                ingredientsKnown: meta?.ingredientsKnown ?? false,
            });
        }
        if (current.items.length) sections.push(current);
        meals.push({ meal: meal.mealName, sections });
    }
    return { location: loc.locationName, date: mdy, lastCached: feed.lastCached, meals };
}

export type ItemHit = {
    date: string;
    isToday: boolean;
    /** 1 = a whole word in the name or station, 2 = a loose substring. */
    tier: 1 | 2;
    location: string;
    meal: string;
    section: string;
    item: MenuItem;
};

/**
 * Tier 1 is a whole word in the item's name or its station, which is what
 * someone typing "dessert" or "tacos" means. Nothing on the menu is named
 * "dessert" but 137 items sit under a Desserts station, and a plural never
 * matched its singular. Tier 2 keeps the old substring behaviour so nothing
 * that used to be found is lost, but it is reported as the loose match it is:
 * "ice" is inside Sliced, Diced and Rice.
 */
const stem = (w: string) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w);
const tokens = (s: string) =>
    s
        .toLowerCase()
        .split(/[^a-z0-9]+/i)
        .filter(Boolean)
        .map(stem);

export const matchTier = (words: string[], name: string, section: string): 1 | 2 | 0 => {
    if (!words.length) return 1; // no query: browsing by diet or location
    const whole = new Set([...tokens(name), ...tokens(section)]);
    if (words.every((w) => whole.has(stem(w)))) return 1;
    const lower = name.toLowerCase();
    return words.every((w) => lower.includes(w)) ? 2 : 0;
};

export async function searchMenuItems(
    query: string,
    opts: {
        date?: string;
        location?: string;
        diet?: string[];
        exclude?: string[];
        contains?: string[];
    } = {},
) {
    const feed = await getMenuFeed();
    // Tokenise the query exactly as the names are. Splitting it on whitespace
    // alone left the punctuation attached, so "mac & cheese" could not match
    // Homemade Mac and Cheese at either tier and came back as a confident
    // "nothing on the published menu". 65 of this week's 688 names carry an
    // apostrophe, ampersand, comma or slash.
    const words = tokens(query);
    if (query.trim() && !words.length) return { lastCached: feed.lastCached, hits: [] };
    const hits: ItemHit[] = [];
    const today = austinNow().mdy;

    // The feed runs Monday to Sunday, so by Wednesday the first rows are days
    // already eaten. Anything capped off the end was the part being asked about.
    const iso = (mdy: string) => {
        const [m, d, y] = mdy.split("/");
        return `${y}-${m}-${d}`;
    };
    const days = Object.entries(feed.days).sort(([a], [b]) => {
        const rank = (d: string) => (d === today ? 0 : iso(d) > iso(today) ? 1 : 2);
        return rank(a) - rank(b) || iso(a).localeCompare(iso(b));
    });

    for (const [date, day] of days) {
        if (opts.date && date !== opts.date) continue;
        // Days already eaten are no answer to "where can I get this". An
        // explicit date is a deliberate question about that day, so it stands.
        if (!opts.date && iso(date) < iso(today)) continue;
        for (const loc of day.locations) {
            if (opts.location && !matchesLocation(loc.locationName, opts.location)) continue;
            for (const meal of loc.meals) {
                let section = "";
                for (const r of meal.recipes) {
                    if (!r.number) {
                        section = r.name.replace(/^-+\s*|\s*-+$/g, "").trim();
                        continue;
                    }
                    const meta = feed.recipes[r.number];
                    const name = meta?.name ?? r.name;
                    const tier = matchTier(words, name, section);
                    if (!tier) continue;
                    const legends = meta?.legends ?? [];
                    if (opts.diet?.length && !opts.diet.every((d) => legends.includes(d))) continue;
                    // Menu tags only. No label is read on this path, and the
                    // tags under-report what a label declares, so the reply
                    // says as much: a filter that looks like a safety promise
                    // and is not is worse than no filter at all.
                    if (opts.exclude?.length && opts.exclude.some((t) => legends.includes(t)))
                        continue;
                    // `avoid` is the AVOID_INGREDIENTS keys already matched
                    // against the feed's ingredient statement. An item with no
                    // statement has an empty list, so it cannot be claimed to
                    // contain anything.
                    if (
                        opts.contains?.length &&
                        !opts.contains.every((k) => (meta?.avoid ?? []).includes(k))
                    )
                        continue;
                    const serving = r.serv || undefined;
                    hits.push({
                        date,
                        isToday: date === today,
                        tier,
                        location: loc.locationName,
                        meal: meal.mealName,
                        section,
                        item: {
                            number: r.number,
                            name,
                            serving,
                            legends,
                            avoid: meta?.avoid ?? [],
                        },
                    });
                }
            }
        }
    }
    return { lastCached: feed.lastCached, hits };
}

export type Nutrition = {
    name: string;
    servingSize?: string;
    calories?: string;
    nutrients: { name: string; amount: string; dv?: string }[];
    ingredients?: string;
    allergens?: string;
};

async function fetchLabel(recipeNumber: string, serving?: string): Promise<Nutrition> {
    const port = `${recipeNumber}*${serving ?? "1"}`;
    const html = await getText(
        `${FOODPRO}/label.aspx?RecNumAndPort=${encodeURIComponent(port)}`,
        86400,
    );
    const pick = (cls: string) => {
        const out = [
            ...html.matchAll(new RegExp(`class="${cls}"[^>]*>([\\s\\S]*?)</(?:span|div|td)>`, "g")),
        ].map((m) => text(m[1]!));
        return out.filter(Boolean);
    };

    // Every figure sits in a .nutfactstopnutrient span, alternating between
    // "Name 5.4g" and the matching "7%" daily value. The page prints the FDA
    // panel and then a fuller detail table, so each nutrient appears twice
    // under slightly different names; the later, richer row wins.
    const ALIAS: Record<string, string> = {
        "total fat": "fat",
        "total carbohydrate": "carbohydrates",
        carbohydrate: "carbohydrates",
        "trans fat": "trans fatty acid",
        "added sugars": "added sugar",
    };
    const nutrients: { name: string; amount: string; dv?: string }[] = [];
    const seen = new Map<string, number>();
    let last = -1;
    for (const raw of pick("nutfactstopnutrient")) {
        const value = raw.match(/^(.*?[A-Za-z.])\s*([\d.]+\s*(?:kcal|g|mg|mcg))$/i);
        if (value) {
            const name = value[1]!.replace(/\.$/, "").trim();
            const amount = value[2]!.replace(/\s+/g, "");
            const key = ALIAS[name.toLowerCase()] ?? name.toLowerCase();
            const at = seen.get(key);
            if (at === undefined) {
                seen.set(key, nutrients.push({ name, amount }) - 1);
                last = nutrients.length - 1;
            } else {
                nutrients[at] = { name, amount, dv: nutrients[at]!.dv };
                last = at;
            }
            continue;
        }
        const dv = raw.match(/^([\d.]+%)$/);
        if (dv && last >= 0) nutrients[last]!.dv = dv[1];
    }

    if (!nutrients.length) {
        throw new UpstreamError(`No nutrition label could be read for item ${recipeNumber}`);
    }
    return {
        name: pick("labelrecipe")[0] ?? recipeNumber,
        servingSize: pick("nutfactsservsize").find((s) => !/^serving size$/i.test(s)),
        calories: pick("nutfactscaloriesval")[0],
        nutrients,
        ingredients: pick("labelingredientsvalue")[0],
        allergens: pick("labelallergensvalue")[0],
    };
}

/** One item's full label. ~19 KB, far cheaper than re-reading the whole feed. */
export function getNutrition(recipeNumber: string, serving?: string): Promise<Nutrition> {
    return cached(`dining:label:${recipeNumber}*${serving ?? "1"}`, 86400, () =>
        fetchLabel(recipeNumber, serving),
    );
}
