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
        loanPublicId: string;
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
    const seenSources = new Set<string>();
    for (const row of selected) {
        if (!row.allocationPublicId || !row.loanPublicId || !row.transactionPublicId || !row.accrualPublicId) throw new Error("TEMPORAL_REFLOW_PROVENANCE_INCOMPLETE");
        if (seenSources.has(row.allocationPublicId)) throw new Error("TEMPORAL_REFLOW_DUPLICATE_SOURCE");
        seenSources.add(row.allocationPublicId);
        if (row.entryType !== "payment" || row.reversed) continue;
        if (row.component !== "interest") throw new Error("TEMPORAL_REFLOW_UNSUPPORTED_COMPONENT");
        const amount = money(row.amount);
        if (!amount.gt(0)) continue;
        const components = row.transactionComponents;
        if ([components.principal, components.fee, components.penalty].some((value) => !money(value).isZero())) throw new Error("TEMPORAL_REFLOW_UNSUPPORTED_COMPONENT");
        const prior = grouped.get(row.transactionPublicId)?.[0];
        if (prior && (prior.loanPublicId !== row.loanPublicId || prior.effectiveDate !== row.effectiveDate || JSON.stringify(prior.transactionComponents) !== JSON.stringify(components))) throw new Error("TEMPORAL_REFLOW_TRANSACTION_INCONSISTENT");
        grouped.set(row.transactionPublicId, [...(grouped.get(row.transactionPublicId) ?? []), row]);
    }
    let displacedTotal = new FinancialDecimal(0);
    let replacementTotal = new FinancialDecimal(0);
    const transactions: TemporalReflowPlan["transactions"] = [];
    for (const [transactionPublicId, rows] of [...grouped.entries()].sort(([, left], [, right]) => left[0]!.loanPublicId.localeCompare(right[0]!.loanPublicId)
        || left[0]!.effectiveDate.localeCompare(right[0]!.effectiveDate)
        || left[0]!.transactionPublicId.localeCompare(right[0]!.transactionPublicId))) {
        const displacedAmount = rows.reduce((sum, row) => sum.plus(money(row.amount)), new FinancialDecimal(0));
        const declaredInterest = money(rows[0]!.transactionComponents.interest);
        if (!declaredInterest.eq(displacedAmount)) throw new Error("TEMPORAL_REFLOW_PROVENANCE_INCOMPLETE");
        const replacements = input.replacements[transactionPublicId] ?? [];
        if (replacements.some((row) => !row.accrualPublicId || !row.dueDate || !money(row.amount).gt(0))) throw new Error("TEMPORAL_REFLOW_PROVENANCE_INCOMPLETE");
        const replacementAmount = replacements.reduce((sum, row) => sum.plus(money(row.amount)), new FinancialDecimal(0));
        if (!replacementAmount.eq(displacedAmount)) throw new Error("TEMPORAL_REFLOW_AMOUNT_VARIANCE");
        displacedTotal = displacedTotal.plus(displacedAmount);
        replacementTotal = replacementTotal.plus(replacementAmount);
        transactions.push({
            transactionPublicId,
            loanPublicId: rows[0]!.loanPublicId,
            effectiveDate: rows[0]!.effectiveDate,
            displacedAmount: displacedAmount.toFixed(2),
            before: rows.map((row) => ({ allocationPublicId: row.allocationPublicId, accrualPublicId: row.accrualPublicId!, dueDate: row.dueDate, amount: money(row.amount).toFixed(2) })),
            after: replacements.map((row) => ({ accrualPublicId: row.accrualPublicId!, dueDate: row.dueDate, amount: money(row.amount).toFixed(2) })),
            conserved: true,
        });
    }
    return { effectiveAfterDate: input.effectiveAfterDate, displacedTotal: displacedTotal.toFixed(2), replacementTotal: replacementTotal.toFixed(2), transactions };
}

/**
 * Adapter used by reconciliation preview/execute. The callback is the
 * existing authoritative floating allocator; callers must not pass a fuzzy
 * or UI-derived replacement projection at the financial boundary.
 */
export async function buildTemporalReflowPlanWithAuthoritativeResolver(input: {
    effectiveAfterDate: string;
    allocations: ReflowSourceAllocation[];
    resolveReplacement: (input: { loanPublicId: string; transactionPublicId: string; effectiveDate: string; requestedAmount: string }) => Promise<ReflowReplacement[]>;
}): Promise<TemporalReflowPlan> {
    const selected = input.allocations.filter((row) => row.effectiveDate > input.effectiveAfterDate && row.entryType === "payment" && !row.reversed && row.component === "interest");
    const byTransaction = new Map<string, ReflowSourceAllocation[]>();
    for (const row of selected) byTransaction.set(row.transactionPublicId, [...(byTransaction.get(row.transactionPublicId) ?? []), row]);
    const replacements: Record<string, ReflowReplacement[]> = {};
    for (const [transactionPublicId, rows] of byTransaction) {
        const requestedAmount = rows.reduce((sum, row) => sum.plus(money(row.amount)), new FinancialDecimal(0)).toFixed(2);
        replacements[transactionPublicId] = await input.resolveReplacement({ loanPublicId: rows[0]!.loanPublicId, transactionPublicId, effectiveDate: rows[0]!.effectiveDate, requestedAmount });
    }
    return buildTemporalReflowPlan({ effectiveAfterDate: input.effectiveAfterDate, allocations: input.allocations, replacements });
}
