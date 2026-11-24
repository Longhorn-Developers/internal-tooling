const COURSE_ORIGIN = "https://utdirect.utexas.edu";
const UT_SCHOOL_ID = 1255;

export type CourseSection = {
    semester: string;
    course: string;
    unique: string;
    title: string;
    instructors: string[];
    syllabusUrl: string | null;
    surveyUrl: string | null;
};

export type ProfessorRating = {
    name: string;
    department: string | null;
    rating: number | null;
    difficulty: number | null;
    numRatings: number | null;
    wouldTakeAgainPercent: number | null;
    profileUrl: string;
};

type RelayNode = Record<string, unknown>;

const GRADE_ORDER = ["A", "A-", "B+", "B", "B-", "C+", "C", "C-", "D+", "D", "D-", "F", "Other"];

export type GradeDistribution = {
    course: string;
    title: string;
    instructor: string;
    sectionCount: number;
    from: string | null;
    to: string | null;
    total: number;
    grades: { letter: string; count: number; percent: number }[];
};

export function gradeDistribution(
    csvs: string[],
    sections: { unique: string; semester: string }[],
    instructor: string,
): GradeDistribution | null {
    const wanted = new Set(
        sections.flatMap((section) => {
            const key = termKey(section.semester);
            return key ? [`${key}|${section.unique.trim()}`] : [];
        }),
    );
    if (wanted.size === 0) return null;

    const counts = new Map<string, number>();
    const matched = new Set<string>();
    const semesters = new Set<string>();
    let course = "";
    let title = "";

    for (const csv of csvs) {
        const rows = parseCsv(csv);
        const headerRow = rows[0];
        if (!headerRow || rows.length < 2) continue;
        const header = headerRow.map((cell) => cell.trim());
        const column = (name: string) => header.indexOf(name);
        const letterColumn = column("Letter Grade");
        const countColumn = column("Count of letter grade");
        const sectionColumn = column("Section Number");
        const semesterColumn = column("Semester");
        if (letterColumn < 0 || countColumn < 0 || sectionColumn < 0 || semesterColumn < 0)
            continue;

        for (const row of rows.slice(1)) {
            const semester = row[semesterColumn]?.trim() ?? "";
            const unique = row[sectionColumn]?.trim() ?? "";
            const key = termKey(semester);
            if (!key || !wanted.has(`${key}|${unique}`)) continue;
            const letter = row[letterColumn]?.trim();
            const count = Number(row[countColumn]?.replace(/,/g, ""));
            if (!letter || !Number.isFinite(count)) continue;
            counts.set(letter, (counts.get(letter) ?? 0) + count);
            matched.add(`${key}|${unique}`);
            semesters.add(semester);
            if (!course) {
                const prefix = row[column("Course Prefix")]?.trim() ?? "";
                const number = row[column("Course Number")]?.trim() ?? "";
                course = [prefix, number].filter(Boolean).join(" ");
                title = row[column("Course Title")]?.trim() ?? "";
            }
        }
    }

    const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
    if (total === 0) return null;
    const ordered = [...semesters].sort(
        (left, right) => semesterOrder(left) - semesterOrder(right),
    );
    return {
        course,
        title,
        instructor,
        sectionCount: matched.size,
        from: ordered[0] ?? null,
        to: ordered[ordered.length - 1] ?? null,
        total,
        grades: [...counts.entries()]
            .sort((left, right) => rank(left[0]) - rank(right[0]))
            .map(([letter, count]) => ({
                letter,
                count,
                percent: Math.round((count / total) * 1000) / 10,
            })),
    };
}

function termKey(semester: string): string | null {
    const year = semester.match(/\b(20\d{2})\b/)?.[1];
    const season = semester.match(/\b(fall|spring|summer)\b/i)?.[1]?.toLowerCase();
    if (!year || !season) return null;
    return `${season}-${year}`;
}

function semesterOrder(semester: string): number {
    const year = Number(semester.match(/\b(20\d{2})\b/)?.[1] ?? 0);
    const season = semester.match(/\b(spring|summer|fall)\b/i)?.[1]?.toLowerCase();
    const order = season === "spring" ? 0 : season === "summer" ? 1 : 2;
    return year * 10 + order;
}

function rank(letter: string): number {
    const index = GRADE_ORDER.indexOf(letter);
    return index === -1 ? GRADE_ORDER.length : index;
}

function parseCsv(csv: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let cell = "";
    let quoted = false;
    for (let index = 0; index < csv.length; index++) {
        const char = csv[index];
        if (quoted) {
            if (char === '"' && csv[index + 1] === '"') {
                cell += '"';
                index++;
            } else if (char === '"') quoted = false;
            else cell += char;
            continue;
        }
        if (char === '"') quoted = true;
        else if (char === ",") {
            row.push(cell);
            cell = "";
        } else if (char === "\n") {
            row.push(cell);
            rows.push(row);
            row = [];
            cell = "";
        } else if (char !== "\r") cell += char;
    }
    if (cell || row.length > 0) {
        row.push(cell);
        rows.push(row);
    }
    return rows.filter((record) => record.some((value) => value.trim()));
}

export function sectionsForQuery(
    sections: CourseSection[],
    unique: string,
    name: string,
): CourseSection[] {
    const wantedUnique = unique.trim();
    const exact = sections.filter((section) => section.unique === wantedUnique);
    if (exact.length > 0) return exact;

    const last = name.trim().split(/\s+/).pop()?.toLowerCase();
    if (!last) return [];
    return sections.filter((section) =>
        section.instructors.some((instructor) =>
            instructor.toLowerCase().split(/\s+/).includes(last),
        ),
    );
}

export function courseResults(html: string): { totalFound: number; sections: CourseSection[] } {
    const count = html.match(/<strong>\s*(\d+)\s+courses found/i);
    const totalFound = count ? Number(count[1]) : /no courses found/i.test(html) ? 0 : 0;
    const body = html.match(/<table[^>]*id="results_table"[\s\S]*?<tbody>([\s\S]*?)<\/tbody>/i);
    const tableBody = body?.[1];
    if (!tableBody) return { totalFound, sections: [] };

    const sections = [...tableBody.matchAll(/<tr[\s\S]*?<\/tr>/gi)].flatMap((row) => {
        const cells = [...row[0].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((cell) => cell[1]);
        if (cells.length < 4) return [];
        return [
            {
                semester: text(cells[0] ?? ""),
                course: text(cells[1] ?? ""),
                unique: text(cells[2] ?? ""),
                title: text(cells[3] ?? ""),
                instructors: (cells[4] ?? "")
                    .split(/<br\s*\/?>/i)
                    .map(text)
                    .filter(Boolean),
                syllabusUrl: absolute(href(row[0], /download syllabus/i)),
                surveyUrl: absolute(href(row[0], /course instructor survey/i)),
            },
        ];
    });
    return { totalFound: totalFound || sections.length, sections };
}

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
        return [
            {
                name,
                department: typeof node.department === "string" ? node.department : null,
                rating: numberOrNull(node.avgRating),
                difficulty: numberOrNull(node.avgDifficulty),
                numRatings: numberOrNull(node.numRatings),
                wouldTakeAgainPercent: rounded(numberOrNull(node.wouldTakeAgainPercent)),
                profileUrl: `https://www.ratemyprofessors.com/professor/${node.legacyId}`,
            },
        ];
    });
}

export function professorDetail(html: string, course?: string) {
    const store = relayStore(html);
    if (!store) return null;
    const comments = Object.values(store).flatMap((node) => {
        if (
            node["__typename"] !== "Rating" ||
            typeof node.comment !== "string" ||
            !node.comment.trim()
        ) {
            return [];
        }
        const className = typeof node.class === "string" ? node.class : null;
        return [
            {
                course: className,
                comment: node.comment.trim().slice(0, 400),
                tags: tags(node.ratingTags),
            },
        ];
    });
    const courses = Object.values(store).flatMap((node) => {
        if (typeof node.courseName !== "string" || typeof node.courseCount !== "number") return [];
        return [{ course: node.courseName, ratings: node.courseCount }];
    });
    const distribution = Object.values(store).find((node) =>
        ["total", "r1", "r2", "r3", "r4", "r5"].every((key) => typeof node[key] === "number"),
    );
    const focused = course
        ? comments.filter((comment) => courseMatches(comment.course ?? "", course))
        : comments;
    return {
        ratingDistribution: ratingCounts(distribution),
        courses: courses.sort((a, b) => b.ratings - a.ratings).slice(0, 5),
        comments: (focused.length > 0 ? focused : comments).slice(0, 3),
    };
}

export function nameMatches(name: string, query: string): boolean {
    const wanted = query.toLowerCase().split(/\s+/).filter(Boolean);
    const words = name.toLowerCase().split(/\s+/).filter(Boolean);
    if (wanted.length === 0) return false;
    return wanted.every((part) => words.includes(part));
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

function text(html: string): string {
    return html
        .replace(/<[^>]+>/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&nbsp;/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function href(html: string, marker: RegExp): string | null {
    for (const anchor of html.matchAll(/<a\s+([^>]+)>/gi)) {
        const attrs = anchor[1];
        if (!attrs || !marker.test(attrs)) continue;
        return attrs.match(/href="([^"]+)"/i)?.[1]?.replace(/&amp;/g, "&") ?? null;
    }
    return null;
}

function absolute(value: string | null): string | null {
    return value ? new URL(value, COURSE_ORIGIN).toString() : null;
}

function schoolRef(value: unknown): string | null {
    if (!value || typeof value !== "object" || !("__ref" in value)) return null;
    const ref = value["__ref"];
    return typeof ref === "string" ? ref : null;
}

function numberOrNull(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function rounded(value: number | null): number | null {
    return value == null ? null : Math.round(value);
}

function ratingCounts(node: RelayNode | undefined) {
    if (!node) return null;
    const total = node.total;
    const r1 = node.r1;
    const r2 = node.r2;
    const r3 = node.r3;
    const r4 = node.r4;
    const r5 = node.r5;
    if (
        typeof total !== "number" ||
        typeof r1 !== "number" ||
        typeof r2 !== "number" ||
        typeof r3 !== "number" ||
        typeof r4 !== "number" ||
        typeof r5 !== "number"
    ) {
        return null;
    }
    return { total, r1, r2, r3, r4, r5 };
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
