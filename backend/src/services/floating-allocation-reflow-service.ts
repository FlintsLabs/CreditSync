import { FinancialDecimal } from "../lib/financial-decimal";
import { and, eq, inArray, sql } from "drizzle-orm";
import { floatingTransactionAllocations, loanInterestAccruals, loans, transactions } from "../db/schema";
import type { CommandContext } from "./command-context";
import { resolveFloatingInterestAllocationPlan, type FloatingPaymentProjection } from "./floating-interest-service";

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

function validatedSourceGroups(input: { effectiveAfterDate: string; allocations: ReflowSourceAllocation[] }) {
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
    for (const rows of grouped.values()) {
        const displaced = rows.reduce((sum, row) => sum.plus(money(row.amount)), new FinancialDecimal(0));
        if (!money(rows[0]!.transactionComponents.interest).eq(displaced)) throw new Error("TEMPORAL_REFLOW_PROVENANCE_INCOMPLETE");
    }
    return grouped;
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
    const grouped = validatedSourceGroups(input);
    let displacedTotal = new FinancialDecimal(0);
    let replacementTotal = new FinancialDecimal(0);
    const transactions: TemporalReflowPlan["transactions"] = [];
    for (const [transactionPublicId, rows] of [...grouped.entries()].sort(([, left], [, right]) => left[0]!.loanPublicId.localeCompare(right[0]!.loanPublicId)
        || left[0]!.effectiveDate.localeCompare(right[0]!.effectiveDate)
        || left[0]!.transactionPublicId.localeCompare(right[0]!.transactionPublicId))) {
        const displacedAmount = rows.reduce((sum, row) => sum.plus(money(row.amount)), new FinancialDecimal(0));
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
    const byTransaction = validatedSourceGroups(input);
    const replacements: Record<string, ReflowReplacement[]> = {};
    for (const [transactionPublicId, rows] of [...byTransaction.entries()].sort(([, left], [, right]) => left[0]!.loanPublicId.localeCompare(right[0]!.loanPublicId)
        || left[0]!.effectiveDate.localeCompare(right[0]!.effectiveDate)
        || left[0]!.transactionPublicId.localeCompare(right[0]!.transactionPublicId))) {
        const requestedAmount = rows.reduce((sum, row) => sum.plus(money(row.amount)), new FinancialDecimal(0)).toFixed(2);
        replacements[transactionPublicId] = await input.resolveReplacement({ loanPublicId: rows[0]!.loanPublicId, transactionPublicId, effectiveDate: rows[0]!.effectiveDate, requestedAmount });
    }
    return buildTemporalReflowPlan({ effectiveAfterDate: input.effectiveAfterDate, allocations: input.allocations, replacements });
}

export type ExecutableReflowSource = ReflowSourceAllocation & {
    allocationId: number;
    loanId: number;
    transactionId: number;
    interestAccrualId: number;
};

export type ExecutableReflowReplacement = ReflowReplacement & { accrualId: number };

export async function loadActiveInterestReflowSources(tx: any, tenantId: string, loanId: number, effectiveAfterDate: string): Promise<ExecutableReflowSource[]> {
    const rows = await tx.select({
        allocation: floatingTransactionAllocations,
        transaction: transactions,
        loan: loans,
        accrual: loanInterestAccruals,
    }).from(floatingTransactionAllocations)
        .innerJoin(transactions, and(eq(transactions.tenantId, tenantId), eq(transactions.id, floatingTransactionAllocations.transactionId), eq(transactions.loanId, loanId)))
        .innerJoin(loans, and(eq(loans.tenantId, tenantId), eq(loans.id, loanId)))
        .innerJoin(loanInterestAccruals, and(eq(loanInterestAccruals.tenantId, tenantId), eq(loanInterestAccruals.loanId, loanId), eq(loanInterestAccruals.id, floatingTransactionAllocations.interestAccrualId)))
        .where(and(
            eq(floatingTransactionAllocations.tenantId, tenantId),
            eq(floatingTransactionAllocations.loanId, loanId),
            eq(floatingTransactionAllocations.component, "interest"),
            eq(floatingTransactionAllocations.entryType, "payment"),
            sql`${floatingTransactionAllocations.effectiveDate} > ${effectiveAfterDate}`,
            sql`NOT EXISTS (SELECT 1 FROM floating_transaction_allocations reversal WHERE reversal.tenant_id = ${tenantId} AND reversal.reversed_allocation_id = ${floatingTransactionAllocations.id})`,
        ))
        .orderBy(floatingTransactionAllocations.effectiveDate, floatingTransactionAllocations.transactionId, floatingTransactionAllocations.allocationOrder, floatingTransactionAllocations.id);
    return rows.map((row: any) => {
        const allocation = row.allocation;
        const transaction = row.transaction;
        if (!allocation.interestAccrualId) throw new Error("TEMPORAL_REFLOW_PROVENANCE_INCOMPLETE");
        return {
            allocationPublicId: allocation.publicId,
            allocationId: allocation.id,
            loanPublicId: row.loan.publicId,
            loanId,
            transactionPublicId: transaction.publicId,
            transactionId: transaction.id,
            accrualPublicId: row.accrual.publicId,
            interestAccrualId: allocation.interestAccrualId,
            effectiveDate: allocation.effectiveDate,
            dueDate: allocation.dueDate,
            amount: allocation.amount,
            component: "interest" as const,
            entryType: "payment" as const,
            reversed: false,
            transactionComponents: {
                principal: transaction.principalComponent,
                interest: transaction.interestComponent,
                fee: transaction.feeComponent,
                penalty: transaction.penaltyComponent,
            },
        };
    });
}

/** Builds a reflow plan by replaying each source through the existing allocator. */
export async function buildTemporalReflowPlanForLoan(tx: any, ctx: CommandContext, loan: typeof loans.$inferSelect, effectiveAfterDate: string, incomingAllocations: FloatingPaymentProjection["allocations"] = []) {
    const sources = await loadActiveInterestReflowSources(tx, ctx.tenantId, loan.id, effectiveAfterDate);
    const negativeProjection: FloatingPaymentProjection["allocations"] = sources.map((source) => ({
        effectiveDate: source.effectiveDate,
        dueDate: source.dueDate,
        accrualDate: source.dueDate,
        component: "interest" as const,
        amount: `-${source.amount}`,
    }));
    const replacements: Record<string, ExecutableReflowReplacement[]> = {};
    const groups = new Map<string, ExecutableReflowSource[]>();
    for (const source of sources) groups.set(source.transactionPublicId, [...(groups.get(source.transactionPublicId) ?? []), source]);
    for (const [transactionPublicId, rows] of [...groups.entries()].sort(([, left], [, right]) => left[0]!.effectiveDate.localeCompare(right[0]!.effectiveDate) || left[0]!.transactionPublicId.localeCompare(right[0]!.transactionPublicId))) {
        const requestedAmount = rows.reduce((sum: any, row) => sum.plus(row.amount), new FinancialDecimal(0)).toFixed(2);
        const authoritative = await resolveFloatingInterestAllocationPlan(tx, loan, new Date(`${rows[0]!.effectiveDate}T16:59:59.999Z`), requestedAmount, ctx, "preview", { principalPayments: [], allocations: [...negativeProjection, ...incomingAllocations] });
        if (!authoritative.provenanceReady) throw new Error("TEMPORAL_REFLOW_PROVENANCE_INCOMPLETE");
        replacements[transactionPublicId] = authoritative.allocations.map((allocation) => ({ accrualId: allocation.accrualId, accrualPublicId: allocation.accrualPublicId, dueDate: allocation.dueDate, amount: allocation.amount }));
    }
    return { plan: buildTemporalReflowPlan({ effectiveAfterDate, allocations: sources, replacements }), sources, replacements };
}

/**
 * Appends signed allocation provenance for an already validated plan. The
 * caller must have produced replacements through the authoritative floating
 * allocator and hold the deterministic borrower/loan/reconciliation locks.
 */
export async function executeTemporalReflow(tx: any, ctx: CommandContext, input: {
    plan: TemporalReflowPlan;
    sources: ExecutableReflowSource[];
    replacements: Record<string, ExecutableReflowReplacement[]>;
    groupId: number;
    auditPublicId: string;
    reason: string;
    idempotencyPrefix: string;
}) {
    const sourceByPublicId = new Map(input.sources.map((source) => [source.allocationPublicId, source]));
    const touchedAccrualIds = new Set<number>();
    const executed: Array<{ sourceAllocationId: number; reversalAllocationId: number; replacementAllocationId: number; replacementTransactionId: number; transactionPublicId: string; displacedAmount: string; oldDueDate: string; newDueDate: string }> = [];
    const reversalTransactions = new Map<number, number>();
    for (const transaction of input.plan.transactions) {
        const before = transaction.before.map((row) => sourceByPublicId.get(row.allocationPublicId));
        if (before.some((row) => !row) || before.length !== transaction.before.length) throw new Error("TEMPORAL_REFLOW_PROVENANCE_INCOMPLETE");
        const rows = before as ExecutableReflowSource[];
        if (rows.some((row) => row.loanPublicId !== transaction.loanPublicId || row.transactionPublicId !== transaction.transactionPublicId || row.effectiveDate !== transaction.effectiveDate)) throw new Error("TEMPORAL_REFLOW_TRANSACTION_INCONSISTENT");
        const transactionRow = await tx.query.transactions.findFirst({ where: and(eq(transactions.tenantId, ctx.tenantId), eq(transactions.id, rows[0]!.transactionId), eq(transactions.loanId, rows[0]!.loanId)) });
        if (!transactionRow || !new FinancialDecimal(transactionRow.principalComponent).isZero() || !new FinancialDecimal(transactionRow.feeComponent).isZero() || !new FinancialDecimal(transactionRow.penaltyComponent).isZero()) throw new Error("TEMPORAL_REFLOW_UNSUPPORTED_COMPONENT");
        const reversalTransactionId = reversalTransactions.get(transactionRow.id) ?? await tx.insert(transactions).values({
            tenantId: ctx.tenantId, ownerUserId: transactionRow.ownerUserId, loanId: transactionRow.loanId, scheduleId: transactionRow.scheduleId,
            amount: `-${transactionRow.amount}`, principalComponent: "0.00", interestComponent: `-${transactionRow.interestComponent}`, feeComponent: "0.00", penaltyComponent: "0.00",
            type: "reversal", transactionDate: transactionRow.transactionDate, recordedByUserId: ctx.actorUserId, paymentIntakeId: transactionRow.paymentIntakeId,
            entryType: "reversal", reversedTransactionId: transactionRow.id, idempotencyKey: `${input.idempotencyPrefix}:transaction-reversal:${transactionRow.id}`, postedAt: new Date(),
        }).returning().then((result: Array<typeof transactions.$inferSelect>) => result[0]!.id);
        reversalTransactions.set(transactionRow.id, reversalTransactionId);
        const replacementTransaction = await tx.insert(transactions).values({
            tenantId: ctx.tenantId, ownerUserId: transactionRow.ownerUserId, loanId: transactionRow.loanId, scheduleId: transactionRow.scheduleId,
            amount: transactionRow.amount, principalComponent: transactionRow.principalComponent, interestComponent: transactionRow.interestComponent,
            feeComponent: transactionRow.feeComponent, penaltyComponent: transactionRow.penaltyComponent, type: "repayment", transactionDate: transactionRow.transactionDate,
            recordedByUserId: ctx.actorUserId, paymentIntakeId: transactionRow.paymentIntakeId, entryType: "repayment",
            idempotencyKey: `${input.idempotencyPrefix}:transaction-replacement:${transactionRow.id}`, postedAt: new Date(),
        }).returning().then((result: Array<typeof transactions.$inferSelect>) => result[0]!);
        const replacements = input.replacements[transaction.transactionPublicId] ?? [];
        const replacementTotal = replacements.reduce((sum, row) => sum.plus(money(row.amount)), new FinancialDecimal(0));
        if (!replacementTotal.eq(transaction.displacedAmount)) throw new Error("TEMPORAL_REFLOW_AMOUNT_VARIANCE");
        const existingOrders = await tx.select({ allocationOrder: floatingTransactionAllocations.allocationOrder }).from(floatingTransactionAllocations).where(and(eq(floatingTransactionAllocations.tenantId, ctx.tenantId), eq(floatingTransactionAllocations.transactionId, replacementTransaction.id))).orderBy(floatingTransactionAllocations.allocationOrder);
        let allocationOrder = Math.max(0, ...existingOrders.map((row: { allocationOrder: number }) => row.allocationOrder));
        let replacementIndex = 0;
        let replacementRemaining = replacements[0] ? money(replacements[0].amount) : new FinancialDecimal(0);
        for (const row of rows) {
            const existingReversal = await tx.query.floatingTransactionAllocations.findFirst({ where: and(eq(floatingTransactionAllocations.tenantId, ctx.tenantId), eq(floatingTransactionAllocations.reversedAllocationId, row.allocationId)) });
            if (existingReversal) throw new Error("TEMPORAL_REFLOW_ALREADY_REVERSED");
            const reversal = await tx.insert(floatingTransactionAllocations).values({ tenantId: ctx.tenantId, loanId: row.loanId, transactionId: reversalTransactionId, dueDate: row.dueDate, component: "interest", interestAccrualId: row.interestAccrualId, effectiveDate: row.effectiveDate, allocationOrder: ++allocationOrder, entryType: "reversal", amount: money(row.amount).negated().toFixed(2), reversedAllocationId: row.allocationId, reason: input.reason, idempotencyKey: `${input.idempotencyPrefix}:reversal:${row.allocationId}`, auditPublicId: input.auditPublicId, actorSource: ctx.actorSource, requestId: ctx.requestId, correlationId: ctx.correlationId, createdByUserId: ctx.actorUserId }).returning().then((result: Array<typeof floatingTransactionAllocations.$inferSelect>) => result[0]!);
            touchedAccrualIds.add(row.interestAccrualId);
            let sourceRemaining = money(row.amount);
            while (sourceRemaining.gt(0)) {
                const replacement = replacements[replacementIndex];
                if (!replacement || !replacement.accrualPublicId || !replacementRemaining.gt(0)) throw new Error("TEMPORAL_REFLOW_PROVENANCE_INCOMPLETE");
                const appliedAmount = FinancialDecimal.min(sourceRemaining, replacementRemaining);
                const replacementRow = await tx.query.loanInterestAccruals.findFirst({ where: and(eq(loanInterestAccruals.tenantId, ctx.tenantId), eq(loanInterestAccruals.id, replacement.accrualId), eq(loanInterestAccruals.loanId, row.loanId)) });
                if (!replacementRow || replacementRow.publicId !== replacement.accrualPublicId) throw new Error("TEMPORAL_REFLOW_PROVENANCE_INCOMPLETE");
                const replacementAllocation = await tx.insert(floatingTransactionAllocations).values({ tenantId: ctx.tenantId, loanId: row.loanId, transactionId: replacementTransaction.id, dueDate: replacement.dueDate, component: "interest", interestAccrualId: replacement.accrualId, effectiveDate: row.effectiveDate, allocationOrder: ++allocationOrder, entryType: "payment", amount: appliedAmount.toFixed(2), reversedAllocationId: null, reason: null, idempotencyKey: `${input.idempotencyPrefix}:replacement:${row.allocationId}:${replacement.accrualId}:${allocationOrder}`, auditPublicId: input.auditPublicId, actorSource: ctx.actorSource, requestId: ctx.requestId, correlationId: ctx.correlationId, createdByUserId: ctx.actorUserId }).returning().then((result: Array<typeof floatingTransactionAllocations.$inferSelect>) => result[0]!);
                touchedAccrualIds.add(replacement.accrualId);
                executed.push({ sourceAllocationId: row.allocationId, reversalAllocationId: reversal.id, replacementAllocationId: replacementAllocation.id, replacementTransactionId: replacementTransaction.id, transactionPublicId: transaction.transactionPublicId, displacedAmount: appliedAmount.toFixed(2), oldDueDate: row.dueDate, newDueDate: replacement.dueDate });
                sourceRemaining = sourceRemaining.minus(appliedAmount);
                replacementRemaining = replacementRemaining.minus(appliedAmount);
                if (replacementRemaining.isZero()) {
                    replacementIndex += 1;
                    replacementRemaining = replacements[replacementIndex] ? money(replacements[replacementIndex]!.amount) : new FinancialDecimal(0);
                }
            }
        }
        if (replacementIndex !== replacements.length || replacementRemaining.gt(0)) throw new Error("TEMPORAL_REFLOW_PROVENANCE_INCOMPLETE");
    }
    for (const accrualId of touchedAccrualIds) {
        const accrual = await tx.query.loanInterestAccruals.findFirst({ where: and(eq(loanInterestAccruals.tenantId, ctx.tenantId), eq(loanInterestAccruals.id, accrualId)) });
        if (!accrual) throw new Error("TEMPORAL_REFLOW_PROVENANCE_INCOMPLETE");
        const allocations = await tx.select({ amount: floatingTransactionAllocations.amount }).from(floatingTransactionAllocations).where(and(eq(floatingTransactionAllocations.tenantId, ctx.tenantId), eq(floatingTransactionAllocations.interestAccrualId, accrualId)));
        const paid = allocations.reduce((sum: any, row: { amount: string }) => sum.plus(row.amount), new FinancialDecimal(0));
        if (paid.lt(0) || paid.gt(accrual.interestAmount)) throw new Error("TEMPORAL_REFLOW_ACCRUAL_BALANCE_INVALID");
        await tx.update(loanInterestAccruals).set({ paidAmount: paid.toFixed(2), status: paid.eq(accrual.interestAmount) ? "paid" : paid.gt(0) ? "partially_paid" : "accrued" }).where(and(eq(loanInterestAccruals.tenantId, ctx.tenantId), eq(loanInterestAccruals.id, accrualId)));
    }
    return { entries: executed, touchedAccrualIds: [...touchedAccrualIds] };
}
