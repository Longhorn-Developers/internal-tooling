import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import { courseResults, professorDetail, professorRatings, sectionsForQuery } from "./extract.ts";
import { courseSearchUrl, professorSearchUrl } from "./urls.ts";

async function fetchPage(url: string): Promise<string> {
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`Page request returned HTTP ${response.status} ${response.statusText}.`);
	}
	return response.text();
}

const COURSE_DOCS_URL = "https://utdirect.utexas.edu/apps/student/coursedocs/courses/nlogon/";
const SEMESTER_CODES = {
	spring: "2",
	summer: "6",
	fall: "9",
} as const;

function decodeHtmlEntities(value: string): string {
	return value.replace(
		/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,
		(entity, code: string) => {
			if (code.startsWith("#x")) {
				return String.fromCodePoint(Number.parseInt(code.slice(2), 16));
			}
			if (code.startsWith("#")) {
				return String.fromCodePoint(Number.parseInt(code.slice(1), 10));
			}

			return (
				{
					amp: "&",
					lt: "<",
					gt: ">",
					quot: '"',
					apos: "'",
					nbsp: " ",
				}[code.toLowerCase()] ?? entity
			);
		},
	);
}

function getCellText(cell: string): string {
	return decodeHtmlEntities(
		cell
			.replace(/<br\s*\/?>/gi, "\n")
			.replace(/<[^>]*>/g, " ")
			.replace(/[ \t]+/g, " ")
			.replace(/ *\n */g, "\n")
			.trim(),
	);
}

function getCellLinks(cell: string): { text: string; url: string }[] {
	return [...cell.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)].map(
		([, href, text]) => ({
			text: getCellText(text),
			url: new URL(decodeHtmlEntities(href), COURSE_DOCS_URL).toString(),
		}),
	);
}

function parseCourseResults(html: string) {
	const resultCount = html.match(
		/<p class="results">\s*<strong>(\d+) courses found\.<\/strong>/i,
	);
	const tableBody = html.match(
		/<table\b[^>]*id="results_table"[^>]*>[\s\S]*?<tbody>([\s\S]*?)<\/tbody>/i,
	);

	if (!resultCount && !tableBody) {
		throw new Error("The UT course-docs response did not contain search results.");
	}

	const courses = [...(tableBody?.[1] ?? "").matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(
		([, row]) => {
			const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(
				([, cell]) => cell,
			);
			if (cells.length < 8) {
				throw new Error("The UT course-docs result row had an unexpected format.");
			}

			return {
				semester: getCellText(cells[0]),
				course: getCellText(cells[1]),
				unique: getCellText(cells[2]),
				sectionTitle: getCellText(cells[3]),
				instructors: getCellText(cells[4])
					.split("\n")
					.map((name) => name.trim())
					.filter(Boolean),
				cvs: getCellLinks(cells[5]),
				syllabusUrl: getCellLinks(cells[6])[0]?.url,
				surveyUrl: getCellLinks(cells[7])[0]?.url,
			};
		},
	);

	return {
		resultCount: Number(resultCount?.[1] ?? courses.length),
		courses,
	};
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
				"Search UT course documents by editing the syllabus URL. Requires unique, name, timing, and year. Returns JSON for the matching sections: semester, course, unique, title, instructors, syllabus URL, and the professor's Rate My Professors rating. Timing is Fall, Spring, or Summer. Year is a four-digit year such as 2026. Optional subject and courseNumber narrow the search.",
			inputSchema: z.object({
				unique: z.string().min(1).describe("Five-digit UT unique number."),
				name: z.string().min(1).describe("Professor name."),
				timing: z.string().min(1).describe("Semester: Fall, Spring, or Summer."),
				year: z.string().min(1).describe("Four-digit year, such as 2026."),
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
			const sections = sectionsForQuery(found.sections, query.unique as string, query.name as string);
			const rosterName = sections[0]?.instructors[0] ?? (query.name as string);
			const professors = professorRatings(
				await fetchPage(professorSearchUrl(rosterName, query.courseNumber ?? undefined)),
				rosterName,
			);
			return json({
				query,
				searchUrl,
				totalFound: sections.length,
				sections,
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
