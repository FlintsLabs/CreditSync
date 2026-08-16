import { describe, expect, test } from "bun:test";
import { advertisedMcpToolMetadata } from "./server";

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
    test("advertises closed schemas and confirmation-gated destructive commands", async () => {
        const tools = new Map<string, ReturnType<typeof advertisedMcpToolMetadata>[number]>(
            advertisedMcpToolMetadata().map((tool) => [tool.name, tool]),
        );
        for (const name of expected) {
            const tool = tools.get(name);
            expect(tool, name).toBeDefined();
            expect(tool?.inputSchema).toMatchObject({ additionalProperties: false });
            expect(tool?.outputSchema).toMatchObject({ additionalProperties: false });
        }
        for (const name of [
            "loan.commission-participant.add", "loan.commission-participant.update",
            "loan.commission-participant.end", "loan.commission.reverse",
            "payment.intermediary-attribution.create", "payment.intermediary-attribution.reverse",
        ]) {
            const tool = tools.get(name)!;
            expect(tool.annotations).toMatchObject({ destructiveHint: true, openWorldHint: false });
            expect((tool.inputSchema.required as string[])).toContain("confirmed");
            expect((tool.inputSchema.required as string[])).toContain("idempotencyKey");
        }
        expect((tools.get("loan.commission.reverse")!.inputSchema.required as string[])).toContain("reason");
        expect((tools.get("payment.intermediary-attribution.reverse")!.inputSchema.required as string[])).toContain("reason");
    });
});
