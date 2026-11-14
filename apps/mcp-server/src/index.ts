import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import {
	courseResults,
	gradeDistribution,
	professorDetail,
	professorRatings,
	sectionsForQuery,
} from "./extract.ts";
import {
	GRADE_DISTRIBUTION_HOME,
	academicYearSpans,
	courseSearchUrl,
	gradeSearchUrl,
	professorCourseSearchUrl,
	professorSearchUrl,
} from "./urls.ts";

async function fetchPage(url: string): Promise<string> {
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`Page request returned HTTP ${response.status} ${response.statusText}.`);
	}
	return response.text();
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

function createServer() {
	const server = new McpServer({
		name: "Longhorn Developers",
		version: "1.0.0",
	});

	// TODO: boilerplate!
	server.registerTool(
		"calculate",
		{
			title: "Calculate",
			description: "Perform a basic arithmetic operation on two numbers",
			inputSchema: z.object({
				operation: z.enum(["add", "subtract", "multiply", "divide"]),
				a: z.number(),
				b: z.number(),
			}),
			outputSchema: z.union([
				z.object({ result: z.number() }),
				z.object({ error: z.string() }),
			]),
		},
		async ({ operation, a, b }) => {
			let result: number;
			switch (operation) {
				case "add":
					result = a + b;
					break;
				case "subtract":
					result = a - b;
					break;
				case "multiply":
					result = a * b;
					break;
				case "divide":
					if (b === 0) {
						const output = { error: "Cannot divide by zero" };
						return {
							content: [{ type: "text", text: JSON.stringify(output) }],
							structuredContent: output,
						};
					}
					result = a / b;
					break;
			}

			const output = { result };
			return {
				content: [{ type: "text", text: JSON.stringify(output) }],
				structuredContent: output,
			};
		},
	);

	server.registerTool(
		"get_course_overview",
		{
			title: "Get Course Overview",
			description:
				"Search UT course documents by editing the syllabus URL. Requires unique, name, timing, and year. Returns JSON for the matching sections: semester, course, unique, title, instructors, syllabus URL, the professor's combined grade distribution for this course across published semesters, and the professor's Rate My Professors rating. Timing is Fall, Spring, or Summer. Year is a four-digit year such as 2026. Optional subject and courseNumber narrow the search.",
			inputSchema: z.object({
				unique: z.string().describe("Five-digit UT unique number."),
				name: z.string().describe("Professor name."),
				timing: z.string().describe("Semester: Fall, Spring, or Summer."),
				year: z.string().describe("Four-digit year, such as 2026."),
				subject: z.string().optional().describe("Department code, such as C S."),
				courseNumber: z.string().optional().describe("Course number, such as 314."),
			}),
		},
		async (input) => {
			const query = {
				unique: blank(input.unique),
				name: blank(input.name),
				timing: blank(input.timing),
				year: blank(input.year),
				subject: blank(input.subject),
				courseNumber: blank(input.courseNumber),
			};
			const missing = [
				!query.unique ? "unique" : "",
				!query.name ? "name" : "",
				!query.timing ? "timing" : "",
				!query.year ? "year" : "",
			].filter(Boolean);
			if (missing.length > 0) {
				return json({
					needsInput: true,
					ask: `Ask for the required ${missing.join(", ")}. Unique is the five-digit section number, name is the professor, timing is Fall, Spring, or Summer, and year is a four-digit year.`,
				});
			}

			const searchUrl = courseSearchUrl(input);
			const found = courseResults(await fetchPage(searchUrl));
			const sections = sectionsForQuery(
				found.sections,
				query.unique as string,
				query.name as string,
			);
			const rosterName = sections[0]?.instructors[0] ?? (query.name as string);
			const professors = professorRatings(
				await fetchPage(professorSearchUrl(rosterName, query.courseNumber ?? undefined)),
				rosterName,
			);
			const section = sections[0];
			const professorCoursesUrl = section
				? professorCourseSearchUrl({ course: section.course, name: rosterName })
				: null;
			const taught = professorCoursesUrl
				? courseResults(await fetchPage(professorCoursesUrl)).sections.filter(
						(item) => item.course === section.course,
					)
				: [];
			const gradeSearchUrls = section
				? academicYearSpans().flatMap((year) => {
						const url = gradeSearchUrl(section.course, year);
						return url ? [url] : [];
					})
				: [];
			const distribution =
				section && gradeSearchUrls.length > 0
					? gradeDistribution(
							await fetchGradeCsvs(gradeSearchUrls),
							taught.length > 0 ? taught : [section],
							rosterName,
						)
					: null;
			return json({
				query,
				searchUrl,
				professorCoursesUrl,
				totalFound: sections.length,
				sections,
				gradeDistribution: distribution,
				gradesNote:
					section && !distribution
						? "UT has not published a grade distribution for this professor in this course."
						: null,
				professors,
				ask:
					sections.length === 0
						? "No sections matched. Ask for the unique, professor name, semester, and year again."
						: professors.length > 1
							? "More than one Rate My Professors profile matched. Ask which name to use, then call get_rate_my_professor."
							: null,
			});
		},
	);

	server.registerTool(
		"get_rate_my_professor",
		{
			title: "Get Rate My Professors Data",
			description:
				"Search Rate My Professors for a UT Austin professor by editing the school search URL. Requires name. Returns JSON for that professor: rating, difficulty, would-take-again, and, when one person matches, recent comments and courses. Optional course, such as 314H, limits the comments. If several people match, the JSON lists them and asks which name.",
			inputSchema: z.object({
				name: z.string().min(1).describe("Professor name."),
				course: z.string().optional().describe("Course number, such as 314H."),
			}),
		},
		async ({ name: professor, course }) => {
			const name = blank(professor);
			if (!name) {
				return json({
					needsInput: true,
					ask: "Ask for the professor's name. Add a course, such as 314H, if they want ratings for one class.",
				});
			}

			const searchUrl = professorSearchUrl(name, course ?? undefined);
			const matches = professorRatings(await fetchPage(searchUrl), name);
			if (matches.length !== 1) {
				return json({
					query: { professor: name, course: blank(course) },
					searchUrl,
					needsInput: true,
					professors: matches,
					selected: null,
					ask:
						matches.length === 0
							? "No UT professor matched that name. Ask for the first and last name."
							: `Ask which professor is meant: ${matches.map((match) => match.name).join(", ")}.`,
				});
			}

			const selected = matches[0];
			const detail = professorDetail(await fetchPage(selected.profileUrl), course);
			const comments = detail?.comments ?? [];
			const courses = detail?.courses ?? [];
			return json({
				query: { professor: name, course: blank(course) },
				searchUrl,
				needsInput: false,
				professors: matches,
				selected: {
					...selected,
					ratingDistribution: detail?.ratingDistribution ?? null,
					courses,
					comments,
					notable: notable(selected, courses, comments),
				},
				ask: course
					? null
					: "Ask which course they want ratings for, then call again with course.",
			});
		},
	);

	return server;
}

function json(value: Record<string, unknown>) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
		structuredContent: value,
	};
}

function blank(value: string | undefined): string | null {
	const trimmed = value?.trim();
	return trimmed ? trimmed : null;
}

function notable(
	professor: {
		name: string;
		rating: number | null;
		difficulty: number | null;
		numRatings: number | null;
		wouldTakeAgainPercent: number | null;
	},
	courses: { course: string; ratings: number }[],
	comments: { tags: string[] }[],
): string[] {
	const notes: string[] = [];
	if (professor.rating != null) {
		notes.push(
			`${professor.name} is rated ${professor.rating} out of 5 from ${professor.numRatings ?? 0} ratings.`,
		);
	}
	if (professor.difficulty != null) notes.push(`Difficulty is ${professor.difficulty} out of 5.`);
	if (professor.wouldTakeAgainPercent != null) {
		notes.push(`${professor.wouldTakeAgainPercent}% would take this professor again.`);
	}
	if (courses[0])
		notes.push(`Most rated course: ${courses[0].course} (${courses[0].ratings} ratings).`);
	const tags = [...new Set(comments.flatMap((comment) => comment.tags))].slice(0, 3);
	if (tags.length > 0) notes.push(`Recent reviews mention ${tags.join(", ")}.`);
	return notes;
}

const handler = createMcpHandler(createServer, {
	route: "/",
	allowedHostnames: ["mcp.longhorndevelopers.org"],
});

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		return handler(request, env, ctx);
	},
} satisfies ExportedHandler<Env>;
