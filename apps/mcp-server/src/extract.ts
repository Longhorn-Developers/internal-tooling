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
		section.instructors.some((instructor) => instructor.toLowerCase().split(/\s+/).includes(last)),
	);
}

export function courseResults(html: string): { totalFound: number; sections: CourseSection[] } {
	const count = html.match(/<strong>\s*(\d+)\s+courses found/i);
	const totalFound = count ? Number(count[1]) : /no courses found/i.test(html) ? 0 : 0;
	const body = html.match(/<table[^>]*id="results_table"[\s\S]*?<tbody>([\s\S]*?)<\/tbody>/i);
	if (!body) return { totalFound, sections: [] };

	const sections = [...body[1].matchAll(/<tr[\s\S]*?<\/tr>/gi)].flatMap((row) => {
		const cells = [...row[0].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((cell) => cell[1]);
		if (cells.length < 4) return [];
		return [
			{
				semester: text(cells[0]),
				course: text(cells[1]),
				unique: text(cells[2]),
				title: text(cells[3]),
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
				wouldTakeAgainPercent:
					numberOrNull(node.wouldTakeAgainPercent) == null
						? null
						: Math.round(numberOrNull(node.wouldTakeAgainPercent) as number),
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
		ratingDistribution: distribution
			? {
					total: distribution.total as number,
					r1: distribution.r1 as number,
					r2: distribution.r2 as number,
					r3: distribution.r3 as number,
					r4: distribution.r4 as number,
					r5: distribution.r5 as number,
				}
			: null,
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
		if (!marker.test(anchor[1])) continue;
		return anchor[1].match(/href="([^"]+)"/i)?.[1]?.replace(/&amp;/g, "&") ?? null;
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
