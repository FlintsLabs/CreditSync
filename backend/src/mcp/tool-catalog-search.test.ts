import { describe, expect, it } from "bun:test";
import { searchToolCatalog } from "./tool-catalog-search";
import { advertisedMcpToolMetadataForProfile } from "./server";
import { TOOL_GUIDANCE_VERSION } from "./tool-guidance";
const catalog = advertisedMcpToolMetadataForProfile("full");
const ctx = { profile: "full" as const, catalogVersion: "cat-v1", guidanceVersion: TOOL_GUIDANCE_VERSION, catalog };
describe("tool catalog search", () => {
    it("ranks exact names and curated Thai/English phrases", () => {
        expect(searchToolCatalog({ query: "loan.payment-start-date.update" }, ctx).matches[0]?.toolName).toBe("loan.payment-start-date.update");
        expect(searchToolCatalog({ query: "เปลี่ยนวันชำระงวดแรก" }, ctx).matches[0]?.toolName).toBe("loan.payment-start-date.update");
        expect(searchToolCatalog({ query: "ค้นหาผู้กู้" }, ctx).matches[0]?.toolName).toBe("borrower.search");
        expect(searchToolCatalog({ query: "แนบสลิปการชำระ" }, ctx).matches[0]?.toolName).toBe("payment.evidence-supplement.import-chatgpt-file");
        expect(searchToolCatalog({ query: "หลักฐานการจ่ายเงินกู้" }, ctx).matches[0]?.toolName).toBe("loan.disbursement.evidence.import-chatgpt-file");
        expect(searchToolCatalog({ query: "พรีวิวค่าคอมมิชชัน" }, ctx).matches[0]?.toolName).toBe("loan.commission.preview");
        expect(searchToolCatalog({ query: "แทนรายการที่ยกเลิก" }, ctx).matches.map((m) => m.toolName)).toContain("payment.replacement.create");
    });
    it("keeps ambiguous capabilities and unknown requests safe", () => {
        expect(searchToolCatalog({ query: "payment" }, ctx).status).toBe("needs_clarification");
        expect(searchToolCatalog({ query: "spaceship telemetry" }, ctx)).toMatchObject({ status: "no_match", matches: [] });
    });
    it("validates limits and bounds complete cursor traversal to snapshot", () => {
        expect(() => searchToolCatalog({ query: "payment", limit: 11 }, ctx)).toThrow();
        expect(() => searchToolCatalog({ query: "   " }, ctx)).toThrow();
        expect(() => searchToolCatalog({ query: "x".repeat(241) }, ctx)).toThrow();
        expect(searchToolCatalog({ query: "payment", limit: 1 }, ctx).matches).toHaveLength(1);
        expect(searchToolCatalog({ query: "payment", limit: 10 }, ctx).matches.length).toBeLessThanOrEqual(10);
        expect(searchToolCatalog({ query: "payment", limit: 2 }, ctx).matches).toEqual(searchToolCatalog({ query: "payment", limit: 2 }, ctx).matches);
        const first = searchToolCatalog({ query: "payment", limit: 2 }, ctx);
        expect(first.hasMore).toBe(true);
        const second = searchToolCatalog({ query: "payment", limit: 2, cursor: first.nextCursor! }, ctx);
        expect(second.matches[0]?.toolName).not.toBe(first.matches[0]?.toolName);
        const traversed = [...first.matches, ...second.matches];
        let page = second;
        while (page.hasMore) {
            page = searchToolCatalog({ query: "payment", limit: 2, cursor: page.nextCursor! }, ctx);
            traversed.push(...page.matches);
        }
        expect(new Set(traversed.map((match) => match.toolName)).size).toBe(traversed.length);
        expect(page.hasMore).toBe(false);
        expect(searchToolCatalog({ query: "intake", cursor: first.nextCursor! }, ctx).status).toBe("refresh_required");
        expect(searchToolCatalog({ query: "payment", cursor: first.nextCursor!, knownCatalogVersion: "stale" }, ctx).status).toBe("refresh_required");
        expect(searchToolCatalog({ query: "payment", cursor: "bad!" }, ctx).status).toBe("refresh_required");
        expect(searchToolCatalog({ query: "payment", cursor: first.nextCursor!, knownGuidanceVersion: "stale" }, ctx).status).toBe("refresh_required");
        expect(searchToolCatalog({ query: "payment", cursor: first.nextCursor! }, { ...ctx, profile: "core-read" }).status).toBe("refresh_required");
        const cursorPayload = JSON.parse(Buffer.from(first.nextCursor!, "base64url").toString("utf8"));
        cursorPayload.o = 10001;
        expect(searchToolCatalog({ query: "payment", cursor: Buffer.from(JSON.stringify(cursorPayload)).toString("base64url") }, ctx).status).toBe("refresh_required");
    });
    it("does not reveal matches that exist only on another profile", () => {
        const discovery = { ...ctx, profile: "core-read" as const };
        const result = searchToolCatalog({ query: "สร้างผู้กู้ borrower.create" }, discovery);
        expect(result).toMatchObject({ status: "connection_required", matches: [] });
        expect(result.requiredProfiles).toContain("admin");
    });
});
