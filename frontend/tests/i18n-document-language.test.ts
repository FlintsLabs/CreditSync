import { afterEach, beforeEach, describe, expect, it } from "vitest";
import i18n from "../src/lib/i18n";

describe("i18n document language", () => {
    beforeEach(async () => {
        await i18n.changeLanguage("en");
    });

    afterEach(async () => {
        await i18n.changeLanguage("en");
    });

    it("reflects the initially resolved language on the root element", () => {
        expect(i18n.resolvedLanguage).toBe("en");
        expect(document.documentElement.lang).toBe("en");
    });

    it("updates the normalized root language when the app language changes", async () => {
        await i18n.changeLanguage("th-TH");

        expect(i18n.resolvedLanguage?.startsWith("th")).toBe(true);
        expect(document.documentElement.lang).toBe("th");

        await i18n.changeLanguage("en-US");
        expect(document.documentElement.lang).toBe("en");
    });
});
