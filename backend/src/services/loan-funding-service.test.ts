import { describe, expect, test } from "bun:test";
import { createFundingAllocation, listLoanFundingAllocations, previewFundingAllocation } from "./loan-funding-service";
import type { CommandContext } from "./command-context";

const integrationTest = process.env.TEST_DATABASE_URL ? test : test.skip;
const ctx: CommandContext = { tenantId: "funding-test", actorUserId: null, actorSource: "web", requestId: "req", correlationId: "corr", idempotencyKey: "allocation-1" };

describe("loan funding allocation service", () => {
    test("exports the preview, create, and list command contract", () => {
        expect(previewFundingAllocation).toBeFunction();
        expect(createFundingAllocation).toBeFunction();
        expect(listLoanFundingAllocations).toBeFunction();
    });

    test("requires a positive exact money amount before database work", async () => {
        await expect(createFundingAllocation(ctx, { loanPublicId: "loan", bankProfilePublicId: "profile", allocatedAmount: "0.00", allocationDate: "2026-08-16" })).rejects.toMatchObject({ code: "INVALID_MONEY" });
    });

    integrationTest("requires an idempotency key for an allocation command", async () => {
        await expect(createFundingAllocation({ ...ctx, idempotencyKey: undefined, actorUserId: 1 }, { loanPublicId: "missing", bankProfilePublicId: "missing", allocatedAmount: "1.00", allocationDate: "2026-08-16" })).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REQUIRED" });
    });
});
