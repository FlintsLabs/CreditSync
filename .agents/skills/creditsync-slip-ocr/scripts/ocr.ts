// Thai payment-slip OCR helper for the creditsync-slip-ocr skill.
// Usage: bun scripts/ocr.ts <image-path>
// Output: JSON to stdout with full-image text plus zoomed crops of the
// date/sender/receiver regions (small fonts misread badly at full scale).
// Dependencies are installed on first run into ~/.cache/creditsync-slip-ocr.
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const cache = join(homedir(), ".cache", "creditsync-slip-ocr");
mkdirSync(cache, { recursive: true });

let createWorker: any;
let sharp: any;
try {
    ({ createWorker } = await import("tesseract.js"));
    sharp = (await import("sharp")).default;
} catch {
    const proc = Bun.spawnSync(["bun", "add", "--cwd", cache, "tesseract.js", "sharp"], { stdout: "inherit", stderr: "inherit" });
    if (proc.exitCode !== 0) throw new Error("failed to install OCR dependencies into " + cache);
    const mod = (p: string) => import(`file://${p}`);
    ({ createWorker } = await mod(join(cache, "node_modules", "tesseract.js")));
    sharp = (await mod(join(cache, "node_modules", "sharp"))).default;
}

const image = process.argv[2];
if (!image) {
    console.error("usage: bun ocr.ts <image-path>");
    process.exit(1);
}

// Regions as fractions of width/height, tuned on 660x874 K+ PromptPay slips.
const CROPS: Array<[name: string, left: number, top: number, width: number, height: number]> = [
    ["date", 0.05, 0.02, 0.9, 0.12],
    ["sender", 0.05, 0.10, 0.9, 0.28],
    ["receiver", 0.05, 0.28, 0.95, 0.62],
];

const meta = await sharp(image).metadata();
const worker = await createWorker("tha", 1, { logger: () => {} });

async function ocr(path: string): Promise<string> {
    const { data } = await worker.recognize(path);
    return data.text.trim();
}

const result: Record<string, string> = { full: await ocr(image) };
for (const [name, l, t, w, h] of CROPS) {
    const out = join(cache, `${name}.jpg`);
    // Clamp to image bounds — LINE album exports vary in aspect ratio.
    const left = Math.min(Math.round(l * meta.width!), meta.width! - 1);
    const top = Math.min(Math.round(t * meta.height!), meta.height! - 1);
    const width = Math.min(Math.round(w * meta.width!), meta.width! - left);
    const height = Math.min(Math.round(h * meta.height!), meta.height! - top);
    await sharp(image)
        .extract({ left, top, width, height })
        .resize({ width: width * 4, kernel: "lanczos3" })
        .sharpen()
        .greyscale()
        .normalize()
        .jpeg({ quality: 95 })
        .toFile(out);
    result[name] = await ocr(out);
}
await worker.terminate();
console.log(JSON.stringify(result, null, 1));
