import { describe, expect, it } from "vite-plus/test";

import { AVOID_INGREDIENTS, hasAvoided, implausible } from "../src/lib/dining";

/**
 * These guard the regex escapes as much as the logic. An editing slip turned
 * every \b in this file into a literal backspace byte, which left the patterns
 * compiling, matching nothing, and filtering nothing -- with the tests still
 * green because nothing asserted on a word boundary.
 */
describe("ingredient preferences", () => {
    it.each([
        ["Potatoes, canola oil, salt", "seed-oils", true],
        ["Potatoes, olive oil, sea salt", "seed-oils", false],
        ["Water, soybean oil, sugar", "seed-oils", true],
        ["Sugar, gelatin, water", "gelatin", true],
        ["Sugar, congelatinized starch", "gelatin", false],
        ["Corn syrup, high fructose corn syrup", "hfcs", true],
        ["Corn syrup, sugar", "hfcs", false],
        ["Salt, monosodium glutamate", "msg", true],
        ["Palm oil, flour", "palm-oil", true],
        // Found on the live feed: the plant-based cheeses say "Palm Fruit Oil",
        // which is exactly what someone avoiding palm oil is looking for.
        ["Water, palm fruit oil, starch", "palm-oil", true],
        ["Flour, corn oil, salt", "seed-oils", true],
        ["Flour, vegetable shortening, sugar", "seed-oils", true],
        // Corn, but not an oil: the point is a named term, not a substring.
        ["Corn, water, salt", "seed-oils", false],
    ])("%s against %s", (ingredients, key, expected) => {
        expect(hasAvoided(ingredients, key)).toBe(expected);
    });

    it("matches nothing for an unknown key", () => {
        expect(hasAvoided("canola oil", "not-a-key")).toBe(false);
    });

    it("every pattern is free of control characters", () => {
        for (const [key, { test }] of Object.entries(AVOID_INGREDIENTS)) {
            const codes = Array.from({ length: test.source.length }, (_, i) =>
                test.source.charCodeAt(i),
            );
            const bad = codes.find((code) => code < 0x20);
            expect(bad, `${key} contains a control character`).toBeUndefined();
        }
    });
});

describe("implausible nutrition", () => {
    // UT publishes 897 cal and 89.7g of fat for a 3 oz serving of bacon: 3 oz is
    // 85g, so the fat alone outweighs the food.
    it("flags more fat than the serving weighs", () => {
        expect(implausible({ servingSize: "3 oz", fat: 89.7, calories: 897 })).toMatch(/fat/);
    });

    // "1/2 oz" was matching the denominator, so half an ounce was read as two
    // and the serving looked four times heavier than it is.
    it("reads a fractional ounce serving as the fraction", () => {
        expect(implausible({ servingSize: "1/2 oz", fat: 20, calories: 200 })).toMatch(/fat/);
        expect(implausible({ servingSize: "1/2 oz", fat: 5, calories: 50 })).toBeUndefined();
    });

    it("reads a serving given in grams", () => {
        expect(implausible({ servingSize: "85 g", fat: 90, calories: 897 })).toMatch(/fat/);
    });

    it("flags more calories than pure fat of that weight", () => {
        expect(implausible({ servingSize: "1 oz", calories: 400 })).toMatch(/calories/);
    });

    it.each([
        [{ servingSize: "4 oz", fat: 3, calories: 120 }],
        [{ servingSize: "3 oz", fat: 10, calories: 200 }],
        [{ fat: 89.7, calories: 897 }], // no serving size: nothing to compare against
        [{ servingSize: "1 serving", calories: 400 }], // unitless
    ])("passes %j", (macros) => {
        expect(implausible(macros)).toBeUndefined();
    });
});
