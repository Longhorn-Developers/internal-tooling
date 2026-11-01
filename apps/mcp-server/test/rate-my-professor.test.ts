import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { registerRateMyProfessor } from "../src/tools/rate-my-professor";
import {
    nameMatches,
    professorReviews,
    type TeacherReviews,
} from "../src/tools/rate-my-professor/extract";
import { fixture, stubFetch, toolCaller } from "./fixtures";

type Sample = { course: string; quality: number; comment: string; tags: string[] };

type Lookup = {
    needsInput: boolean;
    professors: { name: string; profileUrl: string }[];
    selected: {
        name: string;
        profileUrl: string;
        ratingDistribution: { total: number } | null;
        courses: { course: string; ratings: number }[];
        sampleRatings: Sample[];
        notable: string[];
    } | null;
    ask: string | null;
};

const call = toolCaller(registerRateMyProfessor);
const lookup = (args: Record<string, unknown>) => call<Lookup>("get_rate_my_professor", args);

const teacher = (name: string): TeacherReviews => {
    const parsed: { data: { node: TeacherReviews } } = JSON.parse(
        fixture(`rmp-reviews-${name}.json`),
    );
    return parsed.data.node;
};
const NORMAN = teacher("norman");
const ELNOZAHY = teacher("elnozahy");

const countByQuality = (samples: Sample[]) =>
    Object.fromEntries(
        [5, 4, 3, 2, 1].map((q) => [q, samples.filter((s) => s.quality === q).length]),
    );

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe("get_rate_my_professor", () => {
    it("returns the profile link, distribution, top courses and a sample of real ratings", async () => {
        stubFetch();
        const { selected, needsInput } = await lookup({ name: "Alison Norman" });

        expect(needsInput).toBe(false);
        expect(selected!.name).toBe("Alison Norman");
        expect(selected!.profileUrl).toBe("https://www.ratemyprofessors.com/professor/1902388");
        expect(selected!.ratingDistribution!.total).toBe(170);
        expect(selected!.courses.map((c) => c.course)).toEqual(["CS439", "CS349", "51875"]);
        expect(countByQuality(selected!.sampleRatings)).toEqual({ 5: 2, 4: 2, 3: 2, 2: 2, 1: 2 });
        expect(selected!.notable[0]).toBe("Alison Norman is rated 2.5 out of 5 from 170 ratings.");
    });

    it("asks for the professor's course when none was given", async () => {
        stubFetch();
        const { ask } = await lookup({ name: "Alison Norman" });
        expect(ask).toBe("Ask which course they want ratings for, then call again with course.");
    });

    it("samples only the requested course when it has ratings", async () => {
        stubFetch();
        const { selected, ask } = await lookup({ name: "Alison Norman", course: "349" });

        expect(ask).toBeNull();
        expect(selected!.sampleRatings.every((s) => s.course === "CS349")).toBe(true);
        expect(countByQuality(selected!.sampleRatings)).toEqual({ 5: 1, 4: 0, 3: 0, 2: 2, 1: 2 });
    });

    it("asks the user to pick when several professors match, without loading ratings", async () => {
        const log = stubFetch();
        const result = await lookup({ name: "Alison" });

        expect(result.needsInput).toBe(true);
        expect(result.selected).toBeNull();
        expect(result.professors.length).toBeGreaterThan(1);
        expect(result.professors.every((p) => p.name.startsWith("Alison "))).toBe(true);
        expect(result.ask).toContain("Alison Norman");
        expect(log.some((c) => c.url.endsWith("/graphql"))).toBe(false);
    });

    it("says so when no UT professor matches", async () => {
        stubFetch();
        const result = await lookup({ name: "Zzyzx Qwerty" });

        expect(result.professors).toEqual([]);
        expect(result.ask).toBe(
            "No UT professor matched that name. Ask for the first and last name.",
        );
    });

    it("asks for a name when given only whitespace", async () => {
        const log = stubFetch();
        const result = await lookup({ name: "   " });

        expect(result.needsInput).toBe(true);
        expect(log).toHaveLength(0);
    });

    it("loads ratings by the professor's GraphQL id", async () => {
        const log = stubFetch();
        await lookup({ name: "Alison Norman" });

        const request = log.find((c) => c.url.endsWith("/graphql"));
        expect(JSON.parse(request!.body!)).toMatchObject({
            variables: { id: btoa("Teacher-1902388") },
        });
    });
});

describe("rating sample", () => {
    it("takes at most two per star, highest first", () => {
        const sample = professorReviews(NORMAN).sampleRatings;
        expect(sample.map((s) => s.quality)).toEqual([5, 5, 4, 4, 3, 3, 2, 2, 1, 1]);
    });

    it("skips stars nobody gave", () => {
        const sample = professorReviews(ELNOZAHY).sampleRatings;
        expect(sample.map((s) => s.quality)).toEqual([5, 5, 4, 4, 3, 3, 2, 2]);
    });

    it("draws at random", () => {
        vi.spyOn(Math, "random").mockReturnValue(0);
        const first = professorReviews(NORMAN).sampleRatings.map((s) => s.comment);
        vi.spyOn(Math, "random").mockReturnValue(0.999);
        const last = professorReviews(NORMAN).sampleRatings.map((s) => s.comment);
        expect(first).not.toEqual(last);
    });

    it("falls back to every course when the requested one has no ratings", () => {
        const sample = professorReviews(NORMAN, "999").sampleRatings;
        expect(sample).toHaveLength(10);
    });

    it("leaves out ratings with no comment", () => {
        const silent: TeacherReviews = {
            ...NORMAN,
            ratings: {
                edges: NORMAN.ratings.edges.map(({ node }) => ({
                    node: { ...node, comment: " " },
                })),
            },
        };
        expect(professorReviews(silent).sampleRatings).toEqual([]);
    });
});

describe("name matching", () => {
    it.each([
        ["Mootaz Elnozahy", "E Elnozahy", true],
        ["Alison Norman", "norm", true],
        ["Alison Norman", "Alison Norman", true],
        ["Alison Norman", "Alison Smith", false],
        ["Alison Norman", "  ", false],
    ])("%s against %j is %s", (name, query, expected) => {
        expect(nameMatches(name, query)).toBe(expected);
    });
});
