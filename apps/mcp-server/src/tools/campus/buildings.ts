// Turns the building references UT students actually write into coordinates.
//
// "GSB 2.126", "utc 2.102", "Welch 2.224", "the SAC". Nobody publishes a
// latitude next to a room number, so every other tool that knows where
// something is happening needs this one to say where that is.
//
// The resolver is adapted from Longhorn-Loop (server/src/lib/utBuildings.ts),
// where it was written against real scraped event locations. The ordering
// rules and the guards below are not arbitrary -- each one is a miss that
// happened there, and the comments say which. buildings.json is a trimmed copy
// of that repo's data file, regenerated from UT's own Building Information
// pages; it is the only place coordinates live.

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

/**
 * Campus bounds, as a last line of defence.
 *
 * Nothing in buildings.json fails this today, so removing it changes no
 * behaviour and no test can catch its removal. It stays for the next
 * regeneration of that file, which is the only way a bad coordinate gets in.
 *
 * Every entry in the file is inside these already. The check is here to catch
 * the failure that would otherwise ship silently: a latitude and longitude
 * swapped somewhere upstream. Reversed UT coordinates land at 30N 97E, in
 * western China, and an answer pointing at China is much harder to trace back
 * than a building that simply refuses to resolve.
 */
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
 * Names students use that are not the official code.
 *
 * Kept out of the JSON on purpose: that file is regenerated from UT's data and
 * anything hand-added would be lost. This table is the place for local
 * knowledge.
 *
 * SAC matters most. The building is officially WCP, William C. Powers Jr.
 * Student Activity Center, and "SAC" appears nowhere in UT's data while being
 * what every student calls it.
 */
export const LOCATION_ALIASES: Record<string, string> = {
    SAC: "WCP",
    "STUDENT ACTIVITY CENTER": "WCP",
    // Renamed buildings. UT retired the code, so it is in no feed and in no
    // official list, while syllabi, students and room signs still use it --
    // "CLA 1.106" is one of the most written room references on campus. Without
    // these, `resolve_ut_location` answered "No UT building matched CLA 1.106"
    // and offered no suggestion, for a building that is in the data under its
    // new code.
    // Only the retired CODES, not the spelled-out college name: "College of
    // Liberal Arts" names a college with departments in a dozen buildings, and
    // it is also what Localist puts in an event's `departments`. As a phrase
    // alias it beat the building the string actually named, so "College of
    // Liberal Arts, Burdine Hall 108" resolved to Patton Hall.
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
    // Dining, so a dining answer and an events answer agree on a place. J2,
    // JCL and Kins are rooms inside Jester and Kinsolving, not buildings, and
    // the dining tools are the only thing on this server that uses those names.
    //
    // Both Jester names go to JES (Jester Center) rather than JCD (Jester
    // Residence Hall). The two are the same complex and about 50m apart, so
    // either coordinate answers the question, but "Jester" means the centre to
    // everyone who is not reading a housing contract. JESTER on its own is
    // here because it resolves to nothing otherwise: the word appears in two
    // building names, so the uniqueness guards below correctly refuse it.
    JESTER: "JES",
    J2: "JES",
    "JESTER SECOND": "JES",
    JCL: "JES",
    "JESTER CITY LIMITS": "JES",
    KINS: "KIN",
    KINSOLVING: "KIN",
    "KINSOLVING DINING": "KIN",

    // Venues inside a building, and buildings the feed writes differently from
    // UT's data. Each is a string Localist publishes with no coordinate, with
    // the number of rows it covered in a 60-day pull measured 2026-11-09.
    //
    // The swimming centre is the one that mattered: TSC is in buildings.json
    // and still did not resolve, because athletics rows prefix the city and
    // UT's data writes CTR where the feed writes Center. A multi-word alias is
    // matched anywhere in the string, so the city prefix stops mattering.
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
 * Codes that are also ordinary English words.
 *
 * AND is Andrews Residence Hall. Without this list "Jester and Gregory Gym"
 * resolves to Andrews, confidently. ART, BIO, GAR, PAR, SEA and WIN have the
 * same problem in milder form.
 *
 * They still resolve, because "ART 1.102" has to work, but only when the code
 * leads the string, which is how a room reference is written and is not how a
 * conjunction appears.
 */
const AMBIGUOUS_CODES = new Set(["AND", "ART", "BIO", "GAR", "PAR", "SEA", "WIN", "TOWER"]);

/**
 * Locations that are not places. These resolve to null and are reported as
 * absent rather than unrecognised: an online event has no coordinate, and that
 * is the correct answer, not a gap in the data.
 */
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

/**
 * Read the data file without asserting its type.
 *
 * `precision` widens to `string` coming out of JSON, so a casual cast would let
 * an unexpected value through as a valid Precision and the "approximate"
 * warning would then be decided by a string nobody checked. An unknown value
 * degrades to "geocoded", the loosest, so a mistake in the data over-warns
 * rather than over-promising.
 */
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
 * Uppercase, punctuation to spaces, whitespace collapsed.
 *
 * Ampersands, periods and apostrophes are deleted rather than spaced, because
 * they sit inside words. "AT&T" spaced becomes "AT T" and the ATT token never
 * appears, which is how the AT&T Conference Center went unresolved against a
 * file that contains it. Deleting gives "ATT". Room numbers survive either
 * way: "GSB 2.126" becomes "GSB 2126" and the code is still its own token.
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

/**
 * Official names, longest first.
 *
 * Longest-first matters: "ART BUILDING AND MUSEUM" and "ART" would both match
 * a string containing the former, and the longer name is the more specific
 * claim. Sorting once here beats deciding per lookup.
 */
const BY_NAME: { key: string; building: UtBuilding }[] = [];
for (const building of BY_CODE.values()) {
    const key = nameKey(building);
    // Short names are too loose to match inside a sentence: a key of a few
    // characters fires on anything that happens to contain it. The floor is a
    // blunt instrument and deliberately permissive, so "2400 NUECES" (11
    // characters) is indexed and does resolve.
    if (key.length >= 9) BY_NAME.push({ key, building });
}
BY_NAME.sort((a, b) => b.key.length - a.key.length);

/**
 * Official names carry donors; students do not.
 *
 * BEL is "L. THEO BELLMONT HALL" in UT's data and "Bellmont Hall" in every
 * listing, so full-name matching misses it. Same for SRH, PCL, WEL and a dozen
 * more.
 *
 * So each name is also indexed by its last two words, the distinguishing word
 * plus the building type, under three guards, because a loose key here
 * mislabels a place rather than merely missing it:
 *
 *   the last word is a building type   HALL, CENTER, LIBRARY...
 *   the word before it is >= 5 chars   drops "AND MUSEUM", "CONF CENTER"
 *   and appears in no other name       drops "CONFERENCE CENTER", which sent a
 *                                      Pickle-campus event to Thompson, and
 *                                      "RESIDENCE HALL", which is 13 dorms
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
 * "Gearing 114" -- a surname and a room number, with no building type at all.
 *
 * The short-name index needs the type word, so "Bellmont Hall 962" resolves
 * and "Gearing 114" does not, and listings write both. Each distinctive word
 * is therefore indexed on its own.
 *
 * On its own that is dangerous, and word-uniqueness is not enough to make it
 * safe. Exactly one building name contains "CAMPUS" (East Campus Garage), so
 * uniqueness admits it, and "UT Austin campus" would then resolve to a car
 * park. COLLEGE, BIOLOGY, DINING and ENERGY are the same.
 *
 * The guard is positional: the word must lead the string and be followed
 * immediately by something starting with a digit. The digit test alone was not
 * enough, because addresses put numbers after words too, and "Patton Center
 * for Marine Science Education 855 E. Cotter Ave. Port Aransas" matched on
 * EDUCATION and put a marine lab 200 miles away inside EER.
 *
 * First position was NOT enough on its own, because plenty of real strings
 * start with a generic word followed by something that merely begins with a
 * digit. Measured against the live resolver, all four of these came back
 * `resolved: true` with full coordinates and no hedge:
 *
 *   "North 1st Street"           -> NEZ, North End Zone Building
 *   "Education 2.302"            -> EER  (UT's College of Education is SZB)
 *   "Austin 2026 Climate Summit" -> LAC, Lake Austin Centre
 *   "Campus 2 West"              -> ECG, East Campus Garage
 *
 * So two further guards: the generic words below are excluded outright, and the
 * token after the name has to look like a UT room number rather than merely
 * start with a digit.
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
 * A UT room number: "2.126", "114", "1.106", "4.244", "962".
 *
 * Deliberately not `^\d`: "1st" and "2 West" start with a digit and neither is
 * a room. UT numbers rooms either as floor.number or as three to four bare
 * digits.
 *
 * The year exclusion is the case the digit count alone misses: "2026" is four
 * digits, so "Austin 2026 Climate Summit" satisfied a bare length test and put
 * a conference inside Lake Austin Centre. No UT room is numbered in the 1900s
 * or 2000s, and event titles carry years constantly.
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
 * Aliases split by shape, because one word and several behave differently.
 *
 * A multi-word alias is safe to look for anywhere in a string: "Student
 * Activity Center" means one thing. A single word is not. TOWER matched inside
 * `"HQ" Room, Floor 1 North Tower, EER Building` and put an engineering
 * lecture at the top of the UT Tower, so single words go through the token
 * path where the ambiguity rule applies to them too.
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
    // The terms are normalized too. Comparing raw terms against a normalized
    // candidate made two of them unreachable: normalize("N/A") is "N A", which
    // never equals "N/A", so "N/A" fell through to the suggestion path and
    // offered five confident buildings for a string meaning "unknown".
    // "OFF-CAMPUS" was dead the same way, harmlessly, because "OFF CAMPUS" is
    // listed separately.
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
