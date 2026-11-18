// Turns the building references students write ("GSB 2.126", "the SAC",
// "Gearing 114") into coordinates. Adapted from Longhorn-Loop's
// server/src/lib/utBuildings.ts. buildings.json is regenerated from UT's
// Building Information pages and is the only place coordinates live.

import buildingData from "./buildings.json";

export type Precision = "marker" | "centroid" | "geocoded";

export interface UtBuilding {
    code: string;
    name: string;
    address: string;
    latitude: number;
    longitude: number;
    /** How the coordinate was obtained; "marker" is exact, "geocoded" is the loosest. */
    precision: Precision;
}

/** Guards the next regeneration of buildings.json: swapped lat/long lands in China. */
const CAMPUS_BOUNDS = { minLat: 29.5, maxLat: 31, minLng: -98.5, maxLng: -96.5 };

function isPlausible(b: UtBuilding): boolean {
    return (
        Number.isFinite(b.latitude) &&
        Number.isFinite(b.longitude) &&
        b.latitude >= CAMPUS_BOUNDS.minLat &&
        b.latitude <= CAMPUS_BOUNDS.maxLat &&
        b.longitude >= CAMPUS_BOUNDS.minLng &&
        b.longitude <= CAMPUS_BOUNDS.maxLng
    );
}

/**
 * Names students use that are not the official code. Kept out of the JSON,
 * which is regenerated and would lose anything hand-added. SAC is the one that
 * matters: the building is officially WCP and "SAC" is in none of UT's data.
 */
export const LOCATION_ALIASES: Record<string, string> = {
    SAC: "WCP",
    "STUDENT ACTIVITY CENTER": "WCP",
    // Retired codes. UT renamed these, so they are in no feed, while syllabi
    // and room signs still use them. Codes only: "College of Liberal Arts"
    // names a college in a dozen buildings and is also a Localist department.
    CLA: "RLP", // College of Liberal Arts Building, now Patton Hall
    BMC: "DMC", // Belo Center for New Media, now the Dealey Center
    "BELO CENTER": "DMC",
    "BELO CENTER FOR NEW MEDIA": "DMC",
    "UT TOWER": "MAI",
    TOWER: "MAI",
    "MAIN BUILDING": "MAI",
    "THE TOWER": "MAI",
    "GREGORY GYM": "GRE",
    "GREGORY GYMNASIUM": "GRE",
    "PERRY CASTANEDA LIBRARY": "PCL",
    "JESTER CENTER": "JES",
    // UNB is "UNION BUILDING" in UT's data and "Texas Union" everywhere else.
    "TEXAS UNION": "UNB",
    // The Benson is a collection inside Sid Richardson Hall, so it has no code
    // of its own and no listing ever writes SRH.
    "BENSON LATIN AMERICAN COLLECTION": "SRH",
    "BENSON COLLECTION": "SRH",
    // Dining hall names, so dining and events answers agree on a place. Both
    // Jester names go to JES rather than JCD; same complex, ~50 m apart.
    JESTER: "JES",
    J2: "JES",
    "JESTER SECOND": "JES",
    JCL: "JES",
    "JESTER CITY LIMITS": "JES",
    KINS: "KIN",
    KINSOLVING: "KIN",
    "KINSOLVING DINING": "KIN",

    // Venues inside a building, and names the feed writes differently from UT's
    // data. Row counts are from a 60-day pull, 2026-11-09.
    "TEXAS SWIMMING CENTER": "TSC", // 16 rows
    "CACTUS CAFE": "UNB", // 20 rows; inside the Texas Union
    // SEA is on the ambiguous-code list, so it only resolves when it leads the
    // string. "SEAY" is not "SEA", so neither path reached it.
    SEAY: "SEA", // 6 rows
    "SEAY LIBRARY": "SEA",
    "SHIRLEY BIRD PERRY BALLROOM": "UNB", // 2 rows; also in the Union
    "PERRY BALLROOM": "UNB",
    // On top of the Student Activity Center. "The Color Inside" is the
    // artwork's name; every listing writes Skyspace.
    "JAMES TURRELL SKYSPACE": "WCP",
    SKYSPACE: "WCP",
    // The lawn in front of the Tower. Nearest coordinate that is a place.
    "SOUTH MALL": "MAI",
    // TOWER alone is ambiguous and only resolves when it leads, which this
    // does not. The full formal name appears in the feed as written here.
    "UNIVERSITY OF TEXAS AT AUSTIN TOWER": "MAI",
    // The football stadium. UT's data writes the full formal name; the feed
    // writes "DKR-Texas Memorial Stadium", and nobody says either out loud.
    DKR: "STD",
    "DKR TEXAS MEMORIAL STADIUM": "STD",
    "ROYAL MEMORIAL STADIUM": "STD",
};

/**
 * Codes that are also English words: AND is Andrews Residence Hall, so
 * "Jester and Gregory Gym" resolved to Andrews. They count only when leading,
 * which is how a room reference reads and is not how a conjunction appears.
 */
const AMBIGUOUS_CODES = new Set(["AND", "ART", "BIO", "GAR", "PAR", "SEA", "WIN", "TOWER"]);

/** Not places. Reported as absent rather than unrecognised. */
const NON_PHYSICAL = [
    "ONLINE",
    "ZOOM",
    "TEAMS",
    "MICROSOFT TEAMS",
    "WEBEX",
    "GOOGLE MEET",
    "VIRTUAL",
    "TBA",
    "TBD",
    "OFF CAMPUS",
    "OFF-CAMPUS",
    "UNKNOWN",
    "N/A",
    "REMOTE",
    "LIVESTREAM",
    "LIVE STREAM",
];

const PRECISIONS: readonly Precision[] = ["marker", "centroid", "geocoded"];

/** `precision` widens to `string` out of JSON; an unknown value degrades to the loosest. */
/** Exported so the fallback is testable; the data file has no bad values today. */
export function toPrecision(value: string): Precision {
    return PRECISIONS.find((known) => known === value) ?? "geocoded";
}

const BY_CODE = new Map<string, UtBuilding>();
for (const entry of Object.values(buildingData.buildings)) {
    const precision = toPrecision(entry.precision);
    const building: UtBuilding = { ...entry, precision };
    if (isPlausible(building)) BY_CODE.set(building.code.toUpperCase(), building);
}

/** Every building, for callers that want to list or search rather than resolve. */
export const ALL_BUILDINGS: readonly UtBuilding[] = [...BY_CODE.values()].sort((a, b) =>
    a.code.localeCompare(b.code),
);

/**
 * Uppercase, punctuation to spaces, whitespace collapsed. Ampersands, periods
 * and apostrophes are deleted rather than spaced, because they sit inside
 * words: "AT&T" spaced gives "AT T" and the ATT token never appears.
 */
function normalize(value: string): string {
    return value
        .toUpperCase()
        .replace(/[&.'’]/g, "")
        .replace(/[^A-Z0-9]+/g, " ")
        .trim()
        .replace(/\s+/g, " ");
}

/** Name without a trailing BLDG/BUILDING, which listings drop. */
function nameKey(building: UtBuilding): string {
    return normalize(building.name).replace(/\s+(BLDG|BUILDING)$/, "");
}

/** Official names, longest first, so the more specific name wins. */
const BY_NAME: { key: string; building: UtBuilding }[] = [];
for (const building of BY_CODE.values()) {
    const key = nameKey(building);
    // A key of a few characters fires on anything containing it, so there is a
    // length floor. Deliberately permissive: "2400 NUECES" is indexed.
    if (key.length >= 9) BY_NAME.push({ key, building });
}
BY_NAME.sort((a, b) => b.key.length - a.key.length);

/**
 * Official names carry donors and listings do not: BEL is "L. THEO BELLMONT
 * HALL" in UT's data and "Bellmont Hall" everywhere else. So each name is also
 * indexed by its last two words, under three guards -- the last word is a
 * building type, the word before it is >= 5 chars, and it appears in no other
 * name. Without the third, "CONFERENCE CENTER" and "RESIDENCE HALL" match many.
 */
const BUILDING_TYPE_WORDS = new Set([
    "HALL",
    "CENTER",
    "LIBRARY",
    "COMPLEX",
    "AUDITORIUM",
    "GYMNASIUM",
    "MUSEUM",
    "LABORATORIES",
    "LABS",
    "THEATRE",
    "STADIUM",
    "PAVILION",
]);

const wordUse = new Map<string, number>();
for (const building of BY_CODE.values()) {
    for (const word of new Set(normalize(building.name).split(" "))) {
        wordUse.set(word, (wordUse.get(word) ?? 0) + 1);
    }
}

const SHORT_NAMES = new Map<string, UtBuilding | null>();
for (const building of BY_CODE.values()) {
    const words = nameKey(building).split(" ");
    if (words.length < 3) continue;
    const type = words[words.length - 1];
    const distinguishing = words[words.length - 2];
    if (!type || !distinguishing) continue;
    if (!BUILDING_TYPE_WORDS.has(type)) continue;
    if (distinguishing.length < 5) continue;
    if ((wordUse.get(distinguishing) ?? 0) !== 1) continue;
    const key = `${distinguishing} ${type}`;
    // null marks a collision, so a key two buildings claim is used by neither.
    SHORT_NAMES.set(key, SHORT_NAMES.has(key) ? null : building);
}

/**
 * "Gearing 114" -- a surname and a room number, with no building type, which
 * the short-name index cannot see. Each distinctive word is indexed on its own,
 * under three guards, because uniqueness alone is not safe: exactly one name
 * contains "CAMPUS" (East Campus Garage). The word must lead the string, must
 * not be generic, and the token after it must look like a room number.
 * Otherwise "North 1st Street" resolves to the North End Zone and
 * "Education 2.302" to EER, which is not UT's College of Education.
 */
const GENERIC_NAME_WORDS = new Set([
    "AUSTIN",
    "CAMPUS",
    "COLLEGE",
    "CENTRAL",
    "DINING",
    "EDUCATION",
    "ENERGY",
    "BIOLOGY",
    "LEARNING",
    "NORTH",
    "SOUTH",
    "EAST",
    "WEST",
    "STUDENT",
    "TRACK",
    "UNIVERSITY",
    "TEXAS",
]);

/**
 * "2.126", "114", "962". Not `^\d`: "1st" and "2 West" start with a digit and
 * are not rooms, and a year like "2026" passes a bare four-digit test.
 */
const ROOM_NUMBER = /^(?:\d{1,2}\.\d{1,4}[A-Z]?|\d{3,4}[A-Z]?)$/;
const YEAR_LIKE = /^(?:19|20)\d\d$/;

const isRoomNumber = (token: string): boolean => ROOM_NUMBER.test(token) && !YEAR_LIKE.test(token);

const SURNAME_TOKENS = new Map<string, UtBuilding | null>();
for (const building of BY_CODE.values()) {
    for (const word of new Set(normalize(building.name).split(" "))) {
        if (word.length < 5) continue;
        if (BUILDING_TYPE_WORDS.has(word) || word === "BLDG") continue;
        if (GENERIC_NAME_WORDS.has(word)) continue;
        if ((wordUse.get(word) ?? 0) !== 1) continue;
        SURNAME_TOKENS.set(word, SURNAME_TOKENS.has(word) ? null : building);
    }
}

/**
 * Split by shape. A multi-word alias is safe anywhere in a string; a single
 * word is not, so it goes through the token path where the ambiguity rule
 * applies -- TOWER matched inside "Floor 1 North Tower, EER Building".
 */
const ALIAS_EXACT = new Map<string, UtBuilding>();
const ALIAS_TOKENS = new Map<string, UtBuilding>();
const ALIAS_PHRASES: { key: string; building: UtBuilding }[] = [];
for (const [alias, code] of Object.entries(LOCATION_ALIASES)) {
    const building = BY_CODE.get(code.toUpperCase());
    if (!building) continue;
    const key = normalize(alias);
    ALIAS_EXACT.set(key, building);
    if (key.includes(" ")) ALIAS_PHRASES.push({ key, building });
    else ALIAS_TOKENS.set(key, building);
}
// Longest first, so "STUDENT ACTIVITY CENTER" wins over a shorter overlap.
ALIAS_PHRASES.sort((a, b) => b.key.length - a.key.length);

/** True for "Online", "Zoom", "TBA" and friends: absent, not unrecognised. */
const NON_PHYSICAL_NORMALIZED = NON_PHYSICAL.map(normalize);

export function isNonPhysicalLocation(location: string | null | undefined): boolean {
    if (!location || !location.trim()) return true;
    const normalized = normalize(location);
    // Terms are normalized too: normalize("N/A") is "N A" and never equals the
    // raw term, so "N/A" used to fall through to the suggestion path.
    return NON_PHYSICAL_NORMALIZED.some(
        (term) =>
            normalized === term ||
            normalized.startsWith(`${term} `) ||
            normalized.includes(` ${term} `),
    );
}

/** Which rule matched, so a caller can say how confident the answer is. */
export type MatchKind = "alias" | "code" | "name" | "short-name" | "room-reference";

export interface Resolved {
    building: UtBuilding;
    matchedBy: MatchKind;
}

/**
 * Resolve a location string to a UT building, or null.
 *
 * Order, most confident first:
 *   1. the whole string is an alias  ("Student Activity Center")
 *   2. the whole string is a code    ("GSB", "utc")
 *   3. an alias appears in the string
 *   4. a code appears as its own word ("GSB 2.126", "Welch Hall (WEL)")
 *   5. an official building name appears in the string
 *   6. a surname leads and a room number follows ("Gearing 114")
 *
 * Codes are matched as words, never substrings. Substring matching finds "ART"
 * inside "PARTY" and "BEN" inside "BENCH", and there are 204 codes to collide
 * with.
 */
export function resolveBuilding(location: string | null | undefined): Resolved | null {
    if (!location) return null;
    const normalized = normalize(location);
    if (!normalized) return null;

    // A code in parentheses is an explicit statement of the building, wherever
    // it sits in the string, so it beats the leading-word rule below. UT's own
    // feed writes "Visual Arts Center, Art Building (ART)", where ART is at
    // token 5 and is in AMBIGUOUS_CODES, so that resolved to nothing at all
    // while the shorter "Art Building (ART)" resolved fine.
    const parenthesised = /\(([A-Za-z]{2,4})\)/.exec(location);
    if (parenthesised?.[1]) {
        const building = BY_CODE.get(parenthesised[1].toUpperCase());
        if (building) return { building, matchedBy: "code" };
    }

    // Periods kept, so a room number's floor separator survives for the
    // room-reference rule at the end. Everything else works off `normalized`.
    const rawTokens = location
        .toUpperCase()
        .replace(/['’&]/g, "")
        .split(/[^A-Z0-9.]+/)
        .filter(Boolean);

    const exactAlias = ALIAS_EXACT.get(normalized);
    if (exactAlias) return { building: exactAlias, matchedBy: "alias" };

    const exactCode = BY_CODE.get(normalized);
    if (exactCode) return { building: exactCode, matchedBy: "code" };

    const tokens = normalized.split(" ");
    const tokenHit = (source: Map<string, UtBuilding>) => {
        for (let i = 0; i < tokens.length; i++) {
            const token = tokens[i];
            if (!token) continue;
            const building = source.get(token);
            if (!building) continue;
            // An ambiguous code only counts when it leads, which is how a room
            // reference reads. Anywhere else it is probably the English word.
            if (AMBIGUOUS_CODES.has(token) && i !== 0) continue;
            return building;
        }
        return null;
    };

    // A real building CODE anywhere in the string is an explicit statement of
    // the building, so it is tried before any nickname. Both the phrase table
    // and the one-word table used to run first, so "UT Tower, GDC 2.216"
    // answered the Tower and "College of Liberal Arts, Burdine Hall 108"
    // answered Patton Hall -- in each case ignoring the building the string
    // actually names.
    const byCode = tokenHit(BY_CODE);
    if (byCode) return { building: byCode, matchedBy: "code" };

    for (const { key, building } of ALIAS_PHRASES) {
        if (normalized.includes(key)) return { building, matchedBy: "alias" };
    }

    const byAlias = tokenHit(ALIAS_TOKENS);
    if (byAlias) return { building: byAlias, matchedBy: "alias" };

    for (const { key, building } of BY_NAME) {
        if (normalized.includes(key)) return { building, matchedBy: "name" };
    }

    for (const [key, building] of SHORT_NAMES) {
        if (building && normalized.includes(key)) return { building, matchedBy: "short-name" };
    }

    const first = tokens[0];
    // The RAW second token, because `normalize` strips periods: "2.014" arrives
    // here as "2014", which the year guard then threw away along with every
    // real floor-2 room numbered 0xx and every floor-1 room numbered 9xx.
    // "Gearing 2.014" stopped resolving. Testing the shape before the periods
    // are gone is what makes the dotted form reachable at all.
    const second = rawTokens[1];
    if (first && second && isRoomNumber(second)) {
        const building = SURNAME_TOKENS.get(first);
        if (building) return { building, matchedBy: "room-reference" };
    }

    return null;
}

/** The official UT page for a building. Derivable from the code, so not stored. */
export function buildingUrl(code: string): string {
    return (
        "https://utdirect.utexas.edu/apps/campus/buildings/information/nlogon/maps/utm/" +
        `${code.toLowerCase()}/`
    );
}

/**
 * Candidates for a query that did not resolve, so the answer can suggest
 * rather than only decline. Code prefix first, then name substring.
 */
export function suggestBuildings(query: string, limit = 5): UtBuilding[] {
    const normalized = normalize(query);
    if (!normalized) return [];
    const byCode = ALL_BUILDINGS.filter((b) => b.code.startsWith(normalized.split(" ")[0] ?? ""));
    const byName = ALL_BUILDINGS.filter(
        (b) => !byCode.includes(b) && nameKey(b).includes(normalized),
    );
    return [...byCode, ...byName].slice(0, limit);
}

const EARTH_RADIUS_M = 6_371_000;

/** Great-circle metres between two points. */
export function metresBetween(
    a: { latitude: number; longitude: number },
    b: { latitude: number; longitude: number },
): number {
    const toRad = (deg: number) => (deg * Math.PI) / 180;
    const dLat = toRad(b.latitude - a.latitude);
    const dLng = toRad(b.longitude - a.longitude);
    const lat1 = toRad(a.latitude);
    const lat2 = toRad(b.latitude);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Walking minutes, straight-line distance times a detour factor.
 *
 * 1.4 m/s is an ordinary walking pace. The 1.3 factor is because campus has
 * buildings in it: the straight line between two points is not a path, and
 * without it every estimate reads low. This is an estimate and the tool says
 * so -- it is not a routed path, and it does not know about the stairs behind
 * Jester or that Speedway is closed to cars.
 */
export function walkMinutes(metres: number): number {
    const PACE_M_PER_S = 1.4;
    const DETOUR = 1.3;
    return Math.max(1, Math.round((metres * DETOUR) / PACE_M_PER_S / 60));
}
