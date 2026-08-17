import { beforeEach, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { bankLoans, bankProfiles, borrowers, loanFundingAllocations, loanReplacementCorrections, loanSchedules, loans, users } from "../db/schema";
import type { CommandContext } from "./command-context";
import { createLoanDraft } from "./loan-application-service";
import { executeLoanReplacement, previewLoanReplacement, reverseLoanReplacement } from "./loan-replacement-service";

const integrationTest = process.env.TEST_DATABASE_URL ? test : test.skip;

function context(tenantId: string, actorUserId: number, idempotencyKey = "replacement-preview") : CommandContext {
    return { tenantId, actorUserId, actorSource: "web", requestId: "req-replacement", correlationId: "corr-replacement", idempotencyKey };
}

async function reset() {
    await db.execute(sql`SET client_min_messages TO WARNING`);
    await db.execute(sql`TRUNCATE TABLE audit_logs, loan_replacement_corrections, loan_replacements, loan_funding_allocations, loan_schedules, loan_disbursement_events, transactions, loans, borrowers, bank_loans, bank_profiles, users RESTART IDENTITY CASCADE`);
}

describe("loan replacement service", () => {
    if (process.env.TEST_DATABASE_URL) beforeEach(reset);

    // Break caught: preview carries the erroneous interest into the replacement or calculates daily due dates from the wrong start date.
    integrationTest("previews a no-cash correction with the approved daily replacement dates", async () => {
        const tenantId = "replacement-preview";
        const actor = await db.insert(users).values({ tenantId, email: "manager@example.test", role: "manager" }).returning().then(rows => rows[0]!);
        const borrower = await db.insert(borrowers).values({ tenantId, ownerUserId: actor.id, name: "Replacement Borrower" }).returning().then(rows => rows[0]!);
        const profile = await db.insert(bankProfiles).values({ tenantId, name: "TTB", type: "bank", status: "active", accountingMode: "external_liability" }).returning().then(rows => rows[0]!);
        const drawdown = await db.insert(bankLoans).values({ tenantId, bankProfileId: profile.id, amount: "72000.00", interestRate: "0.00", termMonths: 1, status: "active", startDate: "2026-07-01" }).returning().then(rows => rows[0]!);
        const oldLoan = await db.insert(loans).values({
            tenantId, ownerUserId: actor.id, borrowerId: borrower.id, bankLoanId: drawdown.id,
            principalAmount: "36000.00", interestRate: "0.00", repaymentType: "daily", termMonths: 7,
            totalInstallments: 200, installmentAmount: "201.00", startDate: "2026-07-12", status: "active",
            outstandingPrincipal: "36000.00", outstandingInterest: "4200.00", outstandingFees: "0.00", nextDueDate: "2026-07-13",
        }).returning().then(rows => rows[0]!);
        await db.insert(loanSchedules).values({ tenantId, loanId: oldLoan.id, installmentNo: 1, dueDate: "2026-07-13", scheduledPrincipal: "180.00", scheduledInterest: "21.00", scheduledFee: "0.00", scheduledTotal: "201.00", paidTotal: "0.00", paidPenalty: "0.00", remainingDue: "201.00", status: "pending" });
        await db.insert(loanFundingAllocations).values({ tenantId, loanId: oldLoan.id, bankLoanId: drawdown.id, bankProfileId: profile.id, allocatedAmount: "36000.00", allocationDate: "2026-07-12", allocationType: "initial", allocationGroupId: crypto.randomUUID(), createdByUserId: actor.id });
        const replacement = await createLoanDraft(context(tenantId, actor.id), {
            borrowerPublicId: borrower.publicId, bankLoanPublicId: drawdown.publicId,
            principal: "36000.00", interestRate: "0.00", repaymentType: "daily", termMonths: 7,
            totalInstallments: 200, installmentAmount: "201.00", startDate: "2026-07-11",
        });

        const preview = await previewLoanReplacement(context(tenantId, actor.id), {
            oldLoanPublicId: oldLoan.publicId, replacementDraftPublicId: replacement.publicId, reason: "Corrected start date",
        });

        expect(preview).toMatchObject({
            cash: { direction: "none", amount: "0.00" },
            correction: { principal: "36000.00", interest: "4200.00", fee: "0.00", penalty: "0.00" },
            replacement: { firstDueDate: "2026-07-12" },
        });

        const executed = await executeLoanReplacement(context(tenantId, actor.id, "replacement-execute"), {
            replacementPublicId: preview.publicId, previewHash: preview.previewHash,
            expectedOldBalanceVersion: preview.oldBalanceVersion, expectedReplacementDraftVersion: preview.replacementDraftVersion,
            reason: "Corrected start date", confirmed: true,
        });
        expect(executed).toMatchObject({ oldLoanPublicId: oldLoan.publicId, replacementLoanPublicId: replacement.publicId, status: "executed" });
        expect(await executeLoanReplacement(context(tenantId, actor.id, "replacement-execute"), {
            replacementPublicId: preview.publicId, previewHash: preview.previewHash,
            expectedOldBalanceVersion: preview.oldBalanceVersion, expectedReplacementDraftVersion: preview.replacementDraftVersion,
            reason: "Corrected start date", confirmed: true,
        })).toMatchObject(executed);
        await expect(executeLoanReplacement(context(tenantId, actor.id, "replacement-execute"), {
            replacementPublicId: preview.publicId, previewHash: preview.previewHash,
            expectedOldBalanceVersion: preview.oldBalanceVersion, expectedReplacementDraftVersion: preview.replacementDraftVersion,
            reason: "Different correction", confirmed: true,
        })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
        expect(await db.query.loans.findFirst({ where: eq(loans.id, oldLoan.id) })).toMatchObject({ status: "replaced", outstandingPrincipal: "0.00", outstandingInterest: "0.00", nextDueDate: null });
        expect(await db.select().from(loanReplacementCorrections).where(eq(loanReplacementCorrections.loanId, oldLoan.id))).toMatchObject([{ principal: "36000.00", interest: "4200.00", fee: "0.00", penalty: "0.00", status: "posted" }]);
        expect(await db.select().from(loanSchedules).where(and(eq(loanSchedules.loanId, oldLoan.id), eq(loanSchedules.status, "cancelled")))).toHaveLength(1);

        const reversed = await reverseLoanReplacement(context(tenantId, actor.id, "replacement-reverse"), { replacementPublicId: preview.publicId, reason: "Preview correction was not approved" });
        expect(reversed).toMatchObject({ replacementPublicId: preview.publicId, status: "reversed" });
        expect(await reverseLoanReplacement(context(tenantId, actor.id, "replacement-reverse"), { replacementPublicId: preview.publicId, reason: "Preview correction was not approved" })).toMatchObject(reversed);
        await expect(reverseLoanReplacement(context(tenantId, actor.id, "replacement-reverse"), { replacementPublicId: preview.publicId, reason: "Different reversal reason" })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
        expect(await db.query.loans.findFirst({ where: eq(loans.id, oldLoan.id) })).toMatchObject({ status: "active", outstandingPrincipal: "36000.00", outstandingInterest: "4200.00", nextDueDate: "2026-07-13" });
        expect(await db.select().from(loanReplacementCorrections).where(eq(loanReplacementCorrections.loanId, oldLoan.id))).toHaveLength(2);
    });
});
