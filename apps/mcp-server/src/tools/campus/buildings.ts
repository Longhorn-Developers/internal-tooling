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

/** Names students use that are not the official code. */
export const LOCATION_ALIASES: Record<string, string> = {
    SAC: "WCP",
    "STUDENT ACTIVITY CENTER": "WCP",
    // Retired codes UT renamed. In no feed, still on room signs and syllabi.
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
    // A collection inside Sid Richardson Hall; no listing writes SRH.
    "BENSON LATIN AMERICAN COLLECTION": "SRH",
    "BENSON COLLECTION": "SRH",
    // Dining hall names, so dining and events answers agree on a place.
    JESTER: "JES",
    J2: "JES",
    "JESTER SECOND": "JES",
    JCL: "JES",
    "JESTER CITY LIMITS": "JES",
    KINS: "KIN",
    KINSOLVING: "KIN",
    "KINSOLVING DINING": "KIN",

    // Venues inside a building, and names the feed writes differently from UT's data.
    "TEXAS SWIMMING CENTER": "TSC", // 16 rows
    "CACTUS CAFE": "UNB", // 20 rows; inside the Texas Union
    // SEA is on the ambiguous-code list, so it only resolves when it leads the string.
    SEAY: "SEA", // 6 rows
    "SEAY LIBRARY": "SEA",
    "SHIRLEY BIRD PERRY BALLROOM": "UNB", // 2 rows; also in the Union
    "PERRY BALLROOM": "UNB",
    // On top of the Student Activity Center.
    "JAMES TURRELL SKYSPACE": "WCP",
    SKYSPACE: "WCP",
    // The lawn in front of the Tower. Nearest coordinate that is a place.
    "SOUTH MALL": "MAI",
    // TOWER alone is ambiguous and only resolves when it leads, which this does not.
    "UNIVERSITY OF TEXAS AT AUSTIN TOWER": "MAI",
    // The football stadium.
    DKR: "STD",
    "DKR TEXAS MEMORIAL STADIUM": "STD",
    "ROYAL MEMORIAL STADIUM": "STD",
};

/** Also English words: AND is Andrews Hall, so "Jester and Gregory Gym" matched it. */
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

/** Uppercase, punctuation to spaces, whitespace collapsed. */
function normalize(value: string): string {
    return value
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
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
    // Short keys fire on anything containing them, so there is a length floor.
    if (key.length >= 9) BY_NAME.push({ key, building });
}
BY_NAME.sort((a, b) => b.key.length - a.key.length);

/** Also indexed by the last two words, since listings drop the donor name. */
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

/** Too generic to index alone: one building name contains CAMPUS (East Campus Garage). */
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

/** "2.126", "114", "962". Not `^\d`: "1st" is not a room, nor is a year. */
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

/** A multi-word alias is safe anywhere in a string; a single word is not. */
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
    // Normalized too: normalize("N/A") never equals the raw term.
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

/** Most confident rule first; the room-reference rule is last and loosest. */
export function resolveBuilding(location: string | null | undefined): Resolved | null {
    if (!location) return null;
    const normalized = normalize(location);
    if (!normalized) return null;

    // An explicit statement of the building, wherever it sits in the string.
    const parenthesised = /\(([A-Za-z]{2,4})\)/.exec(location);
    if (parenthesised?.[1]) {
        const building = BY_CODE.get(parenthesised[1].toUpperCase());
        if (building) return { building, matchedBy: "code" };
    }

    // Periods kept, so a room number's floor separator survives for the room-reference rule at the
    // end.
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
            // An ambiguous code only counts when it leads, which is how a room reference reads.
            if (AMBIGUOUS_CODES.has(token) && i !== 0) continue;
            return building;
        }
        return null;
    };

    // A real code beats any nickname: "UT Tower, GDC 2.216" is GDC.
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
    // The RAW token: `normalize` strips periods, so "2.014" arrives as "2014" and the year guard
    // threw away every real floor-2 room numbered 0xx.
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

/** Candidates for a query that did not resolve. */
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

/** Walking minutes: straight-line distance times a detour factor, at 1.4 m/s. */
export function walkMinutes(metres: number): number {
    const PACE_M_PER_S = 1.4;
    const DETOUR = 1.3;
    return Math.max(1, Math.round((metres * DETOUR) / PACE_M_PER_S / 60));
}
