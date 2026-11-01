const COURSE_ORIGIN = "https://utdirect.utexas.edu";

export type CourseSection = {
    semester: string;
    course: string;
    unique: string;
    title: string;
    instructors: string[];
    syllabusUrl: string | null;
    surveyUrl: string | null;
};

export function courseResults(html: string): {
    totalFound: number;
    sections: CourseSection[];
    errors: string[];
} {
    const alert = html.match(/alert-danger[\s\S]*?<\/div>/i)?.[0] ?? "";
    const errors = [...alert.matchAll(/<li>([\s\S]*?)<\/li>/gi)].map((item) => text(item[1]));
    const body =
        html.match(/<table[^>]*id="results_table"[\s\S]*?<tbody>([\s\S]*?)<\/tbody>/i)?.[1] ?? "";
    const sections = [...body.matchAll(/<tr[\s\S]*?<\/tr>/gi)].flatMap((row) => {
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
    const count = html.match(/(\d+)\s+courses found/i)?.[1];
    return { totalFound: count ? Number(count) : sections.length, sections, errors };
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
