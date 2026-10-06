import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { MCP_TOOL_NAMES } from "./catalog-types";
import { advertisedMcpToolMetadata } from "./server";
import {
    MCP_SERVER_INSTRUCTIONS,
    TOOL_GUIDANCE,
    TOOL_GUIDANCE_VERSION,
    describeTool,
    hashGuidanceContent,
} from "./tool-guidance";

describe("MCP tool guidance registry", () => {
    test("covers every serving tool with bounded, typed guidance", () => {
        expect(Object.keys(TOOL_GUIDANCE).sort()).toEqual([...MCP_TOOL_NAMES].sort());
        for (const name of MCP_TOOL_NAMES) {
            const guidance = TOOL_GUIDANCE[name];
            expect(guidance.purpose.length).toBeGreaterThan(20);
            expect(guidance.whenToUse.length).toBeGreaterThan(0);
            expect(guidance.whenToUse.length).toBeLessThanOrEqual(8);
            expect(guidance.prerequisites.length).toBeLessThanOrEqual(8);
            expect(guidance.sideEffects.length).toBeLessThanOrEqual(8);
            expect(guidance.commonErrors.length).toBeLessThanOrEqual(8);
            expect(guidance.relatedTools.length).toBeLessThanOrEqual(8);
            expect(guidance.searchTerms.en.length).toBeGreaterThan(0);
            expect(guidance.searchTerms.th.length).toBeGreaterThan(0);
            for (const text of [...guidance.whenToUse, ...guidance.prerequisites, ...guidance.sideEffects]) {
                expect(text.length).toBeLessThanOrEqual(320);
            }
            for (const related of guidance.relatedTools) expect(MCP_TOOL_NAMES).toContain(related);
        }
    });

    test("descriptions and instructions are deterministic and bounded", () => {
        expect(TOOL_GUIDANCE_VERSION).toMatch(/^mcp-guidance-[a-f0-9]{16}$/);
        expect(Object.isFrozen(TOOL_GUIDANCE)).toBe(true);
        expect(Object.isFrozen(TOOL_GUIDANCE["borrower.search"])).toBe(true);
        expect(Object.isFrozen(TOOL_GUIDANCE["borrower.search"].searchTerms)).toBe(true);
        expect(Object.isFrozen(TOOL_GUIDANCE["borrower.search"].searchTerms.en)).toBe(true);
        expect(MCP_SERVER_INSTRUCTIONS).toContain("tool.catalog.search");
        expect(MCP_SERVER_INSTRUCTIONS).toContain("workflow.resolve");
        expect(describeTool("borrower.search")).toContain(TOOL_GUIDANCE["borrower.search"].purpose);
        for (const name of MCP_TOOL_NAMES) expect(describeTool(name).length).toBeLessThanOrEqual(1_800);
        const reordered = Object.fromEntries(Object.entries(TOOL_GUIDANCE).reverse());
        const canonical = JSON.stringify(Object.fromEntries(MCP_TOOL_NAMES.map((name) => [name, TOOL_GUIDANCE[name]])));
        const reorderedCanonical = JSON.stringify(Object.fromEntries(MCP_TOOL_NAMES.map((name) => [name, reordered[name as keyof typeof reordered]])));
        expect(createHash("sha256").update(canonical).digest("hex")).toBe(createHash("sha256").update(reorderedCanonical).digest("hex"));
        expect(hashGuidanceContent(TOOL_GUIDANCE)).toBe(hashGuidanceContent(reordered));
        expect(hashGuidanceContent({ purpose: "meaningful change" })).not.toBe(hashGuidanceContent({ purpose: "other meaning" }));
        for (const tool of advertisedMcpToolMetadata()) expect(tool.description).toBe(describeTool(tool.name));
    });

    test("preserves high-risk distinctions instead of inferring from suffixes", () => {
        expect(TOOL_GUIDANCE["loan.commission.reverse"].sideEffects).toEqual([]);
        expect(TOOL_GUIDANCE["loan.commission.reverse"].requiresHumanConfirmation).toBe(false);
        expect(TOOL_GUIDANCE["payment.preview"].sideEffects.join(" ")).toMatch(/persist/i);
        expect(TOOL_GUIDANCE["loan.settlement.preview"].sideEffects.join(" ")).toMatch(/persist/i);
        expect(TOOL_GUIDANCE["loan.cancel.preview"].sideEffects).toEqual([]);
        expect(TOOL_GUIDANCE["funding-allocation.preview"].sideEffects).toEqual([]);
        expect(TOOL_GUIDANCE["payment.restore.create"].prerequisites.join(" ")).toMatch(/reversed/i);
        expect(TOOL_GUIDANCE["payment.replacement.create"].prerequisites.join(" ")).toMatch(/cancelled|canceled/i);
        expect(TOOL_GUIDANCE["payment.restore.create"].searchTerms.th).not.toEqual(TOOL_GUIDANCE["payment.replacement.create"].searchTerms.th);
    });

    test("describes retries, approval boundaries, conditional inputs, and related workflows accurately", () => {
        expect(TOOL_GUIDANCE["loan.commission.reverse"].retrySafety).not.toMatch(/same idempotency key/i);
        expect(TOOL_GUIDANCE["loan.commission.reverse"].retrySafety).toMatch(/identical valid arguments/i);
        expect(TOOL_GUIDANCE["payment.preview"].requiresHumanConfirmation).toBe(false);
        expect(TOOL_GUIDANCE["payment.preview"].sideEffects.join(" ")).toMatch(/persist/i);
        expect(TOOL_GUIDANCE["payment.post"].requiresHumanConfirmation).toBe(true);
        expect(TOOL_GUIDANCE["loan.commission.reverse"].relatedTools).toContain("loan.commission.calculate");
        expect(TOOL_GUIDANCE["loan.commission.reverse"].relatedTools).not.toContain("loan.disbursement.evidence.import-chatgpt-file");
        expect(TOOL_GUIDANCE["borrower.resolve-and-portfolio"].prerequisites.join(" ")).toMatch(/exactly one.*query.*borrowerPublicId/i);
        expect(TOOL_GUIDANCE["borrower.alias"].prerequisites.join(" ")).toMatch(/add.*borrowerPublicId.*alias/i);
        expect(TOOL_GUIDANCE["borrower.alias"].prerequisites.join(" ")).toMatch(/confirm.*deactivate.*aliasPublicId/i);
        for (const name of MCP_TOOL_NAMES) expect(TOOL_GUIDANCE[name].commonErrors.length).toBeGreaterThan(0);
    });

    test("reports side effects consistently with the serving catalog policy", () => {
        for (const tool of advertisedMcpToolMetadata()) {
            expect(TOOL_GUIDANCE[tool.name].sideEffects.length === 0).toBe(tool.policy.kind === "read_only");
            if (tool.policy.kind === "read_only") expect(TOOL_GUIDANCE[tool.name].requiresHumanConfirmation).toBe(false);
        }
    });
});
