import { describe, expect, test } from "bun:test";
import { extractTextFromImage } from "./ocr";

describe("OCR worker lifecycle", () => {
    test("terminates the worker when recognition fails", async () => {
        let terminated = false;
        await expect(extractTextFromImage(
            Buffer.from("synthetic"),
            "eng",
            async () => ({
                recognize: async () => { throw new Error("synthetic recognition failure"); },
                terminate: async () => { terminated = true; },
            }),
        )).rejects.toThrow("synthetic recognition failure");
        expect(terminated).toBe(true);
    });
});
