import { beforeEach, describe, expect, test } from "bun:test";
import { count, eq, sql } from "drizzle-orm";
import { db } from "../db";
import {
    bankLoans,
    bankProfiles,
    borrowers,
    loanAdjustments,
    loanFundingAllocations,
    loanRenewalAdjustmentLines,
    loanRenewals,
    loanSchedules,
    loans,
    transactions,
    users,
} from "../db/schema";
import { generateLoanSchedule } from "../lib/loan-schedule";
import type { CommandContext } from "./command-context";
import { executeLoanRenewal, previewLoanRenewal } from "./loan-renewal-service";
import { getLoanRenewalSummary } from "./loan-renewal-summary-service";

const integrationEnabled = Boolean(process.env.TEST_DATABASE_URL);
const integrationTest = integrationEnabled ? test : test.skip;

async function reset() {
    await db.execute(sql`TRUNCATE TABLE
        audit_logs, loan_adjustments, loan_renewal_adjustment_lines, loan_renewals,
        fund_ledger_entries, transactions, payment_match_allocations, payment_match_proposals,
        payment_evidence, payment_intakes, loan_funding_allocations, loan_schedules, loans,
        borrowers, users, bank_loans, bank_profiles RESTART IDENTITY CASCADE`);
}

function context(tenantId: string, actorUserId: number, idempotencyKey?: string): CommandContext {
    return { tenantId, actorUserId, actorSource: "web", requestId: "summary-request", correlationId: "summary-correlation", idempotencyKey };
}

async function seed(tenantId = "tenant-renewal-summary") {
    const actor = await db.insert(users).values({ tenantId, email: `${crypto.randomUUID()}@summary.test`, name: "Summary Owner", role: "owner" }).returning().then(rows => rows[0]!);
    const borrower = await db.insert(borrowers).values({ tenantId, ownerUserId: actor.id, name: "Summary Borrower" }).returning().then(rows => rows[0]!);
    const loan = await db.insert(loans).values({
        tenantId, ownerUserId: actor.id, borrowerId: borrower.id,
        principalAmount: "2000.00", interestRate: "20.00", repaymentType: "daily", termMonths: 1,
        installmentAmount: "100.00", totalInstallments: 24, startDate: "2026-08-01",
        outstandingPrincipal: "2000.00", outstandingInterest: "400.00", outstandingFees: "0.00", status: "active",
    }).returning().then(rows => rows[0]!);
    const generated = generateLoanSchedule({ principal: "2000.00", interestRate: "20.00", repaymentType: "daily", termMonths: 1, installmentAmount: "100.00", totalInstallments: 24, startDate: "2026-08-01" });
    const schedules = await db.insert(loanSchedules).values(generated.map(row => ({
        tenantId, loanId: loan.id, installmentNo: row.installmentNo, dueDate: row.dueDate,
        scheduledPrincipal: row.scheduledPrincipal, scheduledInterest: row.scheduledInterest,
        scheduledFee: row.scheduledFee, scheduledTotal: row.scheduledTotal, remainingDue: row.remainingDue,
        paidTotal: "0.00", paidPenalty: "0.00", status: "pending",
    }))).returning();
    for (const schedule of schedules.slice(0, 10)) {
        await db.insert(transactions).values({
            tenantId, ownerUserId: actor.id, loanId: loan.id, scheduleId: schedule.id,
            amount: schedule.scheduledTotal, principalComponent: schedule.scheduledPrincipal,
            interestComponent: schedule.scheduledInterest, feeComponent: "0.00", penaltyComponent: "0.00",
            entryType: "repayment", idempotencyKey: `summary-payment-${schedule.installmentNo}`, recordedByUserId: actor.id,
        });
    }
    const profile = await db.insert(bankProfiles).values({ tenantId, name: "Summary Fund", type: "bank" }).returning().then(rows => rows[0]!);
    const drawdown = await db.insert(bankLoans).values({ tenantId, bankProfileId: profile.id, amount: "5000.00" }).returning().then(rows => rows[0]!);
    await db.insert(loanFundingAllocations).values({ tenantId, bankProfileId: profile.id, bankLoanId: drawdown.id, loanId: loan.id, allocatedAmount: "2000.00", allocationDate: "2026-08-01", allocationType: "initial", createdByUserId: actor.id });
    return { actor, borrower, loan };
}

async function financialCounts() {
    const tables = [loans, transactions, loanFundingAllocations, loanAdjustments, loanRenewalAdjustmentLines] as const;
    return Promise.all(tables.map(async table => (await db.select({ value: count() }).from(table))[0]!.value));
}

describe("loan renewal summary service", () => {
    if (integrationEnabled) beforeEach(reset);

    integrationTest("returns persisted preview and executed summary data without financial writes", async () => {
        const seeded = await seed();
        const preview = await previewLoanRenewal(context(seeded.actor.tenantId, seeded.actor.id), seeded.loan.publicId, { requestedPrincipal: "2000.00" });
        const beforePreviewRead = await financialCounts();
        const previewSummary = await getLoanRenewalSummary(context(seeded.actor.tenantId, seeded.actor.id), preview.publicId);
        expect(previewSummary).toMatchObject({
            status: "preview",
            watermark: "preview_not_executed",
            renewalPublicId: preview.publicId,
            borrower: { displayName: "Summary Borrower" },
            oldContract: { publicId: seeded.loan.publicId, startDate: "2026-08-01" },
            replacement: { publicId: null, principal: "2000.00", installmentAmount: "100.00", totalInstallments: 24 },
            composition: preview.composition,
        });
        expect(previewSummary.composition.payments).toHaveLength(10);
        expect(await financialCounts()).toEqual(beforePreviewRead);

        const executed = await executeLoanRenewal(context(seeded.actor.tenantId, seeded.actor.id, "summary-execute"), preview.publicId, { previewHash: preview.previewHash, confirmed: true, reason: "summary execution" });
        const beforeExecutedRead = await financialCounts();
        const executedSummary = await getLoanRenewalSummary(context(seeded.actor.tenantId, seeded.actor.id), preview.publicId);
        expect(executedSummary).toMatchObject({ status: "executed", watermark: "renewal_executed", replacement: { publicId: executed.newLoanPublicId } });
        expect(JSON.stringify(executedSummary)).not.toMatch(/identity|bankAccount|slip|evidence|signedUrl/i);
        expect(await financialCounts()).toEqual(beforeExecutedRead);
    });

    integrationTest("enforces tenant isolation and treats expired previews as not executed", async () => {
        const seeded = await seed();
        const outsider = await seed("tenant-renewal-summary-other");
        const collector = await db.insert(users).values({
            tenantId: seeded.actor.tenantId,
            email: `${crypto.randomUUID()}@summary.test`,
            role: "collector",
        }).returning().then(rows => rows[0]!);
        const preview = await previewLoanRenewal(context(seeded.actor.tenantId, seeded.actor.id), seeded.loan.publicId, { requestedPrincipal: "2000.00" });
        await db.update(loanRenewals).set({ status: "expired" }).where(eq(loanRenewals.publicId, preview.publicId));
        expect(await getLoanRenewalSummary(context(seeded.actor.tenantId, seeded.actor.id), preview.publicId)).toMatchObject({ status: "expired", watermark: "preview_not_executed" });
        await expect(getLoanRenewalSummary(context(seeded.actor.tenantId, collector.id), preview.publicId)).rejects.toMatchObject({ code: "RENEWAL_NOT_FOUND", status: 404 });
        await expect(getLoanRenewalSummary(context(outsider.actor.tenantId, outsider.actor.id), preview.publicId)).rejects.toMatchObject({ code: "RENEWAL_NOT_FOUND", status: 404 });
    });
});
