import { describe, expect, it } from "vitest";
import { formatDeploymentTimestamp, isValidDeploymentTimestamp, parseDeploymentMetadata } from "./deployment";

describe("deployment metadata", () => {
    it("accepts valid ISO timestamps and rejects missing or invalid values", () => {
        expect(isValidDeploymentTimestamp("2026-09-10T17:30:00Z")).toBe(true);
        expect(isValidDeploymentTimestamp("2026-09-10T17:30:00+00:00")).toBe(true);
        expect(isValidDeploymentTimestamp("")).toBe(false);
        expect(isValidDeploymentTimestamp("not-a-timestamp")).toBe(false);
        expect(isValidDeploymentTimestamp("2026-02-30T17:30:00Z")).toBe(false);
        expect(parseDeploymentMetadata({ timestamp: "not-a-timestamp" })).toBeNull();
        expect(parseDeploymentMetadata({})).toBeNull();
    });

    it("formats the instant in Bangkok time without changing the source ISO value", () => {
        const timestamp = "2026-09-10T17:30:00Z";
        const formatted = formatDeploymentTimestamp(timestamp, "en");

        expect(formatted).toContain("September 11, 2026");
        expect(formatted).toContain("12:30 AM");
        expect(formatted).toContain("UTC+7");
    });

    it("formats Thai and English using the same Bangkok instant near UTC midnight", () => {
        const timestamp = "2026-09-10T23:30:00Z";

        expect(formatDeploymentTimestamp(timestamp, "en")).toContain("September 11, 2026");
        expect(formatDeploymentTimestamp(timestamp, "th")).toContain("11 กันยายน 2569");
    });
});
