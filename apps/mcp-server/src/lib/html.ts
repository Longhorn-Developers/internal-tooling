const NAMED: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    ndash: "–",
    mdash: "—",
    rsquo: "’",
    lsquo: "‘",
    rdquo: "”",
    ldquo: "“",
    hellip: "…",
    eacute: "é",
    aacute: "á",
    iacute: "í",
    oacute: "ó",
    uacute: "ú",
    ntilde: "ñ",
    copy: "©",
    reg: "®",
    trade: "™",
};

export function decode(s: string): string {
    return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
        if (e[0] === "#") {
            const n =
                e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
            // Past U+10FFFF fromCodePoint throws, which would abort the whole
            // page parse over one bad entity in third-party markup.
            return Number.isFinite(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
        }
        return NAMED[e.toLowerCase()] ?? m;
    });
}

/**
 * Remove tags, keeping the text between them. Scans linearly rather than using
 * a regex, so a `>` inside a quoted attribute does not end the tag early and
 * there is no backtracking to blow up on.
 */
function stripTags(html: string): string {
    let out = "";
    let i = 0;
    while (i < html.length) {
        const lt = html.indexOf("<", i);
        if (lt < 0) return out + html.slice(i);
        out += html.slice(i, lt);

        if (html.startsWith("<!--", lt)) {
            const end = html.indexOf("-->", lt + 4);
            if (end < 0) return out;
            i = end + 3;
            continue;
        }

        // A `<` that cannot start a tag is literal text. Without this, a stray
        // "a < b" would open quote tracking on the next apostrophe and swallow
        // the rest of the fragment.
        if (!/[a-zA-Z/!?]/.test(html[lt + 1] ?? "")) {
            out += "<";
            i = lt + 1;
            continue;
        }

        let j = lt + 1;
        let quote = "";
        for (; j < html.length; j++) {
            const ch = html[j]!;
            if (quote) {
                if (ch === quote) quote = "";
            } else if (ch === '"' || ch === "'") {
                quote = ch;
            } else if (ch === ">") {
                break;
            }
        }
        if (j >= html.length) return out; // unterminated tag: drop the remainder
        i = j + 1;
    }
    return out;
}

/** Strip tags, decode entities, collapse whitespace. `<br>` and block ends become `sep`. */
export function text(html: string, sep = " "): string {
    return decode(
        stripTags(
            html
                .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
                .replace(/<br\s*\/?>|<\/(div|p|li|tr)>/gi, "\u0000"),
        ),
    )
        .replace(/�/g, "")
        .split("\u0000")
        .map((part) => part.replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .join(sep);
}

/** Lowercase alphanumerics only, for fuzzy name matching. */
export function norm(s: string): string {
    return s
        .toLowerCase()
        .normalize("NFD")
        .replace(/[^a-z0-9]/g, "");
}
