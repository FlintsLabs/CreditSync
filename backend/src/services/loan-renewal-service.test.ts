import { beforeEach, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import {
    auditLogs,
    bankLoans,
    bankProfiles,
    borrowers,
    loanAdjustments,
    loanFundingAllocations,
    loanRenewals,
    loanSchedules,
    loans,
    transactions,
    users,
} from "../db/schema";
import { generateLoanSchedule } from "../lib/loan-schedule";
import type { CommandContext } from "./command-context";
import { executeLoanRenewal, previewLoanRenewal, reverseLoanRenewal } from "./loan-renewal-service";

const integrationEnabled = Boolean(process.env.TEST_DATABASE_URL);
const integrationTest = integrationEnabled ? test : test.skip;

async function resetRenewalTables() {
    await db.execute(sql`TRUNCATE TABLE
        audit_logs, loan_adjustments, loan_renewals, fund_ledger_entries,
        transactions, payment_match_allocations, payment_match_proposals,
        payment_evidence, payment_intakes, loan_funding_allocations,
        loan_schedules, loans, borrowers, users, bank_loans, bank_profiles
        RESTART IDENTITY CASCADE`);
}

function context(tenantId: string, actorUserId: number, idempotencyKey?: string): CommandContext {
    return {
        tenantId,
        actorUserId,
        actorSource: "web",
        requestId: "req-renewal-task-5",
        correlationId: "corr-renewal-task-5",
        idempotencyKey,
    };
}

function utcDateOffset(days: number) {
    const date = new Date();
    date.setUTCHours(0, 0, 0, 0);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
}

async function seedDailyLoan(options: { paidInstallments?: number; allocatedAmount?: string } = {}) {
    const paidInstallments = options.paidInstallments ?? 10;
    const tenantId = "tenant-renewal";
    const actor = await db.insert(users).values({
        tenantId,
        email: `renewal-${crypto.randomUUID()}@example.test`,
        role: "owner",
    }).returning().then((rows) => rows[0]!);
    const borrower = await db.insert(borrowers).values({
        tenantId,
        ownerUserId: actor.id,
        name: "Daily Renewal Borrower",
    }).returning().then((rows) => rows[0]!);
    const oldLoan = await db.insert(loans).values({
        tenantId,
        ownerUserId: actor.id,
        borrowerId: borrower.id,
        principalAmount: "2500.00",
        interestRate: "14.00",
        repaymentType: "daily",
        termMonths: 1,
        installmentAmount: "190.00",
        totalInstallments: 15,
        startDate: utcDateOffset(-10),
        outstandingPrincipal: "2500.00", // intentionally stale: renewal must use posted principal
        outstandingInterest: "350.00",
        outstandingFees: "0.00",
        status: "active",
    }).returning().then((rows) => rows[0]!);
    const generated = generateLoanSchedule({
        principal: "2500.00",
        interestRate: "14.00",
        repaymentType: "daily",
        termMonths: 1,
        installmentAmount: "190.00",
        totalInstallments: 15,
        startDate: utcDateOffset(-10),
    });
    const schedules = await db.insert(loanSchedules).values(generated.map((row, index) => ({
        tenantId,
        loanId: oldLoan.id,
        installmentNo: row.installmentNo,
        dueDate: row.dueDate,
        scheduledPrincipal: row.scheduledPrincipal,
        scheduledInterest: row.scheduledInterest,
        scheduledFee: row.scheduledFee,
        scheduledTotal: row.scheduledTotal,
        paidTotal: index < paidInstallments ? row.scheduledTotal : "0.00",
        remainingDue: index < paidInstallments ? "0.00" : row.remainingDue,
        status: index < paidInstallments ? "paid" : "pending",
    }))).returning();
    for (const schedule of schedules.slice(0, paidInstallments)) {
        await db.insert(transactions).values({
            tenantId,
            ownerUserId: actor.id,
            loanId: oldLoan.id,
            scheduleId: schedule.id,
            amount: schedule.scheduledTotal,
            principalComponent: schedule.scheduledPrincipal,
            interestComponent: schedule.scheduledInterest,
            feeComponent: "0.00",
            penaltyComponent: "0.00",
            entryType: "repayment",
            idempotencyKey: `seed-payment-${schedule.installmentNo}`,
            recordedByUserId: actor.id,
        });
    }
    const profile = await db.insert(bankProfiles).values({
        tenantId,
        name: "Renewal Fund",
        type: "bank",
    }).returning().then((rows) => rows[0]!);
    const drawdown = await db.insert(bankLoans).values({
        tenantId,
        bankProfileId: profile.id,
        amount: "10000.00",
    }).returning().then((rows) => rows[0]!);
    await db.insert(loanFundingAllocations).values({
        tenantId,
        bankProfileId: profile.id,
        bankLoanId: drawdown.id,
        loanId: oldLoan.id,
        allocatedAmount: options.allocatedAmount ?? "2500.00",
        allocationDate: oldLoan.startDate!,
        allocationType: "initial",
        createdByUserId: actor.id,
    });
    return { tenantId, actor, borrower, oldLoan, schedules, profile, drawdown };
}

describe("daily-loan renewal service", () => {
    if (integrationEnabled) beforeEach(resetRenewalTables);

    // Break caught: renewal uses cached/scheduled balances instead of actual posted, non-reversed principal.
    integrationTest("previews the exact 2500/190/15 principal recovery after ten paid installments", async () => {
        const seeded = await seedDailyLoan();

        const preview = await previewLoanRenewal(
            context(seeded.tenantId, seeded.actor.id),
            seeded.oldLoan.publicId,
            { requestedPrincipal: "2500.00", waivedCharges: "0.00" },
        );

        expect(preview).toMatchObject({
            id: preview.publicId,
            status: "preview",
            oldLoanPublicId: seeded.oldLoan.publicId,
            principalPaid: "1666.70",
            outstandingPrincipal: "833.30",
            dueInterest: "0.00",
            dueFees: "0.00",
            duePenalties: "0.00",
            dueCharges: "0.00",
            settlementAmount: "0.00",
            waivedCharges: "0.00",
            requestedPrincipal: "2500.00",
            cashDirection: "payout",
            cashAmount: "1666.70",
        });
        expect(preview.previewHash).toMatch(/^v1:[0-9a-f]{64}$/);
        expect(preview.expiresAt.getTime()).toBeGreaterThan(Date.now());

        const persisted = await db.query.loanRenewals.findFirst({
            where: and(eq(loanRenewals.publicId, preview.publicId), eq(loanRenewals.tenantId, seeded.tenantId)),
        });
        expect(persisted).toMatchObject({
            previewHash: preview.previewHash,
            requestedPrincipal: "2500.00",
            outstandingPrincipal: "833.30",
            dueCharges: "0.00",
            waivedCharges: "0.00",
            cashDirection: "payout",
            cashAmount: "1666.70",
        });
        expect(await db.select().from(auditLogs).where(and(
            eq(auditLogs.entityId, preview.publicId),
            eq(auditLogs.action, "previewed"),
        ))).toHaveLength(1);
    });

    // Break caught: a reversed principal receipt still reduces renewal outstanding principal.
    integrationTest("uses only non-reversed posted principal for a partial-pay renewal", async () => {
        const seeded = await seedDailyLoan({ paidInstallments: 4 });
        const original = await db.query.transactions.findFirst({
            where: and(
                eq(transactions.loanId, seeded.oldLoan.id),
                eq(transactions.scheduleId, seeded.schedules[3]!.id),
            ),
        });
        await db.insert(transactions).values({
            tenantId: seeded.tenantId,
            ownerUserId: seeded.actor.id,
            loanId: seeded.oldLoan.id,
            scheduleId: seeded.schedules[3]!.id,
            amount: "-190.00",
            principalComponent: "-166.67",
            interestComponent: "-23.33",
            feeComponent: "0.00",
            penaltyComponent: "0.00",
            entryType: "reversal",
            reversedTransactionId: original!.id,
            idempotencyKey: "seed-payment-reversal",
            recordedByUserId: seeded.actor.id,
        });

        const preview = await previewLoanRenewal(
            context(seeded.tenantId, seeded.actor.id),
            seeded.oldLoan.publicId,
            { requestedPrincipal: "2500.00" },
        );

        expect(preview).toMatchObject({
            principalPaid: "500.01",
            outstandingPrincipal: "1999.99",
            dueCharges: "163.31",
            cashDirection: "payout",
            cashAmount: "336.70",
        });
    });

    // Break caught: unpaid due interest is omitted from proceeds instead of being settled from payout.
    integrationTest("settles due charges from renewal payout", async () => {
        const seeded = await seedDailyLoan({ paidInstallments: 9 });

        const preview = await previewLoanRenewal(
            context(seeded.tenantId, seeded.actor.id),
            seeded.oldLoan.publicId,
            { requestedPrincipal: "2500.00", waivedCharges: "0.00" },
        );

        expect(preview).toMatchObject({
            principalPaid: "1500.03",
            outstandingPrincipal: "999.97",
            dueInterest: "23.33",
            dueFees: "0.00",
            duePenalties: "0.00",
            dueCharges: "23.33",
            settlementAmount: "23.33",
            cashDirection: "payout",
            cashAmount: "1476.70",
        });
    });

    // Break caught: charges can be waived anonymously or beyond the amount actually due.
    integrationTest("requires and persists a reason for a bounded charge waiver", async () => {
        const seeded = await seedDailyLoan({ paidInstallments: 9 });

        await expect(previewLoanRenewal(
            context(seeded.tenantId, seeded.actor.id),
            seeded.oldLoan.publicId,
            { requestedPrincipal: "2500.00", waivedCharges: "23.33" },
        )).rejects.toMatchObject({ code: "WAIVER_REASON_REQUIRED", status: 400 });
        await expect(previewLoanRenewal(
            context(seeded.tenantId, seeded.actor.id),
            seeded.oldLoan.publicId,
            { requestedPrincipal: "2500.00", waivedCharges: "23.34", waiverReason: "incorrect late charge" },
        )).rejects.toMatchObject({ code: "WAIVER_EXCEEDS_DUE_CHARGES", status: 400 });

        const preview = await previewLoanRenewal(
            context(seeded.tenantId, seeded.actor.id),
            seeded.oldLoan.publicId,
            { requestedPrincipal: "2500.00", waivedCharges: "23.33", waiverReason: "approved hardship waiver" },
        );
        expect(preview).toMatchObject({
            dueCharges: "23.33",
            waivedCharges: "23.33",
            settlementAmount: "0.00",
            cashAmount: "1500.03",
            waiverReason: "approved hardship waiver",
        });
        const persisted = await db.query.loanRenewals.findFirst({ where: eq(loanRenewals.publicId, preview.publicId) });
        expect(persisted?.reason).toBe("approved hardship waiver");
    });

    // Break caught: concurrent retries create duplicate replacement loans/schedules or record principal transfer as cash.
    integrationTest("executes an explicitly confirmed renewal once with fresh schedule and exact cash/non-cash records", async () => {
        const seeded = await seedDailyLoan();
        const secondProfile = await db.insert(bankProfiles).values({
            tenantId: seeded.tenantId, name: "Second Renewal Fund", type: "bank",
        }).returning().then((rows) => rows[0]!);
        const secondDrawdown = await db.insert(bankLoans).values({
            tenantId: seeded.tenantId, bankProfileId: secondProfile.id, amount: "5000.00",
        }).returning().then((rows) => rows[0]!);
        await db.insert(loanFundingAllocations).values([{
            tenantId: seeded.tenantId,
            bankProfileId: seeded.profile.id,
            bankLoanId: seeded.drawdown.id,
            loanId: seeded.oldLoan.id,
            allocatedAmount: "-1000.00",
            allocationDate: seeded.oldLoan.startDate!,
            allocationType: "manual_adjustment",
            createdByUserId: seeded.actor.id,
        }, {
            tenantId: seeded.tenantId,
            bankProfileId: secondProfile.id,
            bankLoanId: secondDrawdown.id,
            loanId: seeded.oldLoan.id,
            allocatedAmount: "1000.00",
            allocationDate: seeded.oldLoan.startDate!,
            allocationType: "initial",
            createdByUserId: seeded.actor.id,
        }]);
        const preview = await previewLoanRenewal(
            context(seeded.tenantId, seeded.actor.id),
            seeded.oldLoan.publicId,
            { requestedPrincipal: "2500.00" },
        );
        const execute = () => executeLoanRenewal(
            context(seeded.tenantId, seeded.actor.id, "renewal-execute-exact"),
            preview.publicId,
            { previewHash: preview.previewHash, confirmed: true, reason: "borrower requested renewal" },
        );

        let markLocked!: () => void;
        let releaseLock!: () => void;
        const lockReady = new Promise<void>((resolve) => { markLocked = resolve; });
        const release = new Promise<void>((resolve) => { releaseLock = resolve; });
        const blocker = db.transaction(async (tx) => {
            await tx.execute(sql`SELECT id FROM loans WHERE id = ${seeded.oldLoan.id} FOR UPDATE`);
            markLocked();
            await release;
        });
        await lockReady;
        const firstPending = execute();
        const retryPending = execute();
        await Bun.sleep(20);
        releaseLock();
        await blocker;
        const [first, retry] = await Promise.all([firstPending, retryPending]);

        expect(retry).toEqual(first);
        expect(first).toMatchObject({
            id: preview.publicId,
            publicId: preview.publicId,
            status: "executed",
            oldLoanPublicId: seeded.oldLoan.publicId,
            principalPaid: "1666.70",
            outstandingPrincipal: "833.30",
            requestedPrincipal: "2500.00",
            cashDirection: "payout",
            cashAmount: "1666.70",
            reason: "borrower requested renewal",
        });
        expect(first.newLoanPublicId).toMatch(/^[0-9a-f-]{36}$/);

        const oldLoan = await db.query.loans.findFirst({ where: eq(loans.id, seeded.oldLoan.id) });
        const replacement = await db.query.loans.findFirst({ where: eq(loans.publicId, first.newLoanPublicId) });
        expect(oldLoan?.status).toBe("renewed");
        expect(replacement).toMatchObject({
            borrowerId: seeded.borrower.id,
            principalAmount: "2500.00",
            repaymentType: "daily",
            installmentAmount: "190.00",
            totalInstallments: 15,
            status: "active",
            clonedFromLoanId: seeded.oldLoan.id,
            outstandingPrincipal: "2500.00",
            outstandingInterest: "350.00",
        });
        expect(await db.select().from(loans).where(eq(loans.clonedFromLoanId, seeded.oldLoan.id))).toHaveLength(1);
        expect(await db.select().from(loanSchedules).where(eq(loanSchedules.loanId, replacement!.id))).toHaveLength(15);
        expect(await db.select().from(loanFundingAllocations)
            .where(eq(loanFundingAllocations.loanId, replacement!.id)).orderBy(loanFundingAllocations.id))
            .toEqual([expect.objectContaining({
                bankProfileId: seeded.profile.id,
                bankLoanId: seeded.drawdown.id,
                allocatedAmount: "1500.00",
                allocationType: "reallocation_in",
            }), expect.objectContaining({
                bankProfileId: secondProfile.id,
                bankLoanId: secondDrawdown.id,
                allocatedAmount: "1000.00",
                allocationType: "reallocation_in",
            })]);
        expect((await db.select().from(loanAdjustments).where(eq(loanAdjustments.renewalId,
            (await db.query.loanRenewals.findFirst({ where: eq(loanRenewals.publicId, preview.publicId) }))!.id,
        )).orderBy(loanAdjustments.id)).map((row) => ({ type: row.adjustmentType, amount: row.amount }))).toEqual([
            { type: "principal_transfer", amount: "833.30" },
            { type: "cash_payout", amount: "1666.70" },
        ]);
        expect(await db.select().from(transactions).where(eq(transactions.loanId, replacement!.id))).toHaveLength(0);
        expect(await db.select().from(auditLogs).where(and(
            eq(auditLogs.entityId, preview.publicId),
            eq(auditLogs.action, "executed"),
        ))).toHaveLength(1);
    });

    // Break caught: execute trusts a persisted preview after new principal is posted to the old loan.
    integrationTest("expires and rejects a stale preview after balance-changing activity", async () => {
        const seeded = await seedDailyLoan();
        const preview = await previewLoanRenewal(
            context(seeded.tenantId, seeded.actor.id),
            seeded.oldLoan.publicId,
            { requestedPrincipal: "2500.00" },
        );
        const schedule = seeded.schedules[10]!;
        await db.insert(transactions).values({
            tenantId: seeded.tenantId,
            ownerUserId: seeded.actor.id,
            loanId: seeded.oldLoan.id,
            scheduleId: schedule.id,
            amount: schedule.scheduledTotal,
            principalComponent: schedule.scheduledPrincipal,
            interestComponent: schedule.scheduledInterest,
            feeComponent: "0.00",
            penaltyComponent: "0.00",
            entryType: "repayment",
            idempotencyKey: "payment-after-renewal-preview",
            recordedByUserId: seeded.actor.id,
        });

        await expect(executeLoanRenewal(
            context(seeded.tenantId, seeded.actor.id, "stale-renewal-execute"),
            preview.publicId,
            { previewHash: preview.previewHash, confirmed: true, reason: "stale attempt" },
        )).rejects.toMatchObject({ code: "STALE_RENEWAL_PREVIEW", status: 409 });
        expect(await db.query.loanRenewals.findFirst({ where: eq(loanRenewals.publicId, preview.publicId) }))
            .toMatchObject({ status: "expired", newLoanId: null });
        expect(await db.select().from(loans).where(eq(loans.clonedFromLoanId, seeded.oldLoan.id))).toHaveLength(0);
    });

    // Break caught: execution silently creates an underfunded replacement loan.
    integrationTest("rejects execution when existing allocations cannot fund the requested principal", async () => {
        const seeded = await seedDailyLoan({ allocatedAmount: "2000.00" });
        const preview = await previewLoanRenewal(
            context(seeded.tenantId, seeded.actor.id),
            seeded.oldLoan.publicId,
            { requestedPrincipal: "2500.00" },
        );

        await expect(executeLoanRenewal(
            context(seeded.tenantId, seeded.actor.id, "underfunded-renewal"),
            preview.publicId,
            { previewHash: preview.previewHash, confirmed: true, reason: "should remain pending" },
        )).rejects.toMatchObject({
            code: "INSUFFICIENT_FUNDING_ALLOCATION",
            status: 409,
            details: { availableFunding: "2000.00", requestedPrincipal: "2500.00" },
        });
        expect(await db.select().from(loans).where(eq(loans.clonedFromLoanId, seeded.oldLoan.id))).toHaveLength(0);
    });

    // Break caught: reversal cancels a replacement loan that still has an unreversed borrower repayment.
    integrationTest("blocks reversal until downstream replacement-loan entries are reversed", async () => {
        const seeded = await seedDailyLoan();
        const preview = await previewLoanRenewal(
            context(seeded.tenantId, seeded.actor.id), seeded.oldLoan.publicId, { requestedPrincipal: "2500.00" },
        );
        const executed = await executeLoanRenewal(
            context(seeded.tenantId, seeded.actor.id, "execute-before-blocked-reverse"),
            preview.publicId,
            { previewHash: preview.previewHash, confirmed: true, reason: "execute for reversal guard" },
        );
        const replacement = await db.query.loans.findFirst({ where: eq(loans.publicId, executed.newLoanPublicId) });
        const schedule = await db.query.loanSchedules.findFirst({ where: eq(loanSchedules.loanId, replacement!.id) });
        await db.insert(transactions).values({
            tenantId: seeded.tenantId,
            ownerUserId: seeded.actor.id,
            loanId: replacement!.id,
            scheduleId: schedule!.id,
            amount: "190.00",
            principalComponent: "166.67",
            interestComponent: "23.33",
            feeComponent: "0.00",
            penaltyComponent: "0.00",
            entryType: "repayment",
            idempotencyKey: "downstream-replacement-payment",
            recordedByUserId: seeded.actor.id,
        });

        await expect(reverseLoanRenewal(
            context(seeded.tenantId, seeded.actor.id, "blocked-renewal-reverse"),
            preview.publicId,
            { reason: "incorrect renewal" },
        )).rejects.toMatchObject({
            code: "RENEWAL_REVERSE_BLOCKED",
            status: 409,
            details: { downstreamEntryCount: 1 },
        });
        expect(await db.query.loanRenewals.findFirst({ where: eq(loanRenewals.publicId, preview.publicId) }))
            .toMatchObject({ status: "executed" });
        expect(await db.query.loans.findFirst({ where: eq(loans.id, replacement!.id) }))
            .toMatchObject({ status: "active" });
    });

    // Break caught: reversal cancels a replacement loan while leaving a downstream funding allocation attached.
    integrationTest("blocks reversal after replacement-loan funding changes", async () => {
        const seeded = await seedDailyLoan();
        const preview = await previewLoanRenewal(
            context(seeded.tenantId, seeded.actor.id), seeded.oldLoan.publicId, { requestedPrincipal: "2500.00" },
        );
        const executed = await executeLoanRenewal(
            context(seeded.tenantId, seeded.actor.id, "execute-before-funding-guard"),
            preview.publicId,
            { previewHash: preview.previewHash, confirmed: true, reason: "execute before funding change" },
        );
        const replacement = await db.query.loans.findFirst({ where: eq(loans.publicId, executed.newLoanPublicId) });
        await db.insert(loanFundingAllocations).values({
            tenantId: seeded.tenantId,
            bankProfileId: seeded.profile.id,
            bankLoanId: seeded.drawdown.id,
            loanId: replacement!.id,
            allocatedAmount: "1.00",
            allocationDate: replacement!.startDate!,
            allocationType: "manual_adjustment",
            note: "Downstream funding correction",
            createdByUserId: seeded.actor.id,
        });

        await expect(reverseLoanRenewal(
            context(seeded.tenantId, seeded.actor.id, "funding-blocked-reverse"),
            preview.publicId,
            { reason: "must reverse funding first" },
        )).rejects.toMatchObject({
            code: "RENEWAL_REVERSE_BLOCKED",
            status: 409,
            details: { downstreamEntryCount: 1 },
        });
        expect(await db.query.loans.findFirst({ where: eq(loans.id, replacement!.id) }))
            .toMatchObject({ status: "active" });
    });

    // Break caught: reversal deletes execution rows or fails to restore old/new loan and funding states exactly once.
    integrationTest("reverses by appending compensations and preserves the replacement schedule", async () => {
        const seeded = await seedDailyLoan();
        const preview = await previewLoanRenewal(
            context(seeded.tenantId, seeded.actor.id), seeded.oldLoan.publicId, { requestedPrincipal: "2500.00" },
        );
        const executed = await executeLoanRenewal(
            context(seeded.tenantId, seeded.actor.id, "execute-before-successful-reverse"),
            preview.publicId,
            { previewHash: preview.previewHash, confirmed: true, reason: "execute for reversal" },
        );
        const replacement = await db.query.loans.findFirst({ where: eq(loans.publicId, executed.newLoanPublicId) });
        const reverse = () => reverseLoanRenewal(
            context(seeded.tenantId, seeded.actor.id, "successful-renewal-reverse"),
            preview.publicId,
            { reason: "operator corrected renewal" },
        );

        const first = await reverse();
        const retry = await reverse();

        expect(retry).toEqual(first);
        expect(first).toMatchObject({
            publicId: preview.publicId,
            status: "reversed",
            oldLoanPublicId: seeded.oldLoan.publicId,
            newLoanPublicId: replacement!.publicId,
            reason: "operator corrected renewal",
        });
        expect(await db.query.loans.findFirst({ where: eq(loans.id, seeded.oldLoan.id) }))
            .toMatchObject({ status: "active" });
        expect(await db.query.loans.findFirst({ where: eq(loans.id, replacement!.id) }))
            .toMatchObject({ status: "canceled" });
        expect(await db.select().from(loanSchedules).where(eq(loanSchedules.loanId, replacement!.id))).toHaveLength(15);

        const renewal = await db.query.loanRenewals.findFirst({ where: eq(loanRenewals.publicId, preview.publicId) });
        const adjustments = await db.select().from(loanAdjustments)
            .where(eq(loanAdjustments.renewalId, renewal!.id)).orderBy(loanAdjustments.id);
        expect(adjustments.map((row) => ({ type: row.adjustmentType, amount: row.amount, status: row.status }))).toEqual([
            { type: "principal_transfer", amount: "833.30", status: "reversed" },
            { type: "cash_payout", amount: "1666.70", status: "reversed" },
            { type: "reversal", amount: "-833.30", status: "posted" },
            { type: "reversal", amount: "-1666.70", status: "posted" },
        ]);
        expect(adjustments.slice(2).map((row) => row.reversedAdjustmentId)).toEqual(adjustments.slice(0, 2).map((row) => row.id));

        const oldFunding = await db.select().from(loanFundingAllocations)
            .where(eq(loanFundingAllocations.loanId, seeded.oldLoan.id)).orderBy(loanFundingAllocations.id);
        const newFunding = await db.select().from(loanFundingAllocations)
            .where(eq(loanFundingAllocations.loanId, replacement!.id)).orderBy(loanFundingAllocations.id);
        expect(oldFunding.map((row) => row.allocatedAmount)).toEqual(["2500.00", "-2500.00", "2500.00"]);
        expect(newFunding.map((row) => row.allocatedAmount)).toEqual(["2500.00", "-2500.00"]);
        expect(await db.select().from(auditLogs).where(and(
            eq(auditLogs.entityId, preview.publicId),
            eq(auditLogs.action, "reversed"),
        ))).toHaveLength(1);
    });
});
