import Decimal from "decimal.js";

export type FloatingIntegrityAccrual = {
    id: number;
    publicId: string;
    accrualDate: string;
    interestAmount: string;
    paidAmount: string;
    status: string;
    periodUnit: string | null;
    periodDays: number | null;
};

export type FloatingIntegrityAllocation = {
    id: number;
    publicId: string;
    interestAccrualId: number | null;
    dueDate: string;
    effectiveDate: string;
    amount: string;
    entryType: string;
    reversedAllocationId: number | null;
};

export type FloatingAllocationIssue = {
    code: "ACCRUAL_OVERALLOCATED" | "ACCRUAL_PAID_OVER_LIMIT" | "ALLOCATION_AFTER_ACCRUAL_FILLED" | "REVERSED_ACCRUAL_TARGET";
    accrualPublicId: string;
    accrualDate: string;
    allocationPublicId?: string;
    netAllocatedAmount?: string;
    interestAmount?: string;
    paidAmount?: string;
    dueDate?: string;
};

export function findFloatingAllocationIssues(input: {
    accruals: FloatingIntegrityAccrual[];
    allocations: FloatingIntegrityAllocation[];
}): FloatingAllocationIssue[] {
    const issues: FloatingAllocationIssue[] = [];
    const accrualById = new Map(input.accruals.map((row) => [row.id, row]));
    const reversedIds = new Set(input.allocations.filter((row) => row.reversedAllocationId !== null).map((row) => row.reversedAllocationId!));
    const active = input.allocations.filter((row) => row.entryType === "payment" && !reversedIds.has(row.id))
        .sort((left, right) => left.effectiveDate.localeCompare(right.effectiveDate) || left.id - right.id);
    const totals = new Map<number, Decimal>();
    for (const row of active) {
        if (row.interestAccrualId === null) continue;
        const accrual = accrualById.get(row.interestAccrualId);
        const prior = totals.get(row.interestAccrualId) ?? new Decimal(0);
        if (accrual && prior.gte(accrual.interestAmount)) {
            issues.push({ code: "ALLOCATION_AFTER_ACCRUAL_FILLED", accrualPublicId: accrual.publicId, accrualDate: accrual.accrualDate, allocationPublicId: row.publicId, netAllocatedAmount: prior.plus(row.amount).toFixed(2), interestAmount: new Decimal(accrual.interestAmount).toFixed(2) });
        }
        totals.set(row.interestAccrualId, prior.plus(row.amount));
    }
    for (const accrual of input.accruals) {
        const allocated = totals.get(accrual.id) ?? new Decimal(0);
        if (allocated.gt(accrual.interestAmount)) issues.unshift({ code: "ACCRUAL_OVERALLOCATED", accrualPublicId: accrual.publicId, accrualDate: accrual.accrualDate, netAllocatedAmount: allocated.toFixed(2), interestAmount: new Decimal(accrual.interestAmount).toFixed(2) });
        if (new Decimal(accrual.paidAmount).gt(accrual.interestAmount)) issues.push({ code: "ACCRUAL_PAID_OVER_LIMIT", accrualPublicId: accrual.publicId, accrualDate: accrual.accrualDate, paidAmount: new Decimal(accrual.paidAmount).toFixed(2), interestAmount: new Decimal(accrual.interestAmount).toFixed(2) });
        if (accrual.status === "reversed" && allocated.gt(0)) issues.push({ code: "REVERSED_ACCRUAL_TARGET", accrualPublicId: accrual.publicId, accrualDate: accrual.accrualDate, netAllocatedAmount: allocated.toFixed(2) });
    }
    return issues;
}
