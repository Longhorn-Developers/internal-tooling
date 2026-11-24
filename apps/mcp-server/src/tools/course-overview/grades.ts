import { fetchPage } from "../../shared.ts";
import { courseResults } from "./extract.ts";

const GRADE_DISTRIBUTION_URL =
    "https://iq-analytics.austin.utexas.edu/views/Gradedistributiondashboard/Externaldashboard-Crosstab.csv";
const GRADE_DISTRIBUTION_HOME =
    "https://iq-analytics.austin.utexas.edu/views/Gradedistributiondashboard/Externaldashboard-Crosstab?:embed=y";
const COURSE_DOCS_URL = "https://utdirect.utexas.edu/apps/student/coursedocs/courses/nlogon/";
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

/** Published grade counts for this professor's sections of one course, across years. */
export async function loadGradeDistribution(
    course: string,
    instructor: string,
): Promise<GradeDistribution | null> {
    const historyUrl = professorCourseSearchUrl(course, instructor);
    if (!historyUrl) return null;
    const taught = courseResults(await fetchPage(historyUrl)).sections.filter(
        (section) => section.course === course,
    );
    if (taught.length === 0) return null;
    const urls = academicYearSpans().flatMap((year) => {
        const url = gradeSearchUrl(course, year);
        return url ? [url] : [];
    });
    return gradeDistribution(await fetchGradeCsvs(urls), taught, instructor);
}

function academicYearSpans(now = new Date()): string[] {
    const startYear = now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1;
    const spans: string[] = [];
    for (let year = 2010; year <= startYear; year++) spans.push(`${year}-${year + 1}`);
    return spans;
}

function professorCourseSearchUrl(course: string, name: string): string | null {
    const parts = courseParts(course);
    const words = name.trim().split(/\s+/);
    const first = words[0];
    const last = words[words.length - 1];
    if (!parts || !first || !last || words.length < 2) return null;
    const url = new URL(COURSE_DOCS_URL);
    url.searchParams.set("search", "Search");
    url.searchParams.set("course_type", "In Residence");
    url.searchParams.set("department", parts.prefix);
    url.searchParams.set("course_number", parts.number);
    url.searchParams.set("instructor_first", first);
    url.searchParams.set("instructor_last", last);
    return url.toString();
}

function gradeSearchUrl(course: string, academicYear: string): string | null {
    const parts = courseParts(course);
    if (!parts || !/^\d{4}-\d{4}$/.test(academicYear)) return null;
    const url = new URL(GRADE_DISTRIBUTION_URL);
    url.searchParams.set("Course Prefix", parts.prefix);
    url.searchParams.set(
        "Course Number",
        /^\d/.test(parts.number) ? ` ${parts.number}` : parts.number,
    );
    url.searchParams.set("c.semester select", "Fall,Spring,Summer");
    url.searchParams.set("Academic Year Span", academicYear);
    return url.toString();
}

function courseParts(course: string): { prefix: string; number: string } | null {
    const parts = course.trim().split(/\s+/);
    const number = parts.pop();
    const prefix = parts.join(" ");
    if (!number || !prefix) return null;
    return { prefix, number };
}

async function fetchGradeCsvs(urls: string[]): Promise<string[]> {
    const home = await fetch(GRADE_DISTRIBUTION_HOME);
    if (!home.ok) {
        throw new Error(`Page request returned HTTP ${home.status} ${home.statusText}.`);
    }
    const cookie = cookieHeader(home);
    return Promise.all(
        urls.map(async (url) => {
            const response = await fetch(url, { headers: { cookie } });
            if (!response.ok) {
                throw new Error(
                    `Page request returned HTTP ${response.status} ${response.statusText}.`,
                );
            }
            return response.text();
        }),
    );
}

function cookieHeader(response: Response): string {
    const listed =
        typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
    const raw = listed.length > 0 ? listed : [response.headers.get("set-cookie") ?? ""];
    return raw
        .map((value) => value.split(";")[0]?.trim())
        .filter((value) => value)
        .join("; ");
}

function gradeDistribution(
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
