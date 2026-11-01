import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { fetchPage, jsonResponse, trimmed } from "../../shared.ts";
import { nameMatches } from "../rate-my-professor/extract.ts";
import { lookupProfessor } from "../rate-my-professor";
import { courseResults } from "./extract.ts";
import { courseSearchUrl, semesterCode } from "./urls.ts";

const MAX_SECTIONS = 50;
const MAX_PROFESSORS = 3;

export function registerCourseOverview(server: McpServer) {
    server.registerTool(
        "get_course_overview",
        {
            title: "Get Course Overview",
            description:
                "Get UT course sections, syllabus links, and Rate My Professors ratings for any current or prior course. Every parameter is optional; give as many as possible to narrow results. The response says whether results are complete and what to ask for if not. Each matched professor includes a random sample of real ratings across the 1-5 quality range and a profileUrl; give the user the profileUrl so they can read every rating if they desire.",
            inputSchema: z.object({
                unique: z.string().optional().describe("Five-digit UT unique number."),
                name: z.string().optional().describe("Professor name."),
                timing: z.string().optional().describe("Semester: Fall, Spring, or Summer."),
                year: z.string().optional().describe("Four-digit year, such as 2026."),
                subject: z
                    .string()
                    .optional()
                    .describe("Department code as UT writes it, such as C S or M."),
                courseNumber: z.string().optional().describe("Course number, such as 314."),
            }),
        },
        async (input) => {
            const query = {
                unique: trimmed(input.unique),
                name: trimmed(input.name),
                timing: trimmed(input.timing),
                year: trimmed(input.year),
                subject: trimmed(input.subject),
                courseNumber: trimmed(input.courseNumber),
            };
            const semester = query.timing && semesterCode(query.timing);
            const year = (query.year ?? query.timing)?.match(/\b\d{4}\b/)?.[0] ?? null;
            const missing = Object.entries({
                unique: query.unique,
                name: query.name,
                timing: semester,
                year,
            })
                .filter(([, value]) => !value)
                .map(([key]) => key);

            const searchUrl = courseSearchUrl({
                unique: query.unique,
                department: query.subject,
                course_number: query.courseNumber,
                semester,
                year,
                instructor_last: query.name?.split(/\s+/).pop() ?? null,
            });
            const found = courseResults(await fetchPage(searchUrl));
            const exact = found.sections.filter((section) => section.unique === query.unique);
            const totalFound = exact.length || found.totalFound;
            const sections = (exact.length > 0 ? exact : found.sections).slice(0, MAX_SECTIONS);
            const instructors = [...new Set(sections.flatMap((section) => section.instructors))];
            const { name } = query;
            const names = name
                ? [instructors.find((instructor) => nameMatches(instructor, name)) ?? name]
                : instructors.slice(0, MAX_PROFESSORS);
            const professors = await Promise.all(
                names.map(async (instructor) => ({
                    instructor,
                    ...(await lookupProfessor(instructor, query.courseNumber).catch(() => ({
                        searchUrl: null,
                        matches: null,
                        reviews: null,
                    }))),
                })),
            );

            const notes = [
                ...found.errors,
                found.sections.length === 0 && found.errors.length === 0
                    ? "No sections matched; try different or fewer filters."
                    : "",
                missing.length > 0
                    ? `Results may be broad or empty without ${missing.join(", ")}.`
                    : "",
                query.timing && !semester ? `Ignored unrecognized timing "${query.timing}".` : "",
                query.year && !year ? `Ignored unrecognized year "${query.year}".` : "",
                totalFound > sections.length
                    ? `Showing ${sections.length} of ${totalFound} sections; add filters to narrow.`
                    : "",
                !name && instructors.length > names.length
                    ? `Ratings shown for ${names.length} of ${instructors.length} instructors.`
                    : "",
                professors.some((professor) => professor.matches === null)
                    ? "Rate My Professors lookup failed for some instructors."
                    : "",
                professors.some((professor) => (professor.matches?.length ?? 0) > 1)
                    ? "Several Rate My Professors profiles matched; call get_rate_my_professor with the exact name."
                    : "",
            ].filter(Boolean);

            return jsonResponse({
                query,
                searchUrl,
                complete: notes.length === 0,
                missing,
                notes,
                totalFound,
                returned: sections.length,
                sections,
                professors,
            });
        },
    );
}
