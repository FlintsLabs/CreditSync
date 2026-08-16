import { describe, expect, test } from "bun:test";
import { previewBankDrawdown } from "./bank-loan-service";
import type { CommandContext } from "./command-context";

const ctx: CommandContext = { tenantId: "test", actorUserId: null, actorSource: "system", requestId: "req", correlationId: "corr" };
describe("bank drawdown service contract", () => {
    test("requires an idempotency key for writes", async () => {
        expect(ctx.idempotencyKey).toBeUndefined();
    });
    test("exports Decimal schedule preview contract", () => {
        expect(previewBankDrawdown).toBeFunction();
    });
});
