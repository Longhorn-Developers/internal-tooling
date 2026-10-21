import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

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
				"Generates a course overview based on the UT unique number and optional course details.",
			inputSchema: z.object({
				courseId: z.number().int().positive(),
				courseName: z.string().optional(),
				year: z.number().optional(),
				semester: z.enum(["spring", "summer", "fall"]).optional(),
			}),
			outputSchema: z.object({
				courseId: z.number(),
				courseName: z.string().optional(),
				year: z.number().optional(),
				semester: z.enum(["spring", "summer", "fall"]).optional(),
				resultCount: z.number(),
				courses: z.array(
					z.object({
						semester: z.string(),
						course: z.string(),
						unique: z.string(),
						sectionTitle: z.string(),
						instructors: z.array(z.string()),
						cvs: z.array(z.object({ text: z.string(), url: z.string() })),
						syllabusUrl: z.string().optional(),
						surveyUrl: z.string().optional(),
					}),
				),
			}),
		},

		async ({ courseId, courseName, year, semester }) => {
			const url = new URL(COURSE_DOCS_URL);
			url.searchParams.set("unique", String(courseId));
			if (courseName) {
				url.searchParams.set("course_title", courseName);
			}
			url.searchParams.set("search", "Search");
			url.searchParams.set("course_type", "In Residence");
			if (year !== undefined) {
				url.searchParams.set("year", String(year));
			}
			if (semester) {
				url.searchParams.set("semester", SEMESTER_CODES[semester]);
			}

			const response = await fetch(url);
			if (!response.ok) {
				throw new Error(
					`UT course-docs returned HTTP ${response.status} ${response.statusText}.`,
				);
			}

			const { courses } = parseCourseResults(await response.text());
			const matchingCourse = courses.find((course) => course.unique === String(courseId));
			const matchingCourses = matchingCourse ? [matchingCourse] : [];

			const output = {
				courseId,
				courseName,
				year,
				semester,
				resultCount: matchingCourses.length,
				courses: matchingCourses,
			};
			return {
				content: [{ type: "text", text: JSON.stringify(output) }],
				structuredContent: output,
			};
		},
	);

	return server;
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
