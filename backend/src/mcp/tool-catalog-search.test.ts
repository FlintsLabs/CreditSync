import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
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
        const expected: (typeof traversed)[number]["toolName"][] = [];
        let expectedPage = searchToolCatalog({ query: "payment", limit: 10 }, ctx);
        expected.push(...expectedPage.matches.map((match) => match.toolName));
        while (expectedPage.hasMore) {
            expectedPage = searchToolCatalog({ query: "payment", limit: 10, cursor: expectedPage.nextCursor! }, ctx);
            expected.push(...expectedPage.matches.map((match) => match.toolName));
        }
        expect(traversed.map((match) => match.toolName)).toEqual(expected);
        expect(page.hasMore).toBe(false);
        expect(searchToolCatalog({ query: "intake", cursor: first.nextCursor! }, ctx).status).toBe("refresh_required");
        expect(searchToolCatalog({ query: "payment", cursor: first.nextCursor!, knownCatalogVersion: "stale" }, ctx).status).toBe("refresh_required");
        expect(searchToolCatalog({ query: "payment", cursor: "bad!" }, ctx).status).toBe("refresh_required");
        expect(searchToolCatalog({ query: "payment", cursor: "" }, ctx).status).toBe("refresh_required");
        expect(searchToolCatalog({ query: "payment", cursor: first.nextCursor!, knownGuidanceVersion: "stale" }, ctx).status).toBe("refresh_required");
        expect(searchToolCatalog({ query: "payment", cursor: first.nextCursor! }, { ...ctx, profile: "core-read" }).status).toBe("refresh_required");
        const cursorPayload = JSON.parse(Buffer.from(first.nextCursor!, "base64url").toString("utf8"));
        cursorPayload.o = 10001;
        expect(searchToolCatalog({ query: "payment", cursor: Buffer.from(JSON.stringify(cursorPayload)).toString("base64url") }, ctx).status).toBe("refresh_required");
        cursorPayload.o = Number.MAX_SAFE_INTEGER + 1;
        expect(searchToolCatalog({ query: "payment", cursor: Buffer.from(JSON.stringify(cursorPayload)).toString("base64url") }, ctx).status).toBe("refresh_required");
        cursorPayload.o = 0;
        cursorPayload.unexpected = true;
        expect(searchToolCatalog({ query: "payment", cursor: Buffer.from(JSON.stringify(cursorPayload)).toString("base64url") }, ctx).status).toBe("refresh_required");
    });
    it("does not reveal matches that exist only on another profile", () => {
        const discovery = { ...ctx, profile: "core-read" as const };
        const result = searchToolCatalog({ query: "สร้างผู้กู้ borrower.create" }, discovery);
        expect(result).toMatchObject({ status: "connection_required", matches: [] });
        expect(result.requiredProfiles).toContain("admin");
    });
    it("rejects empty and oversized queries and accepts both limit boundaries", () => {
        expect(() => searchToolCatalog({ query: "" }, ctx)).toThrow();
        expect(() => searchToolCatalog({ query: "x".repeat(241) }, ctx)).toThrow();
        expect(searchToolCatalog({ query: "payment", limit: 1 }, ctx).matches).toHaveLength(1);
        expect(searchToolCatalog({ query: "payment", limit: 10 }, ctx).matches.length).toBeLessThanOrEqual(10);
    });
    it("refreshes for offsets at or beyond the ranked result length", () => {
        const query = "borrower.search";
        const digest = createHash("sha256").update(query).digest("hex").slice(0, 20);
        const cursor = Buffer.from(JSON.stringify({ q: digest, p: "full", c: "cat-v1", g: TOOL_GUIDANCE_VERSION, o: 1 })).toString("base64url");
        const singleResult = { ...ctx, catalog: catalog.filter((tool) => tool.name === "borrower.search") };
        expect(searchToolCatalog({ query, cursor }, singleResult).status).toBe("refresh_required");
    });
    it("distinguishes high-risk capability phrases and keeps Thai unspaced queries useful", () => {
        expect(searchToolCatalog({ query: "วันชำระงวดแรก" }, ctx).matches[0]?.toolName).toBe("loan.payment-start-date.update");
        expect(searchToolCatalog({ query: "payment evidence" }, ctx).matches[0]?.toolName).toBe("payment.evidence-supplement.import-chatgpt-file");
        expect(searchToolCatalog({ query: "payout evidence" }, ctx).matches[0]?.toolName).toBe("loan.disbursement.evidence.import-chatgpt-file");
        expect(searchToolCatalog({ query: "restore reversed payment" }, ctx).matches.map((m) => m.toolName)).toContain("payment.restore.create");
        expect(searchToolCatalog({ query: "replace cancelled payment" }, ctx).matches.map((m) => m.toolName)).toContain("payment.replacement.create");
        const cancellation = searchToolCatalog({ query: "cancel loan" }, ctx);
        expect(cancellation.status).toBe("needs_clarification");
        expect(cancellation.matches.map((m) => m.toolName)).toContain("loan.cancel.preview");
        expect(cancellation.matches.map((m) => m.toolName)).toContain("loan.cancel.execute");
    });
});
