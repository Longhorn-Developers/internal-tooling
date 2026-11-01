import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { fetchPage, jsonResponse, trimmed } from "../../shared.ts";
import {
    PROFESSOR_REVIEWS_QUERY,
    professorRatings,
    professorReviews,
    type ProfessorRating,
    type TeacherReviews,
} from "./extract.ts";
import { professorSearchUrl, RMP_GRAPHQL_URL } from "./urls.ts";

export async function lookupProfessor(name: string, course?: string | null) {
    const searchUrl = professorSearchUrl(name, course);
    const matches = professorRatings(await fetchPage(searchUrl), name);
    const reviews = matches.length === 1 ? await fetchReviews(matches[0], course) : null;
    return { searchUrl, matches, reviews };
}

async function fetchReviews(professor: ProfessorRating, course?: string | null) {
    const body = await fetchPage(RMP_GRAPHQL_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: PROFESSOR_REVIEWS_QUERY, variables: { id: professor.id } }),
    });
    const { data }: { data?: { node?: TeacherReviews | null } } = JSON.parse(body);
    return data?.node ? professorReviews(data.node, course) : null;
}

export function registerRateMyProfessor(server: McpServer) {
    server.registerTool(
        "get_rate_my_professor",
        {
            title: "Get Rate My Professors Data",
            description:
                "Search Rate My Professors for a UT Austin professor. Requires name. Returns rating, difficulty, would-take-again, a profileUrl, and, when one person matches, the rating distribution, top courses, and a random sample of real ratings across the 1-5 quality range. Optional course, such as 314H, focuses the sample on that class. If several people match, the JSON lists them and asks which name. Give the user the profileUrl so they can read every rating.",
            inputSchema: z.object({
                name: z.string().min(1).describe("Professor name."),
                course: z.string().optional().describe("Course number, such as 314H."),
            }),
        },
        async (input) => {
            const name = trimmed(input.name);
            const course = trimmed(input.course);
            if (!name) {
                return jsonResponse({
                    needsInput: true,
                    ask: "Ask for the professor's name. Add a course, such as 314H, if they want ratings for one class.",
                });
            }

            const { searchUrl, matches, reviews } = await lookupProfessor(name, course);
            const query = { professor: name, course };
            if (matches.length !== 1) {
                return jsonResponse({
                    query,
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
            return jsonResponse({
                query,
                searchUrl,
                needsInput: false,
                professors: matches,
                selected: {
                    ...selected,
                    ...reviews,
                    notable: notable(
                        selected,
                        reviews?.courses ?? [],
                        reviews?.sampleRatings ?? [],
                    ),
                },
                ask: course
                    ? null
                    : "Ask which course they want ratings for, then call again with course.",
            });
        },
    );
}

function notable(
    professor: ProfessorRating,
    courses: { course: string; ratings: number }[],
    ratings: { tags: string[] }[],
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
    if (courses.length > 0) {
        notes.push(
            `Most rated courses: ${courses.map((course) => `${course.course} (${course.ratings})`).join(", ")}.`,
        );
    }
    const tags = [...new Set(ratings.flatMap((rating) => rating.tags))].slice(0, 3);
    if (tags.length > 0) notes.push(`Reviews mention ${tags.join(", ")}.`);
    return notes;
}
