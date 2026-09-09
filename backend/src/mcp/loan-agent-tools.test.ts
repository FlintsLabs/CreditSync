import { describe, expect, test } from "bun:test";
import { advertisedMcpToolMetadata } from "./server";
import { createDefaultMcpToolHandlers } from "./default";

const expected = [
    "loan.commission-participant.list",
    "loan.commission-participant.add",
    "loan.commission-participant.update",
    "loan.commission-participant.end",
    "loan.commission.preview",
    "loan.commission.list",
    "loan.commission.calculate",
    "loan.commission.reverse",
    "payment.intermediary-attribution.create",
    "payment.intermediary-attribution.list",
    "payment.intermediary-attribution.reverse",
];

describe("loan agent MCP contracts", () => {
    test("advertises closed schemas and honest write versus preview boundaries", async () => {
        const tools = new Map<string, ReturnType<typeof advertisedMcpToolMetadata>[number]>(
            advertisedMcpToolMetadata().map((tool) => [tool.name, tool]),
        );
        const handlers = createDefaultMcpToolHandlers();
        for (const name of expected) {
            const tool = tools.get(name);
            expect(tool, name).toBeDefined();
            expect(tool?.inputSchema).toMatchObject({ additionalProperties: false });
            expect(tool?.outputSchema).toMatchObject({ additionalProperties: false });
            expect(typeof handlers[name as keyof typeof handlers]).toBe("function");
        }
        for (const name of [
            "loan.commission-participant.add", "loan.commission-participant.update",
            "loan.commission-participant.end",
            "payment.intermediary-attribution.create", "payment.intermediary-attribution.reverse",
        ]) {
            const tool = tools.get(name)!;
            expect(tool.annotations).toMatchObject({ destructiveHint: true, openWorldHint: false });
            expect((tool.inputSchema.required as string[])).toContain("confirmed");
            expect((tool.inputSchema.required as string[])).toContain("idempotencyKey");
        }
        const commissionReversalPreview = tools.get("loan.commission.reverse")!;
        expect(commissionReversalPreview.annotations).toMatchObject({
            readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false,
        });
        expect(commissionReversalPreview.inputSchema).toMatchObject({
            additionalProperties: false,
            required: ["loanPublicId", "paymentPublicIds"],
        });
        expect(commissionReversalPreview.inputSchema.properties).not.toHaveProperty("confirmed");
        expect(commissionReversalPreview.inputSchema.properties).not.toHaveProperty("reason");
        expect(commissionReversalPreview.inputSchema.properties).not.toHaveProperty("idempotencyKey");
        expect(commissionReversalPreview.outputSchema.properties).not.toHaveProperty("auditPublicIds");
        expect(commissionReversalPreview.outputSchema.properties).not.toHaveProperty("correlationId");
        expect(commissionReversalPreview.description).toContain("never writes financial records or returns audit identifiers");
        expect(commissionReversalPreview.description).toContain("Preview");
        expect((tools.get("payment.intermediary-attribution.reverse")!.inputSchema.required as string[])).toContain("reason");
    });
});
