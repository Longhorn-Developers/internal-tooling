const COURSE_DOCS_URL = "https://utdirect.utexas.edu/apps/student/coursedocs/courses/nlogon/";

export function courseSearchUrl(fields: Record<string, string | null>): string {
    const url = new URL(COURSE_DOCS_URL);
    url.searchParams.set("search", "Search");
    url.searchParams.set("course_type", "In Residence");
    for (const [key, value] of Object.entries(fields)) if (value) url.searchParams.set(key, value);
    return url.toString();
}

export function semesterCode(timing: string): string | null {
    if (/\b(fall|autumn)\b|^9$/i.test(timing)) return "9";
    if (/\bspring\b|^2$/i.test(timing)) return "2";
    if (/\bsummer\b|^6$/i.test(timing)) return "6";
    return null;
}
