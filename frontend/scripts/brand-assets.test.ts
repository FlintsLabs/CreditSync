import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const frontendRoot = join(import.meta.dir, "..");
const publicDir = join(frontendRoot, "public");

const expectedPngDimensions = new Map<string, readonly [number, number]>([
    ["favicon-16x16.png", [16, 16]],
    ["favicon-32x32.png", [32, 32]],
    ["apple-touch-icon.png", [180, 180]],
    ["pwa-192x192.png", [192, 192]],
    ["pwa-512x512.png", [512, 512]],
]);

function readPngDimensions(buffer: Buffer): readonly [number, number] {
    const pngSignature = "89504e470d0a1a0a";

    expect(buffer.subarray(0, 8).toString("hex")).toBe(pngSignature);
    expect(buffer.subarray(12, 16).toString("ascii")).toBe("IHDR");

    return [buffer.readUInt32BE(16), buffer.readUInt32BE(20)];
}

describe("CreditSync brand assets", () => {
    test("the SVG contains the approved Connected Capital palette and geometry", async () => {
        const svg = await readFile(join(publicDir, "favicon.svg"), "utf8");

        expect(svg).toContain("CreditSync Connected Capital icon");
        expect(svg).toContain("#070B1A");
        expect(svg).toContain("#22D3EE");
        expect(svg).toContain("#8B5CF6");
        expect(svg).toContain("#D946EF");
        expect(svg).toContain("#F8FAFC");
        expect(svg).toContain('id="detail-spokes"');
    });

    test("the PNG exports have their declared dimensions", async () => {
        for (const [fileName, dimensions] of expectedPngDimensions) {
            const png = await readFile(join(publicDir, fileName));
            expect(readPngDimensions(png)).toEqual(dimensions);
        }
    });

    test("the web manifest declares CreditSync and its PWA icons", async () => {
        const manifest = JSON.parse(
            await readFile(join(publicDir, "site.webmanifest"), "utf8"),
        ) as {
            name: string;
            short_name: string;
            start_url: string;
            display: string;
            theme_color: string;
            background_color: string;
            icons: Array<{ src: string; sizes: string; type: string }>;
        };

        expect(manifest.name).toBe("CreditSync");
        expect(manifest.short_name).toBe("CreditSync");
        expect(manifest.start_url).toBe("/");
        expect(manifest.display).toBe("standalone");
        expect(manifest.theme_color).toBe("#070B1A");
        expect(manifest.background_color).toBe("#070B1A");
        expect(manifest.icons).toEqual([
            { src: "/pwa-192x192.png", sizes: "192x192", type: "image/png" },
            { src: "/pwa-512x512.png", sizes: "512x512", type: "image/png" },
        ]);
    });

    test("the HTML advertises every browser-facing brand asset", async () => {
        const html = await readFile(join(frontendRoot, "index.html"), "utf8");

        expect(html).toContain('href="/favicon.svg"');
        expect(html).toContain('href="/favicon-32x32.png"');
        expect(html).toContain('href="/favicon-16x16.png"');
        expect(html).toContain('href="/apple-touch-icon.png"');
        expect(html).toContain('href="/site.webmanifest"');
        expect(html).toContain('name="theme-color" content="#070B1A"');
        expect(html).not.toContain("/vite.svg");
    });
});
