import { FinancialDecimal } from "../lib/financial-decimal";

export type ReflowTransactionComponents = {
    principal: string;
    interest: string;
    fee: string;
    penalty: string;
};

export type ReflowSourceAllocation = {
    allocationPublicId: string;
    loanPublicId: string;
    transactionPublicId: string;
    accrualPublicId: string | null;
    effectiveDate: string;
    dueDate: string;
    amount: string;
    component: "interest" | "penalty";
    entryType: "payment" | "reversal";
    reversed: boolean;
    transactionComponents: ReflowTransactionComponents;
};

export type ReflowReplacement = {
    accrualPublicId: string | null;
    dueDate: string;
    amount: string;
};

export type TemporalReflowPlan = {
    effectiveAfterDate: string;
    displacedTotal: string;
    replacementTotal: string;
    transactions: Array<{
        transactionPublicId: string;
        effectiveDate: string;
        displacedAmount: string;
        before: Array<{ allocationPublicId: string; accrualPublicId: string; dueDate: string; amount: string }>;
        after: Array<{ accrualPublicId: string; dueDate: string; amount: string }>;
        conserved: true;
    }>;
};

function money(value: string) {
    const parsed = new FinancialDecimal(value);
    if (!parsed.isFinite() || parsed.decimalPlaces() > 2 || parsed.lt(0)) throw new Error("TEMPORAL_REFLOW_INVALID_AMOUNT");
    return parsed;
}

/**
 * Validates the authoritative replacement projection produced by the existing
 * floating-interest allocator. This kernel deliberately does not calculate
 * rates, periods, or rounding.
 */
export function buildTemporalReflowPlan(input: {
    effectiveAfterDate: string;
    allocations: ReflowSourceAllocation[];
    replacements: Record<string, ReflowReplacement[]>;
}): TemporalReflowPlan {
    const selected = input.allocations
        .filter((row) => row.effectiveDate > input.effectiveAfterDate)
        .sort((left, right) => left.loanPublicId.localeCompare(right.loanPublicId)
            || left.effectiveDate.localeCompare(right.effectiveDate)
            || left.transactionPublicId.localeCompare(right.transactionPublicId)
            || left.allocationPublicId.localeCompare(right.allocationPublicId));
    const grouped = new Map<string, ReflowSourceAllocation[]>();
    for (const row of selected) {
        if (!row.allocationPublicId || !row.loanPublicId || !row.transactionPublicId || !row.accrualPublicId) throw new Error("TEMPORAL_REFLOW_PROVENANCE_INCOMPLETE");
        if (row.entryType !== "payment" || row.reversed || !money(row.amount).gt(0)) continue;
        if (row.component !== "interest") throw new Error("TEMPORAL_REFLOW_UNSUPPORTED_COMPONENT");
        const components = row.transactionComponents;
        if ([components.principal, components.fee, components.penalty].some((value) => !money(value).isZero())) throw new Error("TEMPORAL_REFLOW_UNSUPPORTED_COMPONENT");
        grouped.set(row.transactionPublicId, [...(grouped.get(row.transactionPublicId) ?? []), row]);
    }
    let displacedTotal = new FinancialDecimal(0);
    let replacementTotal = new FinancialDecimal(0);
    const transactions: TemporalReflowPlan["transactions"] = [];
    for (const [transactionPublicId, rows] of [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right))) {
        const displacedAmount = rows.reduce((sum, row) => sum.plus(money(row.amount)), new FinancialDecimal(0));
        const replacements = input.replacements[transactionPublicId] ?? [];
        if (replacements.some((row) => !row.accrualPublicId || !row.dueDate || !money(row.amount).gt(0))) throw new Error("TEMPORAL_REFLOW_PROVENANCE_INCOMPLETE");
        const replacementAmount = replacements.reduce((sum, row) => sum.plus(money(row.amount)), new FinancialDecimal(0));
        if (!replacementAmount.eq(displacedAmount)) throw new Error("TEMPORAL_REFLOW_AMOUNT_VARIANCE");
        displacedTotal = displacedTotal.plus(displacedAmount);
        replacementTotal = replacementTotal.plus(replacementAmount);
        transactions.push({
            transactionPublicId,
            effectiveDate: rows[0]!.effectiveDate,
            displacedAmount: displacedAmount.toFixed(2),
            before: rows.map((row) => ({ allocationPublicId: row.allocationPublicId, accrualPublicId: row.accrualPublicId!, dueDate: row.dueDate, amount: money(row.amount).toFixed(2) })),
            after: replacements.map((row) => ({ accrualPublicId: row.accrualPublicId!, dueDate: row.dueDate, amount: money(row.amount).toFixed(2) })),
            conserved: true,
        });
    }
    return { effectiveAfterDate: input.effectiveAfterDate, displacedTotal: displacedTotal.toFixed(2), replacementTotal: replacementTotal.toFixed(2), transactions };
}
