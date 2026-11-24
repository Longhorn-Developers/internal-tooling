const PROFESSOR_SEARCH_URL = "https://www.ratemyprofessors.com/search/professors/1255";
export const RMP_GRAPHQL_URL = "https://www.ratemyprofessors.com/graphql";

export function professorSearchUrl(professor: string, course?: string | null): string {
    const url = new URL(PROFESSOR_SEARCH_URL);
    url.searchParams.set("q", [professor, course].filter(Boolean).join(" "));
    return url.toString();
}
