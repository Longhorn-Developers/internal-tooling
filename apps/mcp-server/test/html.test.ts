import { describe, expect, it } from "vite-plus/test";
import { decode, norm, text } from "../src/lib/html";

describe("decode", () => {
    it("decodes named, decimal and hex entities", () => {
        expect(decode("Tom &amp; Jerry")).toBe("Tom & Jerry");
        expect(decode("caf&eacute;")).toBe("café");
        expect(decode("&#65;&#66;")).toBe("AB");
        expect(decode("&#x41;&#x42;")).toBe("AB");
    });

    it("turns &nbsp; into a normal space", () => {
        expect(decode("a&nbsp;b")).toBe("a b");
    });

    it("leaves an unknown entity alone rather than dropping it", () => {
        expect(decode("&notareal;")).toBe("&notareal;");
    });

    it("handles the apostrophes UT actually publishes", () => {
        expect(decode("Hook &#039;em")).toBe("Hook 'em");
        expect(decode("Jesta&rsquo; Pizza")).toBe("Jesta’ Pizza");
    });
});

describe("text", () => {
    it("strips tags and collapses whitespace", () => {
        expect(text("<p>  hello   <b>world</b>  </p>")).toBe("hello world");
    });

    it("drops script and style content entirely", () => {
        expect(text('<div>keep<script>var x = "<b>drop</b>";</script></div>')).toBe("keep");
        expect(text("<style>.a{color:red}</style><p>keep</p>")).toBe("keep");
    });

    it("separates block elements with the given separator", () => {
        expect(text("<div>a</div><div>b</div>", "|")).toBe("a|b");
        expect(text("a<br>b", "|")).toBe("a|b");
    });

    it("drops empty blocks instead of emitting blank entries", () => {
        expect(text("<div>a</div><div>  </div><div>b</div>", "|")).toBe("a|b");
    });

    it("decodes entities after stripping tags", () => {
        expect(text("<td>Tom &amp; Jerry&nbsp;</td>")).toBe("Tom & Jerry");
    });

    it("survives attributes containing angle brackets in content", () => {
        expect(text('<a href="/x" title="a > b">link</a>')).toBe("link");
    });

    it("returns an empty string for markup with no text", () => {
        expect(text("<div><span></span></div>")).toBe("");
    });
});

describe("norm", () => {
    it("ignores case, spacing and punctuation", () => {
        expect(norm("C S")).toBe(norm("cs"));
        expect(norm("Kin's Market")).toBe(norm("kins market"));
        expect(norm("Chick-fil-A (WCP)")).toBe("chickfilawcp");
    });

    it("folds accents so names match either way", () => {
        expect(norm("Sabor Tacos y Más")).toBe(norm("sabor tacos y mas"));
    });

    it("keeps digits, which course codes depend on", () => {
        expect(norm("C S 429H")).toBe("cs429h");
    });
});
