import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { borrowers, loanRenewals, loans, users } from "../db/schema";
import { canAccessTenantWideData } from "../lib/access";
import { serializeMoney } from "../lib/money";
import type { CommandContext } from "./command-context";
import { DomainError } from "./domain-error";

export async function getLoanRenewalSummary(ctx: CommandContext, renewalPublicId: string) {
    const renewal = await db.query.loanRenewals.findFirst({ where: and(
        eq(loanRenewals.tenantId, ctx.tenantId),
        eq(loanRenewals.publicId, renewalPublicId),
    ) });
    if (!renewal) throw new DomainError("RENEWAL_NOT_FOUND", "Loan renewal not found", 404);
    const actor = ctx.actorUserId === null ? null : await db.query.users.findFirst({ where: and(
        eq(users.tenantId, ctx.tenantId), eq(users.id, ctx.actorUserId),
    ) });
    if (ctx.actorUserId !== null && !actor) throw new DomainError("RENEWAL_NOT_FOUND", "Loan renewal not found", 404);
    const oldLoan = await db.query.loans.findFirst({ where: and(
        eq(loans.tenantId, ctx.tenantId), eq(loans.id, renewal.oldLoanId),
    ) });
    if (!oldLoan || (actor && !canAccessTenantWideData({ role: actor.role ?? "viewer" }) && oldLoan.ownerUserId !== actor.id)) {
        throw new DomainError("RENEWAL_NOT_FOUND", "Loan renewal not found", 404);
    }
    if (!renewal.composition) {
        throw new DomainError("RENEWAL_SUMMARY_UNAVAILABLE", "Persisted renewal composition is unavailable", 409);
    }
    const [borrower, replacementLoan] = await Promise.all([
        db.query.borrowers.findFirst({ where: and(
            eq(borrowers.tenantId, ctx.tenantId), eq(borrowers.id, oldLoan.borrowerId),
        ) }),
        renewal.newLoanId === null ? null : db.query.loans.findFirst({ where: and(
            eq(loans.tenantId, ctx.tenantId), eq(loans.id, renewal.newLoanId),
        ) }),
    ]);
    if (!borrower) throw new DomainError("RENEWAL_SUMMARY_UNAVAILABLE", "Renewal borrower is unavailable", 409);

    const watermark = renewal.status === "reversed"
        ? "renewal_reversed"
        : renewal.status === "executed"
            ? "renewal_executed"
            : "preview_not_executed";
    return {
        status: renewal.status as "preview" | "executed" | "reversed" | "expired",
        watermark,
        renewalPublicId: renewal.publicId,
        borrower: { displayName: borrower.name },
        oldContract: {
            publicId: oldLoan.publicId,
            startDate: renewal.composition.contractStartDate,
            dueDate: renewal.composition.contractDueDate,
        },
        replacement: {
            publicId: replacementLoan?.publicId ?? null,
            principal: serializeMoney(replacementLoan?.principalAmount ?? renewal.requestedPrincipal),
            installmentAmount: replacementLoan?.installmentAmount === null || replacementLoan?.installmentAmount === undefined
                ? oldLoan.installmentAmount === null ? null : serializeMoney(oldLoan.installmentAmount)
                : serializeMoney(replacementLoan.installmentAmount),
            totalInstallments: replacementLoan?.totalInstallments ?? oldLoan.totalInstallments,
        },
        composition: renewal.composition,
        generatedAt: new Date().toISOString(),
    };
}
