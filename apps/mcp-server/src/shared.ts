export async function fetchPage(url: string, init?: RequestInit): Promise<string> {
    const response = await fetch(url, init);
    if (!response.ok) {
        throw new Error(`Page request returned HTTP ${response.status} ${response.statusText}.`);
    }
    return response.text();
}

export function jsonResponse(value: Record<string, unknown>) {
    return {
        content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
        structuredContent: value,
    };
}

export function trimmed(value: string | undefined): string | null {
    return value?.trim() || null;
}
