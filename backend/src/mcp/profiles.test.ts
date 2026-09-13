import { describe, expect, test } from "bun:test";
import { advertisedMcpToolMetadata, MCP_CATALOG_VERSION, MCP_TOOL_NAMES } from "./server";
import { TOOL_PROFILES, toolsForProfile, toolNamesForProfile } from "./tool-profiles";

const catalog = advertisedMcpToolMetadata();
const catalogByName = new Map(catalog.map((tool) => [tool.name, tool]));

describe("MCP catalog and profiles", () => {
    test("has one canonical definition for every current tool", () => {
        expect(MCP_TOOL_NAMES).toEqual(expect.arrayContaining([
            "loan.disbursement.evidence.import-chatgpt-file", "borrower.resolve-and-portfolio",
            "loan.inspect-context", "payment.match-context",
        ]));
        expect(new Set(MCP_TOOL_NAMES).size).toBe(MCP_TOOL_NAMES.length);
        expect(catalog).toHaveLength(MCP_TOOL_NAMES.length);
        expect(catalog.map((tool) => tool.name)).toEqual([...MCP_TOOL_NAMES]);
        expect(MCP_CATALOG_VERSION).toMatch(/^mcp-catalog-[0-9a-f]{16}$/);
    });

    test("profile snapshots are exact, closed, and cover the full catalog", () => {
        const union = new Set<string>();
        for (const [profile, names] of Object.entries(TOOL_PROFILES)) {
            expect(new Set(names).size).toBe(names.length);
            for (const name of names) {
                expect(catalogByName.has(name)).toBe(true);
                if (profile !== "full") union.add(name);
            }
            expect(toolsForProfile(profile as keyof typeof TOOL_PROFILES, catalog).map((tool) => tool.name)).toEqual([...names]);
            expect(toolNamesForProfile(profile as keyof typeof TOOL_PROFILES)).toEqual([...names]);
        }
        expect([...union].sort()).toEqual([...MCP_TOOL_NAMES].sort());
    });

    test("curated profiles contain the dependencies of their representative workflows", () => {
        const has = (profile: keyof typeof TOOL_PROFILES, ...names: string[]) => {
            const available = new Set<string>(toolNamesForProfile(profile));
            for (const name of names) expect(available.has(name)).toBe(true);
        };
        has("payments", "intake.get", "intake.create", "evidence.prepare", "evidence.finalize", "payment.preview", "payment.post", "payment.reverse");
        has("loans", "borrower.search", "loan.preview", "loan.draft", "loan.activate", "loan.disbursement.draft", "loan.disbursement.evidence.prepare", "loan.disbursement.evidence.finalize", "loan.disbursement.evidence.import-chatgpt-file");
        has("disbursements", "loan.disbursement.list", "loan.disbursement.draft", "loan.disbursement.evidence.prepare", "loan.disbursement.evidence.finalize", "loan.disbursement.post", "loan.disbursement.reverse", "intermediary.disbursement.preview", "intermediary.disbursement.post");
        has("admin", "system.error-diagnostic.get", "system.error-diagnostic.list", "funding-source.list", "funding-allocation.list", "loan.commission.list", "loan.commission.calculate");
        has("core-read", "borrower.search", "borrower.portfolio", "intake.get", "loan.contract.get", "loan.payment-history.list", "loan.disbursement.list", "system.error-diagnostic.list");
    });

    test("core-read cannot expose mutation or open-world imports", () => {
        for (const tool of toolsForProfile("core-read", catalog)) {
            expect(tool.annotations.readOnlyHint).toBe(true);
            expect(tool.annotations.destructiveHint).toBe(false);
            expect(tool.policy.kind).toBe("read_only");
            expect(tool.policy.requiresAudit).toBe(false);
            expect(tool.annotations.openWorldHint).toBe(false);
        }
        expect(toolNamesForProfile("core-read")).not.toContain("evidence.import-chatgpt-file");
        expect(toolNamesForProfile("core-read")).not.toContain("payment.post");
    });

    test("financial and external-import metadata remain explicit", () => {
        const financialNames = catalog.filter((tool) => tool.policy.requiresAudit).map((tool) => tool.name);
        expect(financialNames).toContain("payment.reconcile.reflow.execute");
        for (const tool of catalog) {
            expect(tool.annotations.readOnlyHint && tool.annotations.destructiveHint).toBe(false);
            if (tool.policy.requiresAudit) {
                expect(tool.policy.kind).toBe("financial");
                expect(tool.annotations.destructiveHint).toBe(true);
                expect(tool.annotations.idempotentHint).toBe(true);
            }
        }
        for (const name of [
            "evidence.import-chatgpt-file",
            "loan.disbursement.evidence.import-chatgpt-file",
            "payment.evidence-supplement.import-chatgpt-file",
        ] as const) {
            const tool = catalogByName.get(name)!;
            expect(tool.annotations.openWorldHint).toBe(true);
            expect(tool.annotations.destructiveHint).toBe(true);
        }
    });
});
