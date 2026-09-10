import { describe, expect, test } from "bun:test";
import { findFloatingAllocationIssues } from "./floating-allocation-integrity";

describe("floating allocation integrity", () => {
    test("detects an active daily allocation pointing at the previous accrual date", () => {
        const issues = findFloatingAllocationIssues({
            accruals: [
                { id: 1, publicId: "accrual-04", accrualDate: "2026-09-04", interestAmount: "45.00", paidAmount: "90.00", status: "paid", periodUnit: "day", periodDays: 1 },
                { id: 2, publicId: "accrual-05", accrualDate: "2026-09-05", interestAmount: "45.00", paidAmount: "0.00", status: "accrued", periodUnit: "day", periodDays: 1 },
            ],
            allocations: [
                { id: 11, publicId: "allocation-04", interestAccrualId: 1, dueDate: "2026-09-04", effectiveDate: "2026-09-04", amount: "45.00", entryType: "payment", reversedAllocationId: null },
                { id: 12, publicId: "allocation-05", interestAccrualId: 1, dueDate: "2026-09-04", effectiveDate: "2026-09-05", amount: "45.00", entryType: "payment", reversedAllocationId: null },
            ],
        });

        expect(issues.map((issue) => issue.code)).toEqual(["ACCRUAL_OVERALLOCATED", "ALLOCATION_AFTER_ACCRUAL_FILLED", "ACCRUAL_PAID_OVER_LIMIT"]);
        expect(issues[0]?.netAllocatedAmount).toBe("90.00");
        expect(issues[1]?.allocationPublicId).toBe("allocation-05");
    });

    test("does not flag a weekly period-end due date or a fully reversed allocation", () => {
        expect(findFloatingAllocationIssues({
            accruals: [{ id: 1, publicId: "accrual", accrualDate: "2026-09-04", interestAmount: "100.00", paidAmount: "100.00", status: "paid", periodUnit: "week", periodDays: 7 }],
            allocations: [
                { id: 11, publicId: "allocation", interestAccrualId: 1, dueDate: "2026-09-10", effectiveDate: "2026-09-10", amount: "100.00", entryType: "payment", reversedAllocationId: null },
                { id: 12, publicId: "reversal", interestAccrualId: 1, dueDate: "2026-09-10", effectiveDate: "2026-09-10", amount: "-100.00", entryType: "reversal", reversedAllocationId: 11 },
            ],
        })).toEqual([]);
    });
});
