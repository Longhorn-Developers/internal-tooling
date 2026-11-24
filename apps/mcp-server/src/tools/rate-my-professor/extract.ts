const UT_SCHOOL_ID = 1255;
const SAMPLES_PER_RATING = 2;

export const PROFESSOR_REVIEWS_QUERY = `query ($id: ID!) { node(id: $id) { ... on Teacher {
	ratingsDistribution { total r1 r2 r3 r4 r5 }
	courseCodes { courseName courseCount }
	ratings(first: 1000) { edges { node { class date qualityRating difficultyRating grade wouldTakeAgain comment ratingTags } } }
} } }`;

export type TeacherReviews = {
    ratingsDistribution: {
        total: number;
        r1: number;
        r2: number;
        r3: number;
        r4: number;
        r5: number;
    } | null;
    courseCodes: { courseName: string; courseCount: number }[];
    ratings: {
        edges: {
            node: {
                class: string;
                date: string;
                qualityRating: number;
                difficultyRating: number;
                grade: string | null;
                wouldTakeAgain: number | null;
                comment: string | null;
                ratingTags: string | null;
            };
        }[];
    };
};

export type ProfessorRating = {
    id: string;
    name: string;
    department: string | null;
    rating: number | null;
    difficulty: number | null;
    numRatings: number | null;
    wouldTakeAgainPercent: number | null;
    profileUrl: string;
};

type RelayNode = Record<string, unknown>;

export function professorRatings(html: string, query: string): ProfessorRating[] {
    const store = relayStore(html);
    if (!store) return [];
    const schools = new Set(
        Object.entries(store)
            .filter(([, node]) => node["__typename"] === "School" && node.legacyId === UT_SCHOOL_ID)
            .map(([id]) => id),
    );
    return Object.values(store).flatMap((node) => {
        if (node["__typename"] !== "Teacher") return [];
        if (typeof node.firstName !== "string" || typeof node.lastName !== "string") return [];
        if (typeof node.legacyId !== "number") return [];
        const school = schoolRef(node.school);
        if (schools.size > 0 && (!school || !schools.has(school))) return [];
        const name = `${node.firstName} ${node.lastName}`;
        if (!nameMatches(name, query)) return [];
        const takeAgain = numberOrNull(node.wouldTakeAgainPercent);
        return [
            {
                id: btoa(`Teacher-${node.legacyId}`),
                name,
                department: typeof node.department === "string" ? node.department : null,
                rating: numberOrNull(node.avgRating),
                difficulty: numberOrNull(node.avgDifficulty),
                numRatings: numberOrNull(node.numRatings),
                wouldTakeAgainPercent: takeAgain == null ? null : Math.round(takeAgain),
                profileUrl: `https://www.ratemyprofessors.com/professor/${node.legacyId}`,
            },
        ];
    });
}

export function professorReviews(teacher: TeacherReviews, course?: string | null) {
    const reviews = teacher.ratings.edges.flatMap(({ node }) => {
        const comment = node.comment?.trim();
        if (!comment) return [];
        return [
            {
                course: node.class,
                date: node.date.slice(0, 10),
                quality: Math.round(node.qualityRating),
                difficulty: node.difficultyRating,
                grade: node.grade || null,
                wouldTakeAgain: node.wouldTakeAgain == null ? null : Boolean(node.wouldTakeAgain),
                comment: comment.slice(0, 400),
                tags: tags(node.ratingTags),
            },
        ];
    });
    const focused = course ? reviews.filter((review) => courseMatches(review.course, course)) : [];
    const pool = focused.length > 0 ? focused : reviews;
    return {
        ratingDistribution: teacher.ratingsDistribution,
        courses: teacher.courseCodes
            .map((code) => ({ course: code.courseName, ratings: code.courseCount }))
            .sort((a, b) => b.ratings - a.ratings)
            .slice(0, 5),
        sampleRatings: [5, 4, 3, 2, 1].flatMap((quality) =>
            sample(
                pool.filter((review) => review.quality === quality),
                SAMPLES_PER_RATING,
            ),
        ),
    };
}

export function nameMatches(name: string, query: string): boolean {
    const wanted = query.toLowerCase().split(/\s+/).filter(Boolean);
    const words = name.toLowerCase().split(/\s+/).filter(Boolean);
    if (wanted.length === 0) return false;
    return wanted.every((part) => words.some((word) => word.startsWith(part)));
}

function relayStore(html: string): Record<string, RelayNode> | null {
    const marker = "window.__RELAY_STORE__ = ";
    const start = html.indexOf(marker);
    if (start < 0 || html[start + marker.length] !== "{") return null;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start + marker.length; index < html.length; index++) {
        const char = html[index];
        if (inString) {
            if (escaped) escaped = false;
            else if (char === "\\") escaped = true;
            else if (char === '"') inString = false;
            continue;
        }
        if (char === '"') inString = true;
        else if (char === "{") depth++;
        else if (char === "}") {
            depth--;
            if (depth === 0) return JSON.parse(html.slice(start + marker.length, index + 1));
        }
    }
    return null;
}

function schoolRef(value: unknown): string | null {
    if (!value || typeof value !== "object" || !("__ref" in value)) return null;
    const ref = value["__ref"];
    return typeof ref === "string" ? ref : null;
}

function numberOrNull(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function tags(value: unknown): string[] {
    return typeof value === "string"
        ? value
              .split("--")
              .map((tag) => tag.trim())
              .filter(Boolean)
        : [];
}

function courseMatches(value: string, requested: string): boolean {
    const left = value.toLowerCase().replace(/[^a-z0-9]/g, "");
    const right = requested.toLowerCase().replace(/[^a-z0-9]/g, "");
    return Boolean(
        left && right && (left === right || left.endsWith(right) || right.endsWith(left)),
    );
}

function sample<T>(items: T[], count: number): T[] {
    const pool = [...items];
    return Array.from({ length: Math.min(count, pool.length) }, () =>
        pool.splice(Math.floor(Math.random() * pool.length), 1),
    ).flat();
}
