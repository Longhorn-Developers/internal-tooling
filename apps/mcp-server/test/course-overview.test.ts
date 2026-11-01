import { afterEach, describe, expect, it } from "vite-plus/test";
import { vi } from "vite-plus/test";

import { registerCourseOverview } from "../src/tools/course-overview";
import { courseResults } from "../src/tools/course-overview/extract";
import { courseSearchUrl, semesterCode } from "../src/tools/course-overview/urls";
import { fixture, stubFetch, toolCaller } from "./fixtures";

type Overview = {
    complete: boolean;
    missing: string[];
    notes: string[];
    totalFound: number;
    returned: number;
    sections: {
        semester: string;
        course: string;
        unique: string;
        instructors: string[];
        syllabusUrl: string | null;
    }[];
    professors: {
        instructor: string;
        matches: { name: string; profileUrl: string }[] | null;
        reviews: { sampleRatings: unknown[] } | null;
    }[];
};

const call = toolCaller(registerCourseOverview);
const overview = (args: Record<string, unknown>) => call<Overview>("get_course_overview", args);

const CS439 = { subject: "C S", courseNumber: "439", timing: "Fall 2025" };

afterEach(() => vi.unstubAllGlobals());

describe("get_course_overview", () => {
    it("returns every section for a partial query and says what is missing", async () => {
        stubFetch();
        const result = await overview(CS439);

        expect(result.totalFound).toBe(14);
        expect(result.returned).toBe(14);
        expect(new Set(result.sections.map((s) => s.course))).toEqual(
            new Set(["C S 439", "C S 439H"]),
        );
        expect(result.sections.every((s) => s.semester === "2025 Fall")).toBe(true);
        expect(result.complete).toBe(false);
        expect(result.missing).toEqual(["unique", "name"]);
        expect(result.notes).toEqual(["Results may be broad or empty without unique, name."]);
    });

    it("reads the year out of the timing and sends every filter to UT", async () => {
        const log = stubFetch();
        await overview(CS439);

        const search = new URL(log[0]!.url);
        expect(search.searchParams.get("department")).toBe("C S");
        expect(search.searchParams.get("course_number")).toBe("439");
        expect(search.searchParams.get("semester")).toBe("9");
        expect(search.searchParams.get("year")).toBe("2025");
    });

    it("parses instructors and makes syllabus links absolute", async () => {
        stubFetch();
        const { sections } = await overview(CS439);

        expect(sections.flatMap((s) => s.instructors)).not.toContain("");
        expect(sections.flatMap((s) => s.instructors).some((name) => name.includes("<"))).toBe(
            false,
        );
        expect(
            sections.every((s) => s.syllabusUrl?.startsWith("https://utdirect.utexas.edu/")),
        ).toBe(true);
    });

    it("rates each instructor and links their Rate My Professors profile", async () => {
        stubFetch();
        const { professors } = await overview(CS439);

        expect(professors.map((p) => p.instructor)).toEqual([
            "Ahmed Gheith",
            "Alison Norman",
            "E Elnozahy",
        ]);
        for (const professor of professors) {
            expect(professor.matches).toHaveLength(1);
            expect(professor.matches![0]!.profileUrl).toMatch(
                /^https:\/\/www\.ratemyprofessors\.com\/professor\/\d+$/,
            );
            expect(professor.reviews!.sampleRatings.length).toBeGreaterThan(0);
        }
        expect(professors[2]!.matches![0]!.name).toBe("Mootaz Elnozahy");
    });

    it("keeps only the exact unique when UT returns its neighbours too", async () => {
        const log = stubFetch();
        const result = await overview({
            unique: "54945",
            name: "Ahmed Gheith",
            timing: "Fall",
            year: "2025",
        });

        expect(new URL(log[0]!.url).searchParams.get("instructor_last")).toBe("Gheith");
        expect(result.sections.map((s) => s.unique)).toEqual(["54945"]);
        expect(result.totalFound).toBe(1);
        expect(result.complete).toBe(true);
        expect(result.notes).toEqual([]);
        expect(result.professors.map((p) => p.instructor)).toEqual(["Ahmed Gheith"]);
    });

    it("passes UT's own error back and skips Rate My Professors when there is no one to rate", async () => {
        const log = stubFetch();
        const result = await overview({});

        expect(result.sections).toEqual([]);
        expect(result.professors).toEqual([]);
        expect(result.missing).toEqual(["unique", "name", "timing", "year"]);
        expect(result.notes).toContain("Must enter some search term to begin search.");
        expect(log).toHaveLength(1);
    });

    it("says when it could not read the timing or the year", async () => {
        const log = stubFetch();
        const result = await overview({ subject: "C S", timing: "Winter", year: "next year" });

        expect(new URL(log[0]!.url).searchParams.has("semester")).toBe(false);
        expect(new URL(log[0]!.url).searchParams.has("year")).toBe(false);
        expect(result.notes).toContain('Ignored unrecognized timing "Winter".');
        expect(result.notes).toContain('Ignored unrecognized year "next year".');
    });

    it("still returns sections when Rate My Professors is down", async () => {
        stubFetch({ "ratemyprofessors.com": 500 });
        const result = await overview(CS439);

        expect(result.returned).toBe(14);
        expect(result.professors.every((p) => p.matches === null)).toBe(true);
        expect(result.notes).toContain("Rate My Professors lookup failed for some instructors.");
    });

    it("caps the sections and the instructors it rates, and says so", async () => {
        const names = ["Ahmed Gheith", "Alison Norman", "E Elnozahy", "Zzyzx Qwerty"];
        const rows = Array.from(
            { length: 60 },
            (_, i) =>
                `<tr><td>2025 Fall</td><td>C S 439</td><td>${50000 + i}</td><td>Systems</td><td>${names[i % 4]}<br/></td></tr>`,
        ).join("");
        stubFetch({
            "course_number=439": `<strong>60 courses found.</strong><table id="results_table"><tbody>${rows}</tbody></table>`,
        });
        const result = await overview(CS439);

        expect(result.totalFound).toBe(60);
        expect(result.returned).toBe(50);
        expect(result.professors).toHaveLength(3);
        expect(result.notes).toContain("Showing 50 of 60 sections; add filters to narrow.");
        expect(result.notes).toContain("Ratings shown for 3 of 4 instructors.");
    });
});

describe("course search parsing", () => {
    it("reads UT's validation message as an error, not as zero results", () => {
        expect(courseResults(fixture("coursedocs-no-search.html"))).toEqual({
            totalFound: 0,
            sections: [],
            errors: ["Must enter some search term to begin search."],
        });
    });

    it("leaves out filters that were not given", () => {
        const url = new URL(courseSearchUrl({ unique: "54945", department: null, year: "" }));
        expect([...url.searchParams.keys()]).toEqual(["search", "course_type", "unique"]);
    });

    it.each([
        ["Fall", "9"],
        ["autumn 2025", "9"],
        ["Spring '26", "2"],
        ["SUMMER", "6"],
        ["2", "2"],
        ["Winter", null],
    ])("reads %s as semester %s", (timing, code) => {
        expect(semesterCode(timing)).toBe(code);
    });
});
