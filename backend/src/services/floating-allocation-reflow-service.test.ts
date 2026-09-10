import { describe, expect, test } from "bun:test";
import { buildTemporalReflowPlan, type ReflowSourceAllocation } from "./floating-allocation-reflow-service";

const source = (overrides: Partial<ReflowSourceAllocation> = {}): ReflowSourceAllocation => ({
    allocationPublicId: "alloc-later",
    loanPublicId: "loan-1",
    transactionPublicId: "tx-later",
    accrualPublicId: "accrual-04",
    effectiveDate: "2026-09-05",
    dueDate: "2026-09-04",
    amount: "30.00",
    component: "interest",
    entryType: "payment",
    reversed: false,
    transactionComponents: { principal: "0.00", interest: "30.00", fee: "0.00", penalty: "0.00" },
    ...overrides,
});

describe("floating temporal reflow kernel", () => {
    test("builds an exact interest-only later-allocation replacement plan", () => {
        const plan = buildTemporalReflowPlan({
            effectiveAfterDate: "2026-09-04",
            allocations: [source()],
            replacements: { "tx-later": [{ accrualPublicId: "accrual-05", dueDate: "2026-09-05", amount: "30.00" }] },
        });
        expect(plan).toEqual({
            effectiveAfterDate: "2026-09-04",
            displacedTotal: "30.00",
            replacementTotal: "30.00",
            transactions: [{
                transactionPublicId: "tx-later",
                effectiveDate: "2026-09-05",
                displacedAmount: "30.00",
                before: [{ allocationPublicId: "alloc-later", accrualPublicId: "accrual-04", dueDate: "2026-09-04", amount: "30.00" }],
                after: [{ accrualPublicId: "accrual-05", dueDate: "2026-09-05", amount: "30.00" }],
                conserved: true,
            }],
        });
    });

    test("fails closed for unsupported components, missing provenance, and variance", () => {
        expect(() => buildTemporalReflowPlan({ effectiveAfterDate: "2026-09-04", allocations: [source({ transactionComponents: { principal: "1.00", interest: "29.00", fee: "0.00", penalty: "0.00" } })], replacements: { "tx-later": [] } })).toThrow("TEMPORAL_REFLOW_UNSUPPORTED_COMPONENT");
        expect(() => buildTemporalReflowPlan({ effectiveAfterDate: "2026-09-04", allocations: [source({ allocationPublicId: "" })], replacements: { "tx-later": [] } })).toThrow("TEMPORAL_REFLOW_PROVENANCE_INCOMPLETE");
        expect(() => buildTemporalReflowPlan({ effectiveAfterDate: "2026-09-04", allocations: [source()], replacements: { "tx-later": [{ accrualPublicId: "accrual-05", dueDate: "2026-09-05", amount: "29.99" }] } })).toThrow("TEMPORAL_REFLOW_AMOUNT_VARIANCE");
    });

    test("orders by loan, effective date, transaction, and excludes reversed or boundary rows", () => {
        const plan = buildTemporalReflowPlan({
            effectiveAfterDate: "2026-09-04",
            allocations: [
                source({ allocationPublicId: "z", transactionPublicId: "tx-z", accrualPublicId: "a-z" }),
                source({ allocationPublicId: "reversed", transactionPublicId: "tx-reversed", accrualPublicId: "a-r", reversed: true }),
                source({ allocationPublicId: "boundary", transactionPublicId: "tx-boundary", effectiveDate: "2026-09-04", accrualPublicId: "a-b" }),
                source({ allocationPublicId: "a", transactionPublicId: "tx-a", accrualPublicId: "a-a", loanPublicId: "loan-0" }),
            ],
            replacements: {
                "tx-z": [{ accrualPublicId: "a-z2", dueDate: "2026-09-05", amount: "30.00" }],
                "tx-a": [{ accrualPublicId: "a-a2", dueDate: "2026-09-05", amount: "30.00" }],
            },
        });
        expect(plan.transactions.map((row) => row.transactionPublicId)).toEqual(["tx-a", "tx-z"]);
        expect(plan.displacedTotal).toBe("60.00");
    });

    test("conserves exact decimal strings beyond JavaScript safe integer range", () => {
        const amount = "9007199254740991.99";
        const plan = buildTemporalReflowPlan({
            effectiveAfterDate: "2026-09-04",
            allocations: [source({ amount })],
            replacements: { "tx-later": [{ accrualPublicId: "accrual-05", dueDate: "2026-09-05", amount }] },
        });
        expect(plan.displacedTotal).toBe(amount);
        expect(plan.replacementTotal).toBe(amount);
    });
});
