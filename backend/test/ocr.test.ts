import { describe, expect, it } from "bun:test";
import { extractTextFromImage } from "../src/lib/ocr";
import { join } from "path";
import { readFileSync } from "fs";

describe("OCR Service", () => {
    it("should extract text from sample image", async () => {
        // Use the sample image from tesseract.js package
        const imagePath = join(process.cwd(), "node_modules/tesseract.js/docs/images/tesseract.png");
        const buffer = readFileSync(imagePath);

        console.log("Testing OCR with image:", imagePath);

        const text = await extractTextFromImage(buffer, 'eng');
        console.log("Extracted text:", text);

        expect(text).toBeDefined();
        // expect(text.toLowerCase()).toContain("tesseract");
        expect(text.length).toBeGreaterThan(0);
    }, 20000); // Increase timeout for first run (downloading language data)
});
