import Decimal from "decimal.js";
import type { DbExecutor } from "../db";
import type { loans } from "../db/schema";
import { floatingPaymentObligations, selectFloatingInterestPaymentTargets, type FloatingPaymentProjection } from "./floating-interest-service";
import { calculateFloatingPaymentComponents, floatingCarriedBalances, planFloatingPaymentTargets } from "./payment-service";
import type { CommandContext } from "./command-context";
import { DomainError } from "./domain-error";
import { assertNoLaterFloatingPayment } from "./payment-chronology-service";

export type FloatingBatchState = FloatingPaymentProjection & { carriedPenaltyPaid: string; carriedFeePaid: string; carriedInterestPaid: string };
export function emptyFloatingBatchState(): FloatingBatchState {
    return { principalPayments: [], allocations: [], carriedPenaltyPaid: "0.00", carriedFeePaid: "0.00", carriedInterestPaid: "0.00" };
}

/** Read-only projection over the authoritative posting waterfall and accrual engine. */
export async function projectFloatingBatchPayment(tx: DbExecutor, ctx: CommandContext, loan: typeof loans.$inferSelect, receivedAt: Date, amount: string, intent: string, state: FloatingBatchState) {
    await assertNoLaterFloatingPayment(tx, ctx.tenantId, loan.id, receivedAt);
    const throughDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit" }).format(receivedAt);
    const obligations = await floatingPaymentObligations(tx, loan, receivedAt, ctx, state);
    const advance = await selectFloatingInterestPaymentTargets(tx, loan, receivedAt, ctx, { projection: state });
    const carried = await floatingCarriedBalances(tx, ctx.tenantId, loan.id);
    const paidPrincipal = state.principalPayments.reduce((sum, item) => sum.plus(item.amount), new Decimal(0));
    const components = calculateFloatingPaymentComponents(amount, {
        principal: new Decimal(loan.outstandingPrincipal ?? loan.principalAmount).minus(paidPrincipal).toFixed(2),
        carriedPenalty: Decimal.max(0, (carried?.carriedPenalty ?? new Decimal(0)).minus(state.carriedPenaltyPaid)),
        carriedFee: Decimal.max(0, (carried?.carriedFee ?? new Decimal(0)).minus(state.carriedFeePaid)),
        carriedInterest: Decimal.max(0, (carried?.carriedInterest ?? new Decimal(0)).minus(state.carriedInterestPaid)),
        duePenalty: obligations.duePenalty, dueInterest: obligations.dueInterest,
        advanceInterest: advance.reduce((sum: Decimal, row: typeof obligations.rows[number]) => sum.plus(Decimal.max(0, new Decimal(row.interestAmount).minus(row.paidAmount))), new Decimal(0)),
    });
    if (components.paidAdvanceInterest.gt(0) && intent !== "advance") throw new DomainError("ADVANCE_INTENT_REQUIRED", "Advance interest requires an explicit advance intent", 409);
    const planned = planFloatingPaymentTargets(obligations, advance, components, throughDate);
    const allocations = planned.map((row) => {
        const accrual = row.interestAccrualId === null ? null : [...obligations.rows, ...advance].find((entry) => entry.id === row.interestAccrualId);
        if (row.component === "interest" && !accrual) throw new DomainError("FLOATING_INTEREST_PROVENANCE_UNAVAILABLE", "Floating allocation requires accrual provenance", 409);
        return { effectiveDate: throughDate, dueDate: row.dueDate, accrualDate: accrual?.accrualDate ?? null, component: row.component, amount: row.amount.toFixed(2) };
    });
    state.principalPayments.push({ effectiveDate: throughDate, amount: components.principal.toFixed(2) });
    state.allocations.push(...allocations);
    state.carriedPenaltyPaid = new Decimal(state.carriedPenaltyPaid).plus(components.paidCarriedPenalty).toFixed(2);
    state.carriedFeePaid = new Decimal(state.carriedFeePaid).plus(components.paidCarriedFee).toFixed(2);
    state.carriedInterestPaid = new Decimal(state.carriedInterestPaid).plus(components.paidCarriedInterest).toFixed(2);
    const lastAccrualDate = allocations.reduce((latest, row) => row.accrualDate && row.accrualDate > latest ? row.accrualDate : latest, throughDate);
    if (components.principal.gt(0) && lastAccrualDate > throughDate) await floatingPaymentObligations(tx, loan, new Date(`${lastAccrualDate}T16:59:59.999Z`), ctx, state);
    return { throughDate, allocations, components: { principal: components.principal.toFixed(2), interest: components.totalInterest.toFixed(2), fee: components.totalFee.toFixed(2), penalty: components.totalPenalty.toFixed(2) } };
}
