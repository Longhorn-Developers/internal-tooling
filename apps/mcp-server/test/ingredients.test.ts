import { describe, expect, it } from "vite-plus/test";

import { AVOID_INGREDIENTS, hasAvoided, implausible } from "../src/tools/dining/extract";

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

    // "1 1/2 oz" must not re-anchor on the fraction and lose the whole number:
    // that under-reads the serving and fires the guard on a label that is fine.
    it.each([
        ["12 oz", 340.2],
        ["3.5 oz", 99.2],
        ["1/2 oz", 14.2],
        ["1 1/2 oz", 42.5],
        ["2 1/4 oz", 63.8],
        ["1-1/2 oz", 42.5],
        // UT prints this on about ninety rows a week; it means ounces.
        ["4 ozL", 113.4],
    ])("reads %s as %s grams", (servingSize, grams) => {
        // Fat just over the serving weight flags; just under does not, which
        // pins the parsed weight from both sides.
        expect(implausible({ servingSize, fat: grams + 1 })).toMatch(/fat/);
        expect(implausible({ servingSize, fat: grams - 1 })).toBeUndefined();
    });

    it("reads a serving given in grams", () => {
        expect(implausible({ servingSize: "85 g", fat: 90, calories: 897 })).toMatch(/fat/);
    });

    // A serving with no weight -- UT prints a bare "Serving size" on every cake
    // -- left both weight rules blind, so a 140 cal dessert carrying 22.1 g of
    // fat (199 cal of fat on its own) went out unflagged.
    it.each([
        [{ servingSize: "Serving size", calories: 140, fat: 22.1 }, true],
        [{ servingSize: "Serving size", calories: 0, fat: 3.9 }, true],
        [{ calories: 18, fat: 4.5 }, true],
        // Legitimate, and within the rounding UT prints at.
        [{ servingSize: "Serving size", calories: 100, fat: 11 }, false],
        [{ servingSize: "1 each", calories: 897, fat: 89.7 }, false],
        // Fat under a gram cannot say anything about a small calorie figure.
        [{ servingSize: "Serving size", calories: 1, fat: 0.5 }, false],
    ])("weighs fat against the calorie figure: %j", (macros, flagged) => {
        const verdict = implausible(macros);
        if (flagged) expect(verdict).toMatch(/calorie figure/);
        else expect(verdict).toBeUndefined();
    });

    // The panel's own macros imply a calorie figure. Parslied Noodles prints 18
    // calories over 7.3g protein, 40.8g carbs and 4.5g fat, which is 233, and
    // no weight rule can see it because "4 oz" makes that serving look fine.
    it.each([
        [{ servingSize: "4 oz", calories: 18, protein: 7.3, carbs: 40.8, fat: 4.5 }, true],
        [{ servingSize: "1 each", calories: 172, protein: 4, carbs: 8, fat: 3 }, true],
        // Printed higher than the macros allow is just as wrong as lower.
        [{ servingSize: "1 each", calories: 120, protein: 2, carbs: 8, fat: 0.5 }, true],
        // Ordinary labels, including ones where rounding leaves a small gap.
        [{ servingSize: "4 oz", calories: 200, protein: 10, carbs: 20, fat: 8 }, false],
        [{ servingSize: "1 each", calories: 897, protein: 22.4, carbs: 0, fat: 89.7 }, false],
        // A small absolute gap on a small figure is rounding, not a defect.
        [{ servingSize: "1 each", calories: 60, protein: 1, carbs: 2, fat: 4 }, false],
    ])("checks the macros against the calorie figure: %j", (macros, flagged) => {
        const verdict = implausible(macros);
        if (flagged) expect(verdict).toBeDefined();
        else expect(verdict).toBeUndefined();
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
