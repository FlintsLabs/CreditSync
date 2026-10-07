import { FinancialDecimal } from "../lib/financial-decimal";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { borrowers, floatingTransactionAllocations, loanInterestAccruals, loans, paymentIntakes, transactions, users } from "../db/schema";
import { activeFloatingPaymentAllocations } from "../lib/floating-allocation-integrity";
import { canAccessTenantWideData } from "../lib/access";
import { serializeMoney } from "../lib/money";
import type { CommandContext } from "./command-context";
import { DomainError } from "./domain-error";

export type LoanAccrualReceiptHistory = {
    accrualDate: string;
    receipts: Array<{
        amount: string;
        receivedAt: string | null;
        recordedAt: string | null;
        paymentIntakePublicId: string | null;
        transactionPublicId: string | null;
        status: "posted" | "reversed" | "unknown";
        sourceKind: "receipt" | "advance_deduction" | "legacy_unattributed";
        href: string | null;
    }>;
};

/** Batch-loads a tenant/loan receipt history and resolves reversals before presenting it. */
export async function getLoanAccrualReceiptHistory(ctx: CommandContext, loanPublicId: string): Promise<LoanAccrualReceiptHistory[]> {
    const loan = await db.query.loans.findFirst({ where: and(eq(loans.tenantId, ctx.tenantId), eq(loans.publicId, loanPublicId)) });
    if (!loan || loan.repaymentType !== "floating") throw new DomainError("LOAN_NOT_FOUND", "Loan not found", 404);
    const actor = ctx.actorUserId === null ? null : await db.query.users.findFirst({ where: and(eq(users.tenantId, ctx.tenantId), eq(users.id, ctx.actorUserId)) });
    if (actor && !canAccessTenantWideData({ role: actor.role ?? "viewer" })) {
        const borrower = await db.query.borrowers.findFirst({ where: and(eq(borrowers.tenantId, ctx.tenantId), eq(borrowers.id, loan.borrowerId)) });
        if (loan.ownerUserId !== actor.id || borrower?.ownerUserId !== actor.id) throw new DomainError("INVALID_PAYMENT_TARGET", "Loan is outside the actor portfolio", 403);
    }
    const [accrualRows, allocationRows] = await Promise.all([
        db.select().from(loanInterestAccruals).where(and(eq(loanInterestAccruals.tenantId, ctx.tenantId), eq(loanInterestAccruals.loanId, loan.id))),
        db.select().from(floatingTransactionAllocations).where(and(eq(floatingTransactionAllocations.tenantId, ctx.tenantId), eq(floatingTransactionAllocations.loanId, loan.id), eq(floatingTransactionAllocations.component, "interest"))),
    ]);
    const accrualById = new Map(accrualRows.map((row) => [row.id, row]));
    const receiptAllocations = allocationRows.filter((row) => row.entryType === "payment" && row.interestAccrualId !== null);
    const transactionIds = [...new Set(receiptAllocations.map((row) => row.transactionId))];
    const transactionRows = transactionIds.length ? await db.select().from(transactions).where(and(eq(transactions.tenantId, ctx.tenantId), inArray(transactions.id, transactionIds))) : [];
    const transactionById = new Map(transactionRows.map((row) => [row.id, row]));
    const intakeIds = [...new Set(transactionRows.map((row) => row.paymentIntakeId).filter((id): id is number => id !== null))];
    const intakeRows = intakeIds.length ? await db.select().from(paymentIntakes).where(and(eq(paymentIntakes.tenantId, ctx.tenantId), inArray(paymentIntakes.id, intakeIds))) : [];
    const intakeById = new Map(intakeRows.map((row) => [row.id, row]));
    const activeIds = new Set(activeFloatingPaymentAllocations(allocationRows).map((row) => row.id));
    const reversedIds = new Set(receiptAllocations.filter((row) => !activeIds.has(row.id)).map((row) => row.id));
    const activeByAccrual = new Map<number, InstanceType<typeof FinancialDecimal>>();
    for (const allocation of receiptAllocations) if (activeIds.has(allocation.id)) {
        activeByAccrual.set(allocation.interestAccrualId!, (activeByAccrual.get(allocation.interestAccrualId!) ?? new FinancialDecimal(0)).plus(allocation.amount));
    }
    const byDate = new Map<string, LoanAccrualReceiptHistory["receipts"]>();
    for (const allocation of receiptAllocations) {
        const accrual = accrualById.get(allocation.interestAccrualId!);
        if (!accrual) continue;
        const transaction = transactionById.get(allocation.transactionId);
        const intake = transaction?.paymentIntakeId === null || transaction?.paymentIntakeId === undefined ? null : intakeById.get(transaction.paymentIntakeId) ?? null;
        const sourceKind = intake ? "receipt" : "legacy_unattributed";
        const amount = activeIds.has(allocation.id) ? allocation.amount : allocation.amount;
        byDate.set(accrual.accrualDate, [...(byDate.get(accrual.accrualDate) ?? []), {
            amount: serializeMoney(amount),
            receivedAt: intake?.receivedAt.toISOString() ?? transaction?.transactionDate?.toISOString() ?? null,
            recordedAt: transaction?.postedAt?.toISOString() ?? allocation.createdAt.toISOString(),
            paymentIntakePublicId: intake?.publicId ?? null,
            transactionPublicId: transaction?.publicId ?? null,
            status: reversedIds.has(allocation.id) ? "reversed" : activeIds.has(allocation.id) ? "posted" : "unknown",
            sourceKind,
            href: intake ? `/payments?intake=${intake.publicId}&loanId=${loan.publicId}` : null,
        }]);
    }
    for (const accrual of accrualRows) {
        const activePaid = activeByAccrual.get(accrual.id) ?? new FinancialDecimal(0);
        const advance = loan.firstDayTreatment === "deduct" && accrual.accrualDate === loan.interestStartDate
            ? FinancialDecimal.min(accrual.interestAmount, accrual.paidAmount)
            : new FinancialDecimal(0);
        if (advance.gt(0)) byDate.set(accrual.accrualDate, [...(byDate.get(accrual.accrualDate) ?? []), {
            amount: serializeMoney(advance), receivedAt: null, recordedAt: null, paymentIntakePublicId: null,
            transactionPublicId: null, status: "posted", sourceKind: "advance_deduction", href: null,
        }]);
        const legacy = FinancialDecimal.max(new FinancialDecimal(accrual.paidAmount).minus(activePaid).minus(advance), 0);
        if (legacy.gt(0)) byDate.set(accrual.accrualDate, [...(byDate.get(accrual.accrualDate) ?? []), {
            amount: serializeMoney(legacy), receivedAt: null, recordedAt: null, paymentIntakePublicId: null,
            transactionPublicId: null, status: "unknown", sourceKind: "legacy_unattributed", href: null,
        }]);
    }
    return [...byDate.entries()].map(([accrualDate, receipts]) => ({ accrualDate, receipts }))
        .sort((left, right) => left.accrualDate.localeCompare(right.accrualDate));
}
