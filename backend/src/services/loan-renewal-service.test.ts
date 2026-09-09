import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import Decimal from "decimal.js";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import {
    auditLogs,
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
import {
    allocateFundingByLargestRemainder,
    executeLoanRenewal,
    previewLoanRenewal,
    reverseLoanRenewal,
} from "./loan-renewal-service";

const integrationEnabled = Boolean(process.env.TEST_DATABASE_URL);
const integrationTest = integrationEnabled ? test : test.skip;

async function resetRenewalTables() {
    await db.execute(sql`TRUNCATE TABLE
        audit_logs, loan_adjustments, loan_renewal_adjustment_lines, loan_renewals, fund_ledger_entries,
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

async function seedDailyLoan(options: {
    paidInstallments?: number;
    allocatedAmount?: string;
    lateFeeMode?: "none" | "daily_percent";
    lateFeeAmount?: string;
    principalAmount?: string;
    interestRate?: string;
    installmentAmount?: string;
    totalInstallments?: number;
} = {}) {
    const paidInstallments = options.paidInstallments ?? 10;
    const principalAmount = options.principalAmount ?? "2500.00";
    const interestRate = options.interestRate ?? "14.00";
    const installmentAmount = options.installmentAmount ?? "190.00";
    const totalInstallments = options.totalInstallments ?? 15;
    const seedId = crypto.randomUUID();
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
        principalAmount,
        interestRate,
        repaymentType: "daily",
        termMonths: 1,
        installmentAmount,
        totalInstallments,
        startDate: utcDateOffset(-10),
        outstandingPrincipal: principalAmount, // intentionally stale: renewal must use posted principal
        outstandingInterest: new Decimal(installmentAmount).times(totalInstallments).minus(principalAmount).toFixed(2),
        outstandingFees: "0.00",
        lateFeeMode: options.lateFeeMode ?? "none",
        lateFeeAmount: options.lateFeeAmount ?? "0.00",
        status: "active",
    }).returning().then((rows) => rows[0]!);
    const generated = generateLoanSchedule({
        principal: principalAmount,
        interestRate,
        repaymentType: "daily",
        termMonths: 1,
        installmentAmount,
        totalInstallments,
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
            idempotencyKey: `seed-payment-${seedId}-${schedule.installmentNo}`,
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
        allocatedAmount: options.allocatedAmount ?? principalAmount,
        allocationDate: oldLoan.startDate!,
        allocationType: "initial",
        createdByUserId: actor.id,
    });
    return { tenantId, actor, borrower, oldLoan, schedules, profile, drawdown };
}

describe("daily-loan renewal service", () => {
    if (integrationEnabled) beforeEach(async () => {
        setSystemTime(new Date("2026-08-31T12:00:00.000Z"));
        await resetRenewalTables();
    });
    if (integrationEnabled) afterEach(() => setSystemTime());

    test("distributes uneven funding in integer cents with an exact deterministic sum", () => {
        const allocation = allocateFundingByLargestRemainder([
            { bankProfileId: 1, bankLoanId: 11, amount: new Decimal("1.00") },
            { bankProfileId: 2, bankLoanId: 22, amount: new Decimal("2.00") },
            { bankProfileId: 3, bankLoanId: 33, amount: new Decimal("3.00") },
        ], new Decimal("0.05"));

        expect(allocation.map((row) => row.carryAmount.toFixed(2))).toEqual(["0.01", "0.02", "0.02"]);
        expect(allocation.every((row) => row.carryAmount.gte(0))).toBe(true);
        expect(allocation.reduce((sum, row) => sum.plus(row.carryAmount), new Decimal(0)).toFixed(2)).toBe("0.05");
    });

    test("never makes the final source negative when many one-cent sources share a smaller request", () => {
        const allocation = allocateFundingByLargestRemainder(
            Array.from({ length: 5 }, (_, index) => ({
                bankProfileId: index + 1,
                bankLoanId: index + 101,
                amount: new Decimal("0.01"),
            })),
            new Decimal("0.03"),
        );

        expect(allocation.map((row) => row.carryAmount.toFixed(2))).toEqual(["0.01", "0.01", "0.01", "0.00", "0.00"]);
        expect(allocation.every((row) => row.carryAmount.gte(0))).toBe(true);
        expect(allocation.reduce((sum, row) => sum.plus(row.carryAmount), new Decimal(0)).toFixed(2)).toBe("0.03");
    });

    integrationTest("persists exact renewal composition and enforces immutable tenant-safe adjustment lines", async () => {
        const seeded = await seedDailyLoan({ paidInstallments: 0 });
        const audit = await db.insert(auditLogs).values({
            tenantId: seeded.tenantId,
            entityType: "loan_renewal",
            entityId: seeded.oldLoan.publicId,
            action: "previewed",
            actorUserId: seeded.actor.id,
            actorSource: "web",
            requestId: "renewal-adjustment-schema",
            correlationId: "renewal-adjustment-schema",
        }).returning().then((rows) => rows[0]!);
        const renewal = await db.insert(loanRenewals).values({
            tenantId: seeded.tenantId,
            oldLoanId: seeded.oldLoan.id,
            status: "preview",
            previewHash: `v1:${"1".repeat(64)}`,
            settlementPolicy: "full_contract_interest",
            composition: {
                settlementPolicy: "full_contract_interest",
                contractStartDate: seeded.oldLoan.startDate!,
                contractDueDate: seeded.schedules.at(-1)!.dueDate,
                renewalDate: seeded.oldLoan.startDate!,
                requestedPrincipal: "2500.00",
                originalPrincipal: "2500.00",
                totalScheduledAmount: "2850.00",
                contractualInterest: "350.00",
                totalPaid: "0.00",
                receivedPrincipal: "0.00",
                receivedInterest: "0.00",
                remainingContractInterest: "350.00",
                accruedDueInterest: "0.00",
                dueFees: "0.00",
                duePenalties: "0.00",
                recoveredBeforeAdjustments: "0.00",
                manualCharges: "0.00",
                manualWaivers: "0.00",
                settlementAmount: "350.00",
                cashDirection: "collection",
                cashAmount: "350.00",
                payments: [],
                adjustments: [],
            },
            requestedPrincipal: "2500.00",
            outstandingPrincipal: "2375.00",
            dueCharges: "0.00",
            waivedCharges: "0.00",
            cashDirection: "payout",
            cashAmount: "125.00",
            expiresAt: new Date(Date.now() + 60_000),
            createdByUserId: seeded.actor.id,
        }).returning().then((rows) => rows[0]!);
        const line = {
            tenantId: seeded.tenantId,
            renewalId: renewal.id,
            lineNo: 1,
            kind: "other_charge" as const,
            amount: "25.00",
            reason: "Documented collection expense",
            status: "posted" as const,
            actorSource: "web",
            requestId: "renewal-adjustment-schema",
            correlationId: "renewal-adjustment-schema",
            idempotencyKey: "renewal-adjustment-schema:1",
            auditPublicId: audit.publicId,
            createdByUserId: seeded.actor.id,
        };
        const inserted = await db.insert(loanRenewalAdjustmentLines).values(line).returning().then((rows) => rows[0]!);
        const expectRejected = (operation: PromiseLike<unknown>) => expect(Promise.resolve(operation)).rejects.toBeDefined();

        expect(inserted).toMatchObject({ lineNo: 1, kind: "other_charge", amount: "25.00", status: "posted" });
        await expectRejected(db.insert(loanRenewalAdjustmentLines).values({ ...line, idempotencyKey: "renewal-adjustment-schema:duplicate" }));
        await expectRejected(db.insert(loanRenewalAdjustmentLines).values({ ...line, lineNo: 2, amount: "0.00", idempotencyKey: "renewal-adjustment-schema:zero" }));
        await expectRejected(db.insert(loanRenewalAdjustmentLines).values({ ...line, lineNo: 3, amount: "-1.00", idempotencyKey: "renewal-adjustment-schema:negative" }));
        await expectRejected(db.insert(loanRenewalAdjustmentLines).values({ ...line, lineNo: 4, kind: "invalid" as "fee", idempotencyKey: "renewal-adjustment-schema:kind" }));
        await expectRejected(db.insert(loanRenewalAdjustmentLines).values({ ...line, lineNo: 5, status: "invalid" as "posted", idempotencyKey: "renewal-adjustment-schema:status" }));
        await expectRejected(db.insert(loanRenewalAdjustmentLines).values({ ...line, tenantId: "tenant-other", lineNo: 6, idempotencyKey: "renewal-adjustment-schema:tenant" }));
        await expectRejected(db.update(loanRenewalAdjustmentLines).set({ reason: "mutated" }).where(eq(loanRenewalAdjustmentLines.id, inserted.id)));
        await expectRejected(db.delete(loanRenewalAdjustmentLines).where(eq(loanRenewalAdjustmentLines.id, inserted.id)));
    });

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
            dueCharges: "116.70",
            settlementAmount: "116.70",
            waivedCharges: "0.00",
            requestedPrincipal: "2500.00",
            cashDirection: "payout",
            cashAmount: "1550.00",
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
            dueCharges: "116.70",
            waivedCharges: "0.00",
            cashDirection: "payout",
            cashAmount: "1550.00",
        });
        expect(await db.select().from(auditLogs).where(and(
            eq(auditLogs.entityId, preview.publicId),
            eq(auditLogs.action, "previewed"),
        ))).toHaveLength(1);
    });

    integrationTest("defaults to full-contract interest and previews an exact 600 payout without financial side effects", async () => {
        const seeded = await seedDailyLoan({
            principalAmount: "2000.00",
            interestRate: "20.00",
            installmentAmount: "100.00",
            totalInstallments: 24,
            paidInstallments: 10,
        });
        const fundingBefore = await db.select().from(loanFundingAllocations);

        const preview = await previewLoanRenewal(
            context(seeded.tenantId, seeded.actor.id),
            seeded.oldLoan.publicId,
            { requestedPrincipal: "2000.00" },
        );

        expect(preview.composition).toMatchObject({
            settlementPolicy: "full_contract_interest",
            contractualInterest: "400.00",
            totalPaid: "1000.00",
            receivedPrincipal: "833.40",
            receivedInterest: "166.60",
            remainingContractInterest: "233.40",
            recoveredBeforeAdjustments: "600.00",
            cashDirection: "payout",
            cashAmount: "600.00",
        });
        expect(preview).toMatchObject({ settlementPolicy: "full_contract_interest", cashDirection: "payout", cashAmount: "600.00" });
        expect(await db.select().from(loanAdjustments)).toHaveLength(0);
        expect(await db.select().from(loans).where(eq(loans.clonedFromLoanId, seeded.oldLoan.id))).toHaveLength(0);
        expect(await db.select().from(loanFundingAllocations)).toEqual(fundingBefore);
    });

    integrationTest("freezes an explicit renewal date separately from the first payment date", async () => {
        setSystemTime(new Date("2026-08-24T02:00:00.000Z"));
        try {
            const seeded = await seedDailyLoan({ paidInstallments: 0 });
            const preview = await previewLoanRenewal(
                context(seeded.tenantId, seeded.actor.id), seeded.oldLoan.publicId,
                { requestedPrincipal: "2500.00", renewalDate: "2026-08-22", paymentStartDate: "2026-08-24" },
            );
            expect(preview).toMatchObject({ renewalDate: "2026-08-22", paymentStartDate: "2026-08-24" });
            expect(preview.composition.renewalDate).toBe("2026-08-22");
            const persisted = await db.query.loanRenewals.findFirst({ where: eq(loanRenewals.publicId, preview.publicId) });
            expect(persisted).toMatchObject({ renewalDate: "2026-08-22", paymentStartDate: "2026-08-24" });

            const executed = await executeLoanRenewal(
                context(seeded.tenantId, seeded.actor.id, "explicit-renewal-dates-execute"), preview.publicId,
                { previewHash: preview.previewHash, confirmed: true, reason: "execute dated renewal", confirmedCashDirection: "collection" },
            );
            const replacement = await db.query.loans.findFirst({ where: eq(loans.publicId, executed.newLoanPublicId) });
            const firstSchedule = await db.query.loanSchedules.findFirst({ where: eq(loanSchedules.loanId, replacement!.id) });
            expect(replacement).toMatchObject({ startDate: "2026-08-22", paymentStartDate: "2026-08-24", nextDueDate: "2026-08-24" });
            expect(firstSchedule?.dueDate).toBe("2026-08-24");
        } finally {
            setSystemTime();
        }
    });

    integrationTest("executes the exact full-interest 600 payout without rewriting original repayments", async () => {
        const seeded = await seedDailyLoan({
            principalAmount: "2000.00",
            interestRate: "20.00",
            installmentAmount: "100.00",
            totalInstallments: 24,
            paidInstallments: 10,
        });
        const tenth = await db.query.transactions.findFirst({ where: and(
            eq(transactions.loanId, seeded.oldLoan.id), eq(transactions.scheduleId, seeded.schedules[9]!.id),
        ) });
        await db.update(transactions).set({ principalComponent: "83.36", interestComponent: "16.64" })
            .where(eq(transactions.id, tenth!.id));
        const originals = await db.select().from(transactions).where(eq(transactions.loanId, seeded.oldLoan.id)).orderBy(transactions.id);
        const preview = await previewLoanRenewal(
            context(seeded.tenantId, seeded.actor.id), seeded.oldLoan.publicId, { requestedPrincipal: "2000.00" },
        );
        await expect(executeLoanRenewal(
            context(seeded.tenantId, seeded.actor.id, "unexpected-collection-confirmation"), preview.publicId,
            { previewHash: preview.previewHash, confirmed: true, reason: "invalid extra confirmation", confirmedCashDirection: "collection" },
        )).rejects.toMatchObject({ code: "UNEXPECTED_RENEWAL_COLLECTION_CONFIRMATION", status: 400 });
        const executed = await executeLoanRenewal(
            context(seeded.tenantId, seeded.actor.id, "exact-600-execute"), preview.publicId,
            { previewHash: preview.previewHash, confirmed: true, reason: "renew exact daily contract" },
        );

        expect(executed).toMatchObject({
            settlementPolicy: "full_contract_interest",
            oldLoanPublicId: seeded.oldLoan.publicId,
            requestedPrincipal: "2000.00",
            cashDirection: "payout",
            cashAmount: "600.00",
        });
        const replacement = await db.query.loans.findFirst({ where: eq(loans.publicId, executed.newLoanPublicId) });
        const replacementSchedule = await db.select().from(loanSchedules).where(eq(loanSchedules.loanId, replacement!.id));
        expect(await db.query.loans.findFirst({ where: eq(loans.id, seeded.oldLoan.id) })).toMatchObject({ status: "renewed" });
        expect(replacement).toMatchObject({ status: "active", principalAmount: "2000.00" });
        expect(replacementSchedule.reduce((total, row) => total.plus(row.scheduledTotal), new Decimal(0)).toFixed(2)).toBe("2400.00");
        const oldTransactions = await db.select().from(transactions).where(eq(transactions.loanId, seeded.oldLoan.id)).orderBy(transactions.id);
        expect(oldTransactions.slice(0, originals.length)).toEqual(originals);
        expect(oldTransactions).toHaveLength(originals.length + 1);
        expect(oldTransactions.at(-1)).toMatchObject({ type: "close_account", entryType: "repayment" });
        const renewal = await db.query.loanRenewals.findFirst({ where: eq(loanRenewals.publicId, preview.publicId) });
        expect((await db.select().from(loanAdjustments).where(eq(loanAdjustments.renewalId, renewal!.id)).orderBy(loanAdjustments.id))
            .map((row) => ({ type: row.adjustmentType, amount: row.amount }))).toEqual([
            { type: "principal_transfer", amount: "1166.58" },
            { type: "contract_interest_settlement", amount: "233.42" },
            { type: "cash_payout", amount: "600.00" },
        ]);
    });

    integrationTest("posts every reasoned manual adjustment line and its linked accounting entry", async () => {
        const seeded = await seedDailyLoan();
        const preview = await previewLoanRenewal(
            context(seeded.tenantId, seeded.actor.id), seeded.oldLoan.publicId, {
                requestedPrincipal: "2500.00",
                adjustments: [
                    { kind: "fee", amount: "5.00", reason: "Manual fee" },
                    { kind: "penalty", amount: "4.00", reason: "Manual penalty" },
                    { kind: "other_charge", amount: "3.00", reason: "Other cost" },
                    { kind: "waiver", amount: "2.00", reason: "Approved waiver" },
                ],
            },
        );
        await executeLoanRenewal(
            context(seeded.tenantId, seeded.actor.id, "manual-lines-execute"), preview.publicId,
            { previewHash: preview.previewHash, confirmed: true, reason: "execute manual composition" },
        );
        const renewal = await db.query.loanRenewals.findFirst({ where: eq(loanRenewals.publicId, preview.publicId) });
        expect((await db.select().from(loanRenewalAdjustmentLines).where(eq(loanRenewalAdjustmentLines.renewalId, renewal!.id)).orderBy(loanRenewalAdjustmentLines.lineNo))
            .map(({ lineNo, kind, amount, reason, status }) => ({ lineNo, kind, amount, reason, status }))).toEqual([
            { lineNo: 1, kind: "fee", amount: "5.00", reason: "Manual fee", status: "posted" },
            { lineNo: 2, kind: "penalty", amount: "4.00", reason: "Manual penalty", status: "posted" },
            { lineNo: 3, kind: "other_charge", amount: "3.00", reason: "Other cost", status: "posted" },
            { lineNo: 4, kind: "waiver", amount: "2.00", reason: "Approved waiver", status: "posted" },
        ]);
        expect((await db.select().from(loanAdjustments).where(eq(loanAdjustments.renewalId, renewal!.id)))
            .filter((row) => row.adjustmentType.startsWith("manual_"))
            .map(({ adjustmentType, amount, reason }) => ({ adjustmentType, amount, reason }))).toEqual([
            { adjustmentType: "manual_fee", amount: "5.00", reason: "Manual fee" },
            { adjustmentType: "manual_penalty", amount: "4.00", reason: "Manual penalty" },
            { adjustmentType: "manual_other_charge", amount: "3.00", reason: "Other cost" },
            { adjustmentType: "manual_waiver", amount: "2.00", reason: "Approved waiver" },
        ]);
        await reverseLoanRenewal(
            context(seeded.tenantId, seeded.actor.id, "manual-lines-reverse"), preview.publicId,
            { reason: "reverse manual composition" },
        );
        const reversedLines = await db.select().from(loanRenewalAdjustmentLines)
            .where(eq(loanRenewalAdjustmentLines.renewalId, renewal!.id)).orderBy(loanRenewalAdjustmentLines.lineNo);
        expect(reversedLines.slice(0, 4).map((line) => line.status)).toEqual(["posted", "posted", "posted", "posted"]);
        expect(reversedLines.slice(4).map(({ lineNo, kind, amount, status, reversesLineId }) => ({ lineNo, kind, amount, status, reversesLineId }))).toEqual([
            { lineNo: 5, kind: "fee", amount: "5.00", status: "reversed", reversesLineId: reversedLines[0]!.id },
            { lineNo: 6, kind: "penalty", amount: "4.00", status: "reversed", reversesLineId: reversedLines[1]!.id },
            { lineNo: 7, kind: "other_charge", amount: "3.00", status: "reversed", reversesLineId: reversedLines[2]!.id },
            { lineNo: 8, kind: "waiver", amount: "2.00", status: "reversed", reversesLineId: reversedLines[3]!.id },
        ]);
    });

    integrationTest("freezes explicit accrued policy and ordered adjustments while adapting legacy waivers", async () => {
        const seeded = await seedDailyLoan({ paidInstallments: 9 });
        const preview = await previewLoanRenewal(
            context(seeded.tenantId, seeded.actor.id),
            seeded.oldLoan.publicId,
            {
                requestedPrincipal: "2500.00",
                settlementPolicy: "accrued_to_date",
                adjustments: [
                    { kind: "other_charge", amount: "5.00", reason: "Document expense" },
                    { kind: "waiver", amount: "3.00", reason: "Approved concession" },
                ],
            },
        );
        expect(preview.composition).toMatchObject({
            settlementPolicy: "accrued_to_date",
            adjustments: [
                { lineNo: 1, kind: "other_charge", amount: "5.00", reason: "Document expense" },
                { lineNo: 2, kind: "waiver", amount: "3.00", reason: "Approved concession" },
            ],
        });
        expect(await db.query.loanRenewals.findFirst({ where: eq(loanRenewals.publicId, preview.publicId) }))
            .toMatchObject({ settlementPolicy: "accrued_to_date", composition: preview.composition });

        const legacy = await previewLoanRenewal(
            context(seeded.tenantId, seeded.actor.id),
            seeded.oldLoan.publicId,
            { requestedPrincipal: "2500.00", waivedCharges: "1.00", waiverReason: "Legacy waiver" },
        );
        expect(legacy.composition.adjustments).toEqual([
            { lineNo: 1, kind: "waiver", amount: "1.00", reason: "Legacy waiver" },
        ]);

        await expect(previewLoanRenewal(
            context(seeded.tenantId, seeded.actor.id),
            seeded.oldLoan.publicId,
            {
                requestedPrincipal: "2500.00",
                adjustments: [{ kind: "fee", amount: "1.00", reason: "New input" }],
                waivedCharges: "1.00",
                waiverReason: "Legacy input",
            },
        )).rejects.toMatchObject({ code: "RENEWAL_ADJUSTMENT_INPUT_CONFLICT", status: 400 });
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
            dueCharges: "280.01",
            cashDirection: "payout",
            cashAmount: "220.00",
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
            dueCharges: "140.03",
            settlementAmount: "140.03",
            cashDirection: "payout",
            cashAmount: "1360.00",
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
            { requestedPrincipal: "2500.00", waivedCharges: "140.04", waiverReason: "incorrect late charge" },
        )).rejects.toMatchObject({ code: "RENEWAL_WAIVER_EXCEEDS_ELIGIBLE_CHARGES", status: 400 });

        const preview = await previewLoanRenewal(
            context(seeded.tenantId, seeded.actor.id),
            seeded.oldLoan.publicId,
            { requestedPrincipal: "2500.00", waivedCharges: "23.33", waiverReason: "approved hardship waiver" },
        );
        expect(preview).toMatchObject({
            dueCharges: "140.03",
            waivedCharges: "23.33",
            settlementAmount: "116.70",
            cashAmount: "1383.33",
            waiverReason: "approved hardship waiver",
        });
        const persisted = await db.query.loanRenewals.findFirst({ where: eq(loanRenewals.publicId, preview.publicId) });
        expect(persisted?.reason).toBe("approved hardship waiver");
    });

    integrationTest("records cash collection and post-execution charge settlement and waiver entries", async () => {
        const seeded = await seedDailyLoan({ paidInstallments: 9 });
        const preview = await previewLoanRenewal(
            context(seeded.tenantId, seeded.actor.id),
            seeded.oldLoan.publicId,
            { requestedPrincipal: "1000.00", waivedCharges: "3.33", waiverReason: "approved partial waiver" },
        );
        expect(preview).toMatchObject({
            outstandingPrincipal: "999.97",
            dueCharges: "140.03",
            settlementAmount: "136.70",
            cashDirection: "collection",
            cashAmount: "136.67",
        });
        await expect(executeLoanRenewal(
            context(seeded.tenantId, seeded.actor.id, "missing-collection-confirmation"), preview.publicId,
            { previewHash: preview.previewHash, confirmed: true, reason: "missing collection confirmation" },
        )).rejects.toMatchObject({ code: "RENEWAL_COLLECTION_CONFIRMATION_REQUIRED", status: 400 });
        await executeLoanRenewal(
            context(seeded.tenantId, seeded.actor.id, "execute-cash-collection"), preview.publicId,
            { previewHash: preview.previewHash, confirmed: true, reason: "collect renewal shortfall", confirmedCashDirection: "collection" },
        );
        const renewal = await db.query.loanRenewals.findFirst({ where: eq(loanRenewals.publicId, preview.publicId) });
        const adjustments = await db.select().from(loanAdjustments)
            .where(eq(loanAdjustments.renewalId, renewal!.id)).orderBy(loanAdjustments.id);
        expect(adjustments.map((row) => ({ type: row.adjustmentType, amount: row.amount }))).toEqual([
            { type: "principal_transfer", amount: "999.97" },
            { type: "contract_interest_settlement", amount: "140.03" },
            { type: "manual_waiver", amount: "3.33" },
            { type: "cash_collection", amount: "136.67" },
        ]);
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
            cashAmount: "1550.00",
            reason: "borrower requested renewal",
        });
        expect(first.newLoanPublicId).toMatch(/^[0-9a-f-]{36}$/);

        const oldLoan = await db.query.loans.findFirst({ where: eq(loans.id, seeded.oldLoan.id) });
        const replacement = await db.query.loans.findFirst({ where: eq(loans.publicId, first.newLoanPublicId) });
        expect(oldLoan).toMatchObject({
            status: "renewed",
            outstandingPrincipal: "0.00",
            outstandingInterest: "0.00",
            outstandingFees: "0.00",
            nextDueDate: null,
        });
        expect((await db.select().from(loanSchedules).where(eq(loanSchedules.loanId, seeded.oldLoan.id)))
            .every((row) => row.status === "paid" && row.remainingDue === "0.00")).toBe(true);
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
        const renewalRow = await db.query.loanRenewals.findFirst({ where: eq(loanRenewals.publicId, preview.publicId) });
        const replacementFunding = await db.select().from(loanFundingAllocations)
            .where(eq(loanFundingAllocations.loanId, replacement!.id)).orderBy(loanFundingAllocations.id);
        expect(replacementFunding).toEqual([expect.objectContaining({
                bankProfileId: seeded.profile.id,
                bankLoanId: seeded.drawdown.id,
                allocatedAmount: "1500.00",
                allocationType: "reallocation_in",
                renewalId: renewalRow!.id,
            }), expect.objectContaining({
                bankProfileId: secondProfile.id,
                bankLoanId: secondDrawdown.id,
                allocatedAmount: "1000.00",
                allocationType: "reallocation_in",
                renewalId: renewalRow!.id,
            })]);
        expect(new Set(replacementFunding.map((row) => row.allocationGroupId)).size).toBe(1);
        expect(replacementFunding[0]!.allocationGroupId).toMatch(/^[0-9a-f-]{36}$/);
        expect((await db.select().from(loanAdjustments).where(eq(loanAdjustments.renewalId,
            renewalRow!.id,
        )).orderBy(loanAdjustments.id)).map((row) => ({ type: row.adjustmentType, amount: row.amount }))).toEqual([
            { type: "principal_transfer", amount: "833.30" },
            { type: "contract_interest_settlement", amount: "116.70" },
            { type: "cash_payout", amount: "1550.00" },
        ]);
        const renewalSettlement = await db.select().from(transactions).where(and(
            eq(transactions.loanId, seeded.oldLoan.id),
            eq(transactions.type, "close_account"),
            eq(transactions.entryType, "repayment"),
        ));
        expect(renewalSettlement).toHaveLength(1);
        expect(renewalSettlement[0]).toMatchObject({
            amount: "950.00",
            principalComponent: "833.30",
            interestComponent: "116.70",
            paymentIntakeId: null,
            notes: "Renewal settlement — final installment paid from renewal proceeds",
        });
        expect(await db.select().from(transactions).where(eq(transactions.loanId, replacement!.id))).toHaveLength(0);
        expect(await db.select().from(auditLogs).where(and(
            eq(auditLogs.entityId, preview.publicId),
            eq(auditLogs.action, "executed"),
        ))).toHaveLength(1);
    });

    integrationTest("resolves concurrent same-key executions of different renewals as one success and one stable conflict", async () => {
        const firstSeed = await seedDailyLoan();
        const secondSeed = await seedDailyLoan();
        const firstPreview = await previewLoanRenewal(
            context(firstSeed.tenantId, firstSeed.actor.id), firstSeed.oldLoan.publicId, { requestedPrincipal: "2500.00" },
        );
        const secondPreview = await previewLoanRenewal(
            context(secondSeed.tenantId, secondSeed.actor.id), secondSeed.oldLoan.publicId, { requestedPrincipal: "2500.00" },
        );
        let releaseLock!: () => void;
        let markLocked!: () => void;
        const release = new Promise<void>((resolve) => { releaseLock = resolve; });
        const locked = new Promise<void>((resolve) => { markLocked = resolve; });
        const blocker = db.transaction(async (tx) => {
            await tx.execute(sql`SELECT id FROM loans WHERE id IN (${firstSeed.oldLoan.id}, ${secondSeed.oldLoan.id}) ORDER BY id FOR UPDATE`);
            markLocked();
            await release;
        });
        await locked;
        const execute = (seeded: typeof firstSeed, preview: typeof firstPreview) => executeLoanRenewal(
            context(seeded.tenantId, seeded.actor.id, "shared-concurrent-execution-key"),
            preview.publicId,
            { previewHash: preview.previewHash, confirmed: true, reason: "concurrent different renewal" },
        );
        const firstPending = execute(firstSeed, firstPreview);
        const secondPending = execute(secondSeed, secondPreview);
        await Bun.sleep(20);
        releaseLock();
        await blocker;
        const settled = await Promise.allSettled([firstPending, secondPending]);

        expect(settled.filter((row) => row.status === "fulfilled")).toHaveLength(1);
        const rejected = settled.find((row) => row.status === "rejected") as PromiseRejectedResult;
        expect(rejected.reason).toMatchObject({ code: "IDEMPOTENCY_KEY_CONFLICT", status: 409 });
        const replacements = await db.select().from(loans).where(sql`${loans.clonedFromLoanId} IS NOT NULL`);
        expect(replacements).toHaveLength(1);
        expect(await db.select().from(loanSchedules).where(eq(loanSchedules.loanId, replacements[0]!.id))).toHaveLength(15);
        expect(await db.select().from(loanAdjustments)).toHaveLength(3);
        expect(await db.select().from(loanRenewals).where(eq(loanRenewals.status, "executed"))).toHaveLength(1);
        expect(await db.select().from(loanRenewals).where(eq(loanRenewals.status, "preview"))).toHaveLength(1);
        expect(await db.select().from(auditLogs).where(eq(auditLogs.action, "executed"))).toHaveLength(1);
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

    integrationTest("expires a preview after the old loan funding state changes", async () => {
        const seeded = await seedDailyLoan();
        const preview = await previewLoanRenewal(
            context(seeded.tenantId, seeded.actor.id), seeded.oldLoan.publicId, { requestedPrincipal: "2500.00" },
        );
        await db.insert(loanFundingAllocations).values({
            tenantId: seeded.tenantId,
            bankProfileId: seeded.profile.id,
            bankLoanId: seeded.drawdown.id,
            loanId: seeded.oldLoan.id,
            allocatedAmount: "1.00",
            allocationDate: seeded.oldLoan.startDate!,
            allocationType: "manual_adjustment",
            createdByUserId: seeded.actor.id,
        });

        await expect(executeLoanRenewal(
            context(seeded.tenantId, seeded.actor.id, "funding-stale-renewal"),
            preview.publicId,
            { previewHash: preview.previewHash, confirmed: true, reason: "stale funding attempt" },
        )).rejects.toMatchObject({ code: "STALE_RENEWAL_PREVIEW", status: 409 });
        expect(await db.select().from(loanAdjustments).where(eq(loanAdjustments.renewalId,
            (await db.query.loanRenewals.findFirst({ where: eq(loanRenewals.publicId, preview.publicId) }))!.id,
        ))).toHaveLength(0);
    });

    integrationTest("expires and rejects a preview whose explicit TTL has elapsed", async () => {
        const seeded = await seedDailyLoan();
        const preview = await previewLoanRenewal(
            context(seeded.tenantId, seeded.actor.id), seeded.oldLoan.publicId, { requestedPrincipal: "2500.00" },
        );
        await db.update(loanRenewals).set({ expiresAt: new Date(Date.now() - 1_000) })
            .where(eq(loanRenewals.publicId, preview.publicId));

        await expect(executeLoanRenewal(
            context(seeded.tenantId, seeded.actor.id, "expired-renewal-preview"), preview.publicId,
            { previewHash: preview.previewHash, confirmed: true, reason: "expired attempt" },
        )).rejects.toMatchObject({ code: "STALE_RENEWAL_PREVIEW", status: 409 });
        expect(await db.query.loanRenewals.findFirst({ where: eq(loanRenewals.publicId, preview.publicId) }))
            .toMatchObject({ status: "expired", newLoanId: null });
    });

    integrationTest("expires a preview when a due day and daily penalty change before its TTL", async () => {
        setSystemTime(new Date("2026-08-10T23:59:00.000Z"));
        try {
            const seeded = await seedDailyLoan({ lateFeeMode: "daily_percent", lateFeeAmount: "1.00" });
            const preview = await previewLoanRenewal(
                context(seeded.tenantId, seeded.actor.id), seeded.oldLoan.publicId, { requestedPrincipal: "2500.00" },
            );
            expect(preview.dueCharges).toBe("116.70");
            await db.update(loanRenewals).set({ createdAt: new Date("2026-08-10T23:59:00.000Z") })
                .where(eq(loanRenewals.publicId, preview.publicId));

            setSystemTime(new Date("2026-08-11T00:01:00.000Z"));
            await expect(executeLoanRenewal(
                context(seeded.tenantId, seeded.actor.id, "midnight-stale-renewal"),
                preview.publicId,
                { previewHash: preview.previewHash, confirmed: true, reason: "crossed due boundary" },
            )).rejects.toMatchObject({ code: "STALE_RENEWAL_PREVIEW", status: 409 });
            expect(await db.query.loanRenewals.findFirst({ where: eq(loanRenewals.publicId, preview.publicId) }))
                .toMatchObject({ status: "expired", newLoanId: null });
        } finally {
            setSystemTime();
        }
    });

    integrationTest("falls back to a stable preview TTL when the environment value is invalid", async () => {
        const previous = process.env.RENEWAL_PREVIEW_TTL_SECONDS;
        process.env.RENEWAL_PREVIEW_TTL_SECONDS = "not-a-number";
        setSystemTime(new Date("2026-08-10T12:00:00.000Z"));
        try {
            const seeded = await seedDailyLoan();
            const preview = await previewLoanRenewal(
                context(seeded.tenantId, seeded.actor.id), seeded.oldLoan.publicId, { requestedPrincipal: "2500.00" },
            );
            expect(preview.expiresAt.toISOString()).toBe("2026-08-10T12:15:00.000Z");
        } finally {
            setSystemTime();
            if (previous === undefined) delete process.env.RENEWAL_PREVIEW_TTL_SECONDS;
            else process.env.RENEWAL_PREVIEW_TTL_SECONDS = previous;
        }
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
        const downstreamPayment = await db.insert(transactions).values({
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
        }).returning().then((rows) => rows[0]!);

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

        await db.insert(transactions).values({
            tenantId: seeded.tenantId,
            ownerUserId: seeded.actor.id,
            loanId: replacement!.id,
            scheduleId: schedule!.id,
            amount: "-190.00",
            principalComponent: "-166.67",
            interestComponent: "-23.33",
            feeComponent: "0.00",
            penaltyComponent: "0.00",
            entryType: "reversal",
            reversedTransactionId: downstreamPayment.id,
            idempotencyKey: "reverse-downstream-replacement-payment",
            recordedByUserId: seeded.actor.id,
        });
        const reversed = await reverseLoanRenewal(
            context(seeded.tenantId, seeded.actor.id, "reverse-after-downstream-reversal"), preview.publicId,
            { reason: "downstream payment was reversed" },
        );
        expect(reversed.status).toBe("reversed");
    });

    integrationTest("locks the reloaded replacement loan before checking a racing payment", async () => {
        const seeded = await seedDailyLoan();
        const preview = await previewLoanRenewal(
            context(seeded.tenantId, seeded.actor.id), seeded.oldLoan.publicId, { requestedPrincipal: "2500.00" },
        );
        const executed = await executeLoanRenewal(
            context(seeded.tenantId, seeded.actor.id, "execute-before-payment-race"), preview.publicId,
            { previewHash: preview.previewHash, confirmed: true, reason: "prepare payment race" },
        );
        const replacement = await db.query.loans.findFirst({ where: eq(loans.publicId, executed.newLoanPublicId) });
        const schedule = await db.query.loanSchedules.findFirst({ where: eq(loanSchedules.loanId, replacement!.id) });
        let releaseLock!: () => void;
        let markLocked!: () => void;
        const release = new Promise<void>((resolve) => { releaseLock = resolve; });
        const locked = new Promise<void>((resolve) => { markLocked = resolve; });
        const payment = db.transaction(async (tx) => {
            await tx.execute(sql`SELECT id FROM loans WHERE id = ${replacement!.id} FOR UPDATE`);
            markLocked();
            await release;
            await tx.insert(transactions).values({
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
                idempotencyKey: "payment-racing-renewal-reversal",
                recordedByUserId: seeded.actor.id,
            });
        });
        await locked;
        const reversalPending = reverseLoanRenewal(
            context(seeded.tenantId, seeded.actor.id, "reverse-racing-payment"), preview.publicId,
            { reason: "must observe committed payment" },
        );
        await Bun.sleep(50);
        releaseLock();
        await payment;

        await expect(reversalPending).rejects.toMatchObject({
            code: "RENEWAL_REVERSE_BLOCKED",
            status: 409,
            details: { downstreamEntryCount: 1 },
        });
        expect(await db.query.loanRenewals.findFirst({ where: eq(loanRenewals.publicId, preview.publicId) }))
            .toMatchObject({ status: "executed" });
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
            allocationType: "reallocation_in",
            note: `Carried from loan ${seeded.oldLoan.publicId} via renewal ${preview.publicId}`,
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

    integrationTest("allows reversal after downstream funding reallocations are economically compensated", async () => {
        const seeded = await seedDailyLoan();
        const secondProfile = await db.insert(bankProfiles).values({
            tenantId: seeded.tenantId, name: "Compensation Fund", type: "bank",
        }).returning().then((rows) => rows[0]!);
        const secondDrawdown = await db.insert(bankLoans).values({
            tenantId: seeded.tenantId, bankProfileId: secondProfile.id, amount: "5000.00",
        }).returning().then((rows) => rows[0]!);
        const preview = await previewLoanRenewal(
            context(seeded.tenantId, seeded.actor.id), seeded.oldLoan.publicId, { requestedPrincipal: "2500.00" },
        );
        const executed = await executeLoanRenewal(
            context(seeded.tenantId, seeded.actor.id, "execute-before-compensated-funding"), preview.publicId,
            { previewHash: preview.previewHash, confirmed: true, reason: "test funding lifecycle" },
        );
        const replacement = await db.query.loans.findFirst({ where: eq(loans.publicId, executed.newLoanPublicId) });
        await db.insert(loanFundingAllocations).values([
            {
                tenantId: seeded.tenantId, bankProfileId: seeded.profile.id, bankLoanId: seeded.drawdown.id,
                loanId: replacement!.id, allocatedAmount: "-100.00", allocationDate: replacement!.startDate!,
                allocationType: "reallocation_out", allocationGroupId: crypto.randomUUID(), createdByUserId: seeded.actor.id,
            },
            {
                tenantId: seeded.tenantId, bankProfileId: secondProfile.id, bankLoanId: secondDrawdown.id,
                loanId: replacement!.id, allocatedAmount: "100.00", allocationDate: replacement!.startDate!,
                allocationType: "reallocation_in", allocationGroupId: crypto.randomUUID(), createdByUserId: seeded.actor.id,
            },
            {
                tenantId: seeded.tenantId, bankProfileId: secondProfile.id, bankLoanId: secondDrawdown.id,
                loanId: replacement!.id, allocatedAmount: "-100.00", allocationDate: replacement!.startDate!,
                allocationType: "reallocation_out", allocationGroupId: crypto.randomUUID(), createdByUserId: seeded.actor.id,
            },
            {
                tenantId: seeded.tenantId, bankProfileId: seeded.profile.id, bankLoanId: seeded.drawdown.id,
                loanId: replacement!.id, allocatedAmount: "100.00", allocationDate: replacement!.startDate!,
                allocationType: "reallocation_in", allocationGroupId: crypto.randomUUID(), createdByUserId: seeded.actor.id,
            },
        ]);

        const reversed = await reverseLoanRenewal(
            context(seeded.tenantId, seeded.actor.id, "reverse-after-compensated-funding"), preview.publicId,
            { reason: "downstream funding is net zero" },
        );
        expect(reversed.status).toBe("reversed");
    });

    integrationTest("restores an active fully-settled old loan from its exact pre-execution state", async () => {
        const seeded = await seedDailyLoan({ paidInstallments: 15 });
        await db.update(loans).set({
            status: "active",
            outstandingPrincipal: "0.00",
            outstandingInterest: "0.00",
            outstandingFees: "0.00",
            nextDueDate: null,
        }).where(eq(loans.id, seeded.oldLoan.id));
        const preview = await previewLoanRenewal(
            context(seeded.tenantId, seeded.actor.id), seeded.oldLoan.publicId, { requestedPrincipal: "2500.00" },
        );
        await executeLoanRenewal(
            context(seeded.tenantId, seeded.actor.id, "execute-active-zero-state"), preview.publicId,
            { previewHash: preview.previewHash, confirmed: true, reason: "state restoration case" },
        );
        const persisted = await db.query.loanRenewals.findFirst({ where: eq(loanRenewals.publicId, preview.publicId) });
        expect(persisted?.preExecutionLoanState).toEqual({
            status: "active",
            outstandingPrincipal: "0.00",
            outstandingInterest: "0.00",
            outstandingFees: "0.00",
            nextDueDate: null,
        });

        await reverseLoanRenewal(
            context(seeded.tenantId, seeded.actor.id, "reverse-active-zero-state"), preview.publicId,
            { reason: "restore original state" },
        );
        expect(await db.query.loans.findFirst({ where: eq(loans.id, seeded.oldLoan.id) })).toMatchObject({
            status: "active",
            outstandingPrincipal: "0.00",
            outstandingInterest: "0.00",
            outstandingFees: "0.00",
            nextDueDate: null,
        });
    });

    integrationTest("restores an originally paid old loan as paid", async () => {
        const seeded = await seedDailyLoan({ paidInstallments: 15 });
        await db.update(loans).set({
            status: "paid", outstandingPrincipal: "0.00", outstandingInterest: "0.00", outstandingFees: "0.00",
        }).where(eq(loans.id, seeded.oldLoan.id));
        const preview = await previewLoanRenewal(
            context(seeded.tenantId, seeded.actor.id), seeded.oldLoan.publicId, { requestedPrincipal: "2500.00" },
        );
        await executeLoanRenewal(
            context(seeded.tenantId, seeded.actor.id, "execute-paid-state"), preview.publicId,
            { previewHash: preview.previewHash, confirmed: true, reason: "paid state case" },
        );
        await reverseLoanRenewal(
            context(seeded.tenantId, seeded.actor.id, "reverse-paid-state"), preview.publicId,
            { reason: "restore paid state" },
        );
        expect(await db.query.loans.findFirst({ where: eq(loans.id, seeded.oldLoan.id) }))
            .toMatchObject({ status: "paid", outstandingPrincipal: "0.00" });
    });

    integrationTest("reloads execution state when reversal was queued behind execution", async () => {
        const seeded = await seedDailyLoan();
        const preview = await previewLoanRenewal(
            context(seeded.tenantId, seeded.actor.id), seeded.oldLoan.publicId, { requestedPrincipal: "2500.00" },
        );
        let releaseLock!: () => void;
        let markLocked!: () => void;
        const release = new Promise<void>((resolve) => { releaseLock = resolve; });
        const locked = new Promise<void>((resolve) => { markLocked = resolve; });
        const blocker = db.transaction(async (tx) => {
            await tx.execute(sql`SELECT id FROM loans WHERE id = ${seeded.oldLoan.id} FOR UPDATE`);
            markLocked();
            await release;
        });
        await locked;
        const executionPending = executeLoanRenewal(
            context(seeded.tenantId, seeded.actor.id, "execute-before-queued-reverse"), preview.publicId,
            { previewHash: preview.previewHash, confirmed: true, reason: "execute while queued" },
        );
        await Bun.sleep(100);
        const reversalPending = reverseLoanRenewal(
            context(seeded.tenantId, seeded.actor.id, "queued-reverse-after-execute"), preview.publicId,
            { reason: "reverse immediately after execution" },
        );
        await Bun.sleep(20);
        releaseLock();
        await blocker;
        const [executed, reversed] = await Promise.all([executionPending, reversalPending]);
        expect(executed.status).toBe("executed");
        expect(reversed.status).toBe("reversed");
        expect(await db.query.loans.findFirst({ where: eq(loans.publicId, executed.newLoanPublicId) }))
            .toMatchObject({ status: "canceled" });
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

        await expect(reverseLoanRenewal(
            context(seeded.tenantId, seeded.actor.id, "different-renewal-reversal-key"),
            preview.publicId,
            { reason: "operator corrected renewal" },
        )).rejects.toMatchObject({ code: "REVERSAL_IDEMPOTENCY_CONFLICT", status: 409 });
        await expect(reverseLoanRenewal(
            context(seeded.tenantId, seeded.actor.id, "successful-renewal-reverse"),
            preview.publicId,
            { reason: "changed retry payload" },
        )).rejects.toMatchObject({ code: "REVERSAL_IDEMPOTENCY_CONFLICT", status: 409 });

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
            { type: "contract_interest_settlement", amount: "116.70", status: "reversed" },
            { type: "cash_payout", amount: "1550.00", status: "reversed" },
            { type: "reversal", amount: "-833.30", status: "posted" },
            { type: "reversal", amount: "-116.70", status: "posted" },
            { type: "reversal", amount: "-1550.00", status: "posted" },
        ]);
        expect(adjustments.slice(3).map((row) => row.reversedAdjustmentId)).toEqual(adjustments.slice(0, 3).map((row) => row.id));

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
