import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const stylesheetPath = resolve(process.cwd(), "src/index.css");
const stylesheet = readFileSync(stylesheetPath, "utf8");
const darkBlock = stylesheet.match(/\.dark\s*\{([\s\S]*?)\n\s*\}/)?.[1] ?? "";

function token(name: string) {
    const value = darkBlock.match(new RegExp(`--${name}:\\s*([^;]+);`))?.[1]?.trim();
    expect(value, `missing --${name} in the dark theme`).toBeDefined();
    return value as string;
}

function lightness(value: string) {
    const match = value.match(/(-?\d+(?:\.\d+)?)%\s*$/);
    expect(match, `expected an HSL percentage in ${value}`).not.toBeNull();
    return Number(match?.[1]);
}

describe("dark theme surface hierarchy", () => {
    it("keeps persistent surfaces visibly above the canvas", () => {
        expect(lightness(token("card"))).toBeGreaterThan(lightness(token("background")));
        expect(lightness(token("popover"))).toBeGreaterThan(lightness(token("background")));
    });

    it("keeps nested surfaces visibly above persistent surfaces", () => {
        expect(lightness(token("secondary"))).toBeGreaterThan(lightness(token("card")));
        expect(lightness(token("muted"))).toBeGreaterThan(lightness(token("card")));
        expect(lightness(token("accent"))).toBeGreaterThan(lightness(token("card")));
    });

    it("uses stronger boundaries than the nested surfaces", () => {
        expect(lightness(token("border"))).toBeGreaterThan(lightness(token("muted")));
        expect(lightness(token("input"))).toBeGreaterThan(lightness(token("muted")));
    });
});
