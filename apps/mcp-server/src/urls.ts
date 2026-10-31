const COURSE_DOCS_URL =
	"https://utdirect.utexas.edu/apps/student/coursedocs/courses/nlogon/?unique=12345&search=Search&course_type=In%20Residence";
const RATE_MY_PROFESSORS_URL = "https://www.ratemyprofessors.com/school/1255";

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

/** Copy the UT Austin school URL and point it at a professor search. */
export function professorSearchUrl(professor: string, course?: string): string {
	const school = new URL(RATE_MY_PROFESSORS_URL);
	const schoolId = school.pathname.split("/").filter(Boolean).pop();
	const url = new URL(`/search/professors/${schoolId}`, school.origin);
	url.searchParams.set("q", [professor.trim(), course?.trim()].filter(Boolean).join(" "));
	return url.toString();
}
