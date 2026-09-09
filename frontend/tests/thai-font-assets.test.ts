import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const stylesheet = readFileSync(resolve(root, "src/index.css"), "utf8");
const fonts = [
    ["Sarabun-Regular.woff2", 400],
    ["Sarabun-Medium.woff2", 500],
    ["Sarabun-SemiBold.woff2", 600],
    ["Sarabun-Bold.woff2", 700],
] as const;

describe("Thai Sarabun font assets", () => {
    it.each(fonts)("ships valid local %s for weight %i", (filename, weight) => {
        const asset = readFileSync(resolve(root, "src/assets/fonts", filename));
        expect(asset.subarray(0, 4).toString("ascii")).toBe("wOF2");
        expect(stylesheet).toContain(`url("./assets/fonts/${filename}") format("woff2")`);
        expect(stylesheet).toMatch(new RegExp(`font-family:\\s*"Sarabun";[\\s\\S]*?font-weight:\\s*${weight};`));
    });

    it("keeps the redistributable font license beside the assets", () => {
        const license = readFileSync(resolve(root, "src/assets/fonts/OFL.txt"), "utf8");
        expect(license).toContain("SIL OPEN FONT LICENSE Version 1.1");
    });

    it("uses Sarabun only for the Thai document language", () => {
        expect(stylesheet).toMatch(/html:lang\(th\) body\s*\{[^}]*font-family:\s*"Sarabun"/s);
        expect(stylesheet).not.toMatch(/html:lang\(en\)[^{]*\{[^}]*"Sarabun"/s);
        expect(stylesheet.match(/font-display:\s*swap;/g)).toHaveLength(4);
    });
});
