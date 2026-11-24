const COURSE_DOCS_URL =
    "https://utdirect.utexas.edu/apps/student/coursedocs/courses/nlogon/?unique=12345&search=Search&course_type=In%20Residence";
const RATE_MY_PROFESSORS_URL = "https://www.ratemyprofessors.com/school/1255";
const GRADE_DISTRIBUTION_URL =
    "https://iq-analytics.austin.utexas.edu/views/Gradedistributiondashboard/Externaldashboard-Crosstab.csv";

export const GRADE_DISTRIBUTION_HOME =
    "https://iq-analytics.austin.utexas.edu/views/Gradedistributiondashboard/Externaldashboard-Crosstab?:embed=y";

export type CourseSearch = {
    unique?: string;
    name?: string;
    timing?: string;
    year?: string;
    subject?: string;
    courseNumber?: string;
};

/** Copy the course documents URL and replace its search fields. */
export function courseSearchUrl(input: CourseSearch): string {
    const url = new URL(COURSE_DOCS_URL);
    url.search = "";
    const params = url.searchParams;
    params.set("search", "Search");
    params.set("course_type", "In Residence");
    if (input.unique?.trim()) params.set("unique", input.unique.trim());
    if (input.subject?.trim()) params.set("department", input.subject.trim());
    if (input.courseNumber?.trim()) params.set("course_number", input.courseNumber.trim());

    const year = input.year?.match(/\b(20\d{2})\b/)?.[1];
    if (year) params.set("year", year);

    const timing = input.timing?.trim();
    if (timing) {
        const semester =
            (/\b(fall|autumn)\b/i.test(timing) ? "9" : undefined) ??
            (/\bspring\b/i.test(timing) ? "2" : undefined) ??
            (/\bsummer\b/i.test(timing) ? "6" : undefined) ??
            (/^[269]$/.test(timing) ? timing : undefined);
        if (semester) params.set("semester", semester);
    }

    return url.toString();
}

/** Academic years the grade dashboard publishes, from 2010-2011 through the current one. */
export function academicYearSpans(now = new Date()): string[] {
    const startYear = now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1;
    const spans: string[] = [];
    for (let year = 2010; year <= startYear; year++) spans.push(`${year}-${year + 1}`);
    return spans;
}

/** Course documents for every semester of this course taught by this professor. */
export function professorCourseSearchUrl(input: { course: string; name: string }): string | null {
    const course = courseParts(input.course);
    const name = input.name.trim().split(/\s+/);
    const first = name[0];
    const last = name[name.length - 1];
    if (!course || !first || !last || name.length < 2) return null;

    const url = new URL(COURSE_DOCS_URL);
    url.search = "";
    const params = url.searchParams;
    params.set("search", "Search");
    params.set("course_type", "In Residence");
    params.set("department", course.prefix);
    params.set("course_number", course.number);
    params.set("instructor_first", first);
    params.set("instructor_last", last);
    return url.toString();
}

/** Grade counts for one academic year of a course, across Fall, Spring, and Summer. */
export function gradeSearchUrl(course: string, academicYear: string): string | null {
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

/** Copy the UT Austin school URL and point it at a professor search. */
export function professorSearchUrl(professor: string, course?: string): string {
    const school = new URL(RATE_MY_PROFESSORS_URL);
    const schoolId = school.pathname.split("/").filter(Boolean).pop();
    const url = new URL(`/search/professors/${schoolId}`, school.origin);
    url.searchParams.set("q", [professor.trim(), course?.trim()].filter(Boolean).join(" "));
    return url.toString();
}
