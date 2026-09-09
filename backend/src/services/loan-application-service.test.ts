import { beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import Decimal from "decimal.js";
import { and, eq, sql } from "drizzle-orm";
import { Elysia } from "elysia";
import { db } from "../db";
import { auditLogs, bankLoans, bankProfiles, borrowers, loanDisbursements, loanFundingAllocations, loanInterestAccruals, loanInterestRatePeriods, loanReplacements, loanSchedules, loans, transactions, users } from "../db/schema";
import { loansRoute } from "../modules/loans";
import type { CommandContext } from "./command-context";
import { createBorrower } from "./borrower-service";
import {
    activateLoan,
    createLoanDraft,
    getLoanApplication,
    previewLoan,
    updateLoanDraft,
} from "./loan-application-service";
import { accrueFloatingInterestThrough, correctFloatingInterestAccruals } from "./floating-interest-service";
import { getLoanPaymentHealth } from "./loan-payment-health-service";
import { seedReplacementFixture } from "./loan-replacement-test-fixture";

const integrationEnabled = Boolean(process.env.TEST_DATABASE_URL);
const integrationTest = integrationEnabled ? test : test.skip;

async function resetApplicationTables() {
    await db.execute(sql`SET client_min_messages TO WARNING`);
    await db.execute(sql`TRUNCATE TABLE audit_logs, borrower_aliases, loan_schedules, loans, borrowers, users, bank_loans, bank_profiles RESTART IDENTITY CASCADE`);
}

async function seedUser(tenantId: string, email: string, role: "owner" | "manager" | "collector" | "viewer") {
    return db.insert(users).values({ tenantId, email, role }).returning().then((rows) => rows[0]!);
}

function context(tenantId: string, actorUserId: number, idempotencyKey = "loan-task-3"): CommandContext {
    return {
        tenantId,
        actorUserId,
        actorSource: "web",
        requestId: "req-loan-task-3",
        correlationId: "corr-loan-task-3",
        idempotencyKey,
    };
}

const terms = {
    principal: "1200.00",
    interestRate: "12.00",
    repaymentType: "monthly" as const,
    termMonths: 3,
    totalInstallments: 3,
    startDate: "2026-08-10",
};

const weeklyAdvanceTerms = {
    principal: "5000.00",
    interestRate: "0.00",
    repaymentType: "floating" as const,
    termMonths: 1,
    startDate: "2026-08-13",
    floatingInterestPolicy: {
        periodUnit: "week" as const,
        periodLength: 1 as const,
        rateMode: "percent" as const,
        rate: "12",
        advanceInterestPeriods: 1 as const,
        advanceInterestRefundPolicy: "non_refundable" as const,
    },
};

async function authToken(user: { id: number; email: string; role: string | null; tenantId: string }) {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const header = encode({ alg: "HS256", typ: "JWT" });
    const payload = encode({ id: user.id, email: user.email, role: user.role, tenantId: user.tenantId });
    const unsigned = `${header}.${payload}`;
    const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(process.env.JWT_SECRET ?? "dev_jwt_secret_change_me"),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
    );
    const signature = Buffer.from(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(unsigned))).toString("base64url");
    return `${unsigned}.${signature}`;
}

async function jsonRequest(app: { handle(request: Request): Response | Promise<Response> }, path: string, init: RequestInit = {}) {
    const response = await app.handle(new Request(`http://localhost${path}`, init));
    const text = await response.text();
    return { response, body: text ? JSON.parse(text) : null, text };
}

describe("loan application service", () => {
    // Break caught: preview returns floating-point money or persists a loan.
    test("previews exact public schedule money without persistence", () => {
        const preview = previewLoan(terms);
        expect(preview.schedule).toHaveLength(3);
        expect(preview.terms).toMatchObject({ principal: "1200.00", interestRate: "12.00", totalInstallments: 3, installmentAmount: "412.00" });
        expect(preview.schedule[0]).toMatchObject({ amount: "412.00", principalComponent: "400.00" });
    });

    // Break caught: the service normalizes a maximum principal correctly but its calculator silently rounds the resulting schedule.
    test("previews the 29-digit maximum exactly at zero rate and rejects nonzero overflow", () => {
        const maximum = "99999999999999999999999999999.99";
        expect(previewLoan({ principal: maximum, interestRate: "0.00", repaymentType: "monthly", termMonths: 1, startDate: "2026-08-10" }))
            .toMatchObject({ terms: { principal: maximum }, schedule: [{ amount: maximum, principalComponent: maximum, interestComponent: "0.00", remainingPrincipal: "0.00" }] });
        expect(() => previewLoan({ principal: maximum, interestRate: "12.00", repaymentType: "monthly", termMonths: 1, startDate: "2026-08-10" }))
            .toThrow("Money must be a non-negative string with exactly two decimals");
    });

    test("previews a daily-entry loan with derived terms and calculation", () => {
        const preview = previewLoan({
            principal: "2500.00",
            interestRate: "0.00",
            repaymentType: "daily",
            termMonths: 1,
            startDate: "2026-08-10",
            dailyEntry: { durationUnit: "days", durationValue: 15, entryMode: "daily_payment", dailyPayment: "200.00" },
        });

        expect(preview.terms).toMatchObject({ totalInstallments: 15, installmentAmount: "200.00", interestRate: "0.00" });
        expect(preview.dailyLoanCalculation).toMatchObject({ totalInterest: "500.00", totalInstallments: 15, flatDailyRatePercent: "1.3333" });
        expect(preview.schedule).toHaveLength(15);
    });

    // Break caught: a weekly contractual rate is treated as a daily rate or only one day is deducted in advance.
    test("previews an exact weekly floating policy with one advance period", () => {
        expect(previewLoan(weeklyAdvanceTerms)).toMatchObject({
            floatingInterestPolicy: {
                periodUnit: "week",
                periodLength: 1,
                rateMode: "percent",
                rate: "12.0000",
                advanceInterestPeriods: 1,
                advanceInterestRefundPolicy: "non_refundable",
            },
            fullPeriodInterest: "600.00",
            advanceInterest: "600.00",
            netBorrowerPayout: "4400.00",
            firstPeriodStartDate: "2026-08-13",
            firstPeriodDueDate: "2026-08-20",
            periodDays: 7,
            schedule: [],
        });
    });

    // Break caught: the additive generalized policy removes the established
    // daily-only request adapter or returns a different normalized projection.
    test("adapts the legacy daily-only floating policy request", () => {
        expect(previewLoan({
            principal: "5000.00",
            interestRate: "0.00",
            repaymentType: "floating",
            termMonths: 1,
            startDate: "2026-08-13",
            floatingDailyInterest: { mode: "percent", rate: "12", firstDayTreatment: "deduct" },
        })).toMatchObject({
            floatingInterestPolicy: {
                periodUnit: "day", periodLength: 1, rateMode: "percent", rate: "12.0000",
                advanceInterestPeriods: 1, advanceInterestRefundPolicy: "non_refundable",
            },
            floatingDailyInterest: {
                mode: "percent", rate: "12.0000", firstDayTreatment: "deduct", accrualCycle: "daily",
            },
        });
    });

    if (integrationEnabled) beforeEach(resetApplicationTables);

    // Break caught: activation posts only one day of advance interest, omits immutable period snapshots, or duplicates them on retry.
    integrationTest("posts one weekly advance charge and seven paid first-period snapshots exactly once", async () => {
        const actor = await seedUser("tenant-a", "weekly-advance@example.test", "collector");
        const ctx = context("tenant-a", actor.id, "weekly-advance-activation");
        const borrower = await createBorrower(ctx, { name: "Weekly Advance Borrower" });
        const draft = await createLoanDraft(ctx, { borrowerPublicId: borrower.publicId, ...weeklyAdvanceTerms });
        expect(draft).toMatchObject({
            status: "draft",
            floatingInterestPolicy: { ...weeklyAdvanceTerms.floatingInterestPolicy, rate: "12.0000" },
            floatingDailyInterest: {
                mode: "percent", rate: "12.0000", firstDayTreatment: "deduct", accrualCycle: "weekly",
            },
            floatingPayoutSummary: {
                fullPeriodInterest: "600.00",
                advanceInterest: "600.00",
                netBorrowerPayout: "4400.00",
                periodDays: 7,
                firstPeriodStartDate: "2026-08-13",
                firstPeriodDueDate: "2026-08-20",
            },
        });

        const stored = await db.query.loans.findFirst({ where: eq(loans.publicId, draft.publicId) });
        expect(stored).toMatchObject({
            interestPeriodUnit: "week",
            interestPeriodLength: 1,
            advanceInterestPeriods: 1,
            advanceInterestRefundPolicy: "non_refundable",
            interestPeriodAnchorDate: "2026-08-13",
        });

        const firstActivation = await activateLoan(ctx, draft.publicId);

        const firstSnapshots = await db.select().from(loanInterestAccruals)
            .where(eq(loanInterestAccruals.loanId, stored!.id))
            .orderBy(loanInterestAccruals.accrualDate);
        expect(firstSnapshots).toHaveLength(7);
        expect(firstSnapshots.map((row) => ({
            accrualDate: row.accrualDate,
            interestAmount: row.interestAmount,
            cumulativeInterestAmount: row.cumulativeInterestAmount,
            periodDayIndex: row.periodDayIndex,
            status: row.status,
        }))).toEqual([
            { accrualDate: "2026-08-13", interestAmount: "85.71", cumulativeInterestAmount: "85.71", periodDayIndex: 1, status: "paid" },
            { accrualDate: "2026-08-14", interestAmount: "85.72", cumulativeInterestAmount: "171.43", periodDayIndex: 2, status: "paid" },
            { accrualDate: "2026-08-15", interestAmount: "85.71", cumulativeInterestAmount: "257.14", periodDayIndex: 3, status: "paid" },
            { accrualDate: "2026-08-16", interestAmount: "85.72", cumulativeInterestAmount: "342.86", periodDayIndex: 4, status: "paid" },
            { accrualDate: "2026-08-17", interestAmount: "85.71", cumulativeInterestAmount: "428.57", periodDayIndex: 5, status: "paid" },
            { accrualDate: "2026-08-18", interestAmount: "85.72", cumulativeInterestAmount: "514.29", periodDayIndex: 6, status: "paid" },
            { accrualDate: "2026-08-19", interestAmount: "85.71", cumulativeInterestAmount: "600.00", periodDayIndex: 7, status: "paid" },
        ]);
        expect(firstSnapshots.reduce((sum, row) => sum.plus(row.interestAmount), new Decimal(0)).toFixed(2)).toBe("600.00");
        expect(firstSnapshots.every((row) => row.paidAmount === row.interestAmount
            && row.contractualInterestAmount === "600.00"
            && row.periodStartDate === "2026-08-13"
            && row.periodEndDate === "2026-08-20"
            && row.periodUnit === "week"
            && row.periodLength === 1
            && row.dailyIncrementAmount === row.interestAmount)).toBe(true);

        expect(await db.select().from(loanDisbursements).where(eq(loanDisbursements.loanId, stored!.id))).toMatchObject([{
            grossPrincipal: "5000.00",
            firstDayInterestDeducted: "600.00",
            netDisbursement: "4400.00",
            createdByUserId: actor.id,
        }]);
        const [activationAudit] = await db.select().from(auditLogs).where(and(
            eq(auditLogs.entityId, draft.publicId),
            eq(auditLogs.action, "activated"),
        ));
        expect(activationAudit).toMatchObject({
            actorUserId: actor.id,
            actorSource: "web",
            requestId: "req-loan-task-3",
            correlationId: "corr-loan-task-3",
            payload: {
                advanceInterest: "600.00",
                advanceInterestSnapshotCount: 7,
                idempotencyKey: "weekly-advance-activation",
            },
        });

        await db.update(loans).set({ status: "closed", outstandingPrincipal: "0.00" }).where(eq(loans.id, stored!.id));
        const replayed = await activateLoan(context("tenant-a", actor.id, "weekly-advance-activation"), draft.publicId);
        expect(replayed).toEqual(firstActivation);
        expect(await db.select().from(loanInterestAccruals).where(eq(loanInterestAccruals.loanId, stored!.id))).toHaveLength(7);
        expect(await db.select().from(loanDisbursements).where(eq(loanDisbursements.loanId, stored!.id))).toHaveLength(1);
        expect(await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, draft.publicId), eq(auditLogs.action, "activated")))).toHaveLength(1);
    });

    // Break caught: a new key can replay an already-consumed activation command and receive resource-state success.
    integrationTest("rejects a different idempotency key for an already-activated loan", async () => {
        const actor = await seedUser("tenant-a", "activation-different-key@example.test", "collector");
        const firstCtx = context("tenant-a", actor.id, "activation-original-key");
        const borrower = await createBorrower(firstCtx, { name: "Different Activation Key Borrower" });
        const draft = await createLoanDraft(firstCtx, { borrowerPublicId: borrower.publicId, ...terms });
        await activateLoan(firstCtx, draft.publicId);

        await expect(activateLoan(context("tenant-a", actor.id, "activation-different-key"), draft.publicId))
            .rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_CONFLICT", status: 409 });
    });

    // Break caught: one tenant-scoped activation key can be consumed by two different loan commands.
    integrationTest("rejects reuse of an activation key for another loan in the same tenant", async () => {
        const actor = await seedUser("tenant-a", "activation-reused-key@example.test", "collector");
        const ctx = context("tenant-a", actor.id, "tenant-activation-key");
        const firstBorrower = await createBorrower(ctx, { name: "First Activation Key Borrower" });
        const secondBorrower = await createBorrower(ctx, { name: "Second Activation Key Borrower" });
        const firstDraft = await createLoanDraft(ctx, { borrowerPublicId: firstBorrower.publicId, ...terms });
        const secondDraft = await createLoanDraft(ctx, { borrowerPublicId: secondBorrower.publicId, ...terms });
        await activateLoan(ctx, firstDraft.publicId);

        await expect(activateLoan(ctx, secondDraft.publicId))
            .rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_CONFLICT", status: 409 });
        const secondStored = await db.query.loans.findFirst({ where: eq(loans.publicId, secondDraft.publicId) });
        expect(secondStored?.status).toBe("draft");
        expect(await db.select().from(loanSchedules).where(eq(loanSchedules.loanId, secondStored!.id))).toHaveLength(0);
    });

    // Break caught: a financial activation can be posted without an idempotency identity.
    integrationTest("requires an idempotency key before activating a loan", async () => {
        const actor = await seedUser("tenant-a", "activation-idempotency@example.test", "collector");
        const ctx = context("tenant-a", actor.id);
        const borrower = await createBorrower(ctx, { name: "Activation Idempotency Borrower" });
        const draft = await createLoanDraft(ctx, { borrowerPublicId: borrower.publicId, ...terms });

        await expect(activateLoan({ ...ctx, idempotencyKey: undefined }, draft.publicId))
            .rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REQUIRED", status: 400 });
        expect(await db.select().from(loanSchedules)).toHaveLength(0);
    });

    // Break caught: PUT accepts a generalized floating policy but leaves the draft and initial rate-period snapshot unchanged.
    integrationTest("updates a weekly floating draft policy and its initial rate period together", async () => {
        const actor = await seedUser("tenant-a", "weekly-draft-edit@example.test", "collector");
        const ctx = context("tenant-a", actor.id);
        const borrower = await createBorrower(ctx, { name: "Weekly Draft Edit Borrower" });
        const draft = await createLoanDraft(ctx, { borrowerPublicId: borrower.publicId, ...weeklyAdvanceTerms });

        const updated = await updateLoanDraft(ctx, draft.publicId, {
            startDate: "2026-08-14",
            floatingInterestPolicy: {
                periodUnit: "week",
                periodLength: 1,
                rateMode: "per_thousand",
                rate: "25",
                advanceInterestPeriods: 0,
                advanceInterestRefundPolicy: "non_refundable",
            },
        });
        expect(updated).toMatchObject({
            startDate: "2026-08-14",
            floatingInterestPolicy: {
                periodUnit: "week",
                rateMode: "per_thousand",
                rate: "25.0000",
                advanceInterestPeriods: 0,
            },
            floatingPayoutSummary: {
                fullPeriodInterest: "125.00",
                advanceInterest: "0.00",
                netBorrowerPayout: "5000.00",
                periodDays: 7,
                firstPeriodStartDate: "2026-08-14",
                firstPeriodDueDate: "2026-08-21",
            },
        });

        const stored = await db.query.loans.findFirst({ where: eq(loans.publicId, draft.publicId) });
        expect(stored).toMatchObject({
            dailyInterestMode: "per_thousand",
            dailyInterestRate: "25.0000",
            interestPeriodAnchorDate: "2026-08-14",
            advanceInterestPeriods: 0,
        });
        expect(await db.select().from(loanInterestRatePeriods).where(eq(loanInterestRatePeriods.loanId, stored!.id))).toMatchObject([{
            effectiveDate: "2026-08-14",
            expiryDate: null,
            rateType: "per_thousand",
            rate: "25.0000",
            periodUnit: "week",
            periodLength: 1,
        }]);
    });

    // Break caught: POST-style creation activates immediately or retrying activation duplicates schedules.
    integrationTest("creates an editable draft and activates it exactly once", async () => {
        const actor = await seedUser("tenant-a", "loan-owner@example.test", "collector");
        const ctx = context("tenant-a", actor.id);
        const borrower = await createBorrower(ctx, { name: "Draft Borrower" });

        const draft = await createLoanDraft(ctx, { borrowerPublicId: borrower.publicId, ...terms });
        expect(draft).toMatchObject({ id: draft.publicId, status: "draft", principal: "1200.00" });
        expect(draft).not.toHaveProperty("borrowerId");
        expect(await db.select().from(loanSchedules)).toHaveLength(0);

        const edited = await updateLoanDraft(ctx, draft.publicId, {
            principal: "1500.00",
            interestRate: "10.00",
            termMonths: 3,
            totalInstallments: 3,
            installmentAmount: "512.50",
            repaymentType: "monthly",
            startDate: "2026-08-11",
        });
        expect(edited).toMatchObject({ status: "draft", principal: "1500.00", startDate: "2026-08-11" });

        const activated = await activateLoan(ctx, draft.publicId);
        expect(activated).toMatchObject({ status: "active", principal: "1500.00" });
        const firstSchedules = await db.select().from(loanSchedules);
        expect(firstSchedules).toHaveLength(3);

        const retried = await activateLoan(ctx, draft.publicId);
        expect(retried).toEqual(activated);
        expect(await db.select().from(loanSchedules)).toHaveLength(3);

        const history = await db.select().from(auditLogs).where(and(
            eq(auditLogs.entityId, draft.publicId),
        ));
        expect(history.map((entry) => entry.action)).toEqual(["draft_created", "draft_updated", "activated"]);
        expect(history).toEqual(expect.arrayContaining([
            expect.objectContaining({
                tenantId: "tenant-a",
                actorUserId: actor.id,
                actorSource: "web",
                requestId: "req-loan-task-3",
                correlationId: "corr-loan-task-3",
            }),
        ]));
        expect(history[0]?.payload).toMatchObject({
            before: null,
            after: { publicId: draft.publicId, status: "draft", principal: "1200.00" },
        });
        expect(history[1]?.payload).toMatchObject({
            before: { publicId: draft.publicId, status: "draft", principal: "1200.00" },
            after: { publicId: draft.publicId, status: "draft", principal: "1500.00" },
        });
        expect(history[2]?.payload).toMatchObject({
            before: { publicId: draft.publicId, status: "draft" },
            after: { publicId: draft.publicId, status: "active" },
            scheduleCount: 3,
        });
    });

    integrationTest("preserves rate-derived schedule totals after a count-only draft is activated", async () => {
        const actor = await seedUser("tenant-a", "derived-rounding@example.test", "collector");
        const ctx = context("tenant-a", actor.id, "derived-rounding");
        const borrower = await createBorrower(ctx, { name: "Derived Rounding Borrower" });

        const draft = await createLoanDraft(ctx, {
            borrowerPublicId: borrower.publicId,
            principal: "1010.00",
            interestRate: "0.00",
            repaymentType: "monthly",
            termMonths: 3,
            totalInstallments: 3,
            startDate: "2026-08-10",
        });
        expect(draft).toMatchObject({ totalInstallments: 3, installmentAmount: "336.67" });

        await activateLoan(ctx, draft.publicId);
        const schedule = await db.select().from(loanSchedules);
        expect(schedule.map((row) => row.scheduledTotal)).toEqual(["336.67", "336.67", "336.66"]);
    });

    // Break caught: single-payment terms are dropped from drafts, reconstructed
    // from interestRate at activation, or coupled to an actual payout record.
    integrationTest("round-trips and activates exact single-payment terms with direct capital", async () => {
        const actor = await seedUser("tenant-a", "single-payment@example.test", "owner");
        const ctx = context("tenant-a", actor.id, "single-payment-create");
        const borrower = await createBorrower(ctx, { name: "Single Payment Borrower" });
        const profile = await db.insert(bankProfiles).values({
            tenantId: "tenant-a",
            name: "Single Payment Capital",
            type: "personal_savings",
            accountingMode: "capital_pool",
            creditLimit: "6000.00",
        }).returning().then((rows) => rows[0]!);
        const singlePayment = {
            dueDate: "2026-08-19",
            fixedAgreedInterest: "500.00" as const,
            interestPolicy: "fixed_only" as const,
            latePenalty: { mode: "none" as const },
        };

        const draft = await createLoanDraft(ctx, {
            borrowerPublicId: borrower.publicId,
            bankProfilePublicId: profile.publicId,
            principal: "5000.00",
            interestRate: "99.00",
            repaymentType: "single_payment",
            termMonths: 1,
            startDate: "2026-08-10",
            singlePayment,
        });
        expect(draft).toMatchObject({
            status: "draft",
            principal: "5000.00",
            interestRate: "99.00",
            bankProfilePublicId: profile.publicId,
            nextDueDate: null,
            singlePayment: {
                dueDate: "2026-08-19",
                fixedAgreedInterest: "500.00",
                interestPolicy: "fixed_only",
                latePenalty: { mode: "none" },
            },
        });
        expect(await db.select().from(loanSchedules)).toHaveLength(0);

        const retroactiveEdit = await updateLoanDraft(context("tenant-a", actor.id, "single-payment-update-retroactive"), draft.publicId, {
            singlePayment: {
                dueDate: "2026-08-20",
                fixedAgreedInterest: "525.00",
                interestPolicy: "greater_of_fixed_or_retroactive",
                retroactiveInterest: { rateType: "percent_per_day", rate: "1.2500" },
                latePenalty: { mode: "fixed_amount_per_day", amountPerDay: "20.00", graceDays: 2 },
            },
        });
        expect(retroactiveEdit.singlePayment).toEqual({
            dueDate: "2026-08-20",
            fixedAgreedInterest: "525.00",
            interestPolicy: "greater_of_fixed_or_retroactive",
            retroactiveInterest: { rateType: "percent_per_day", rate: "1.2500" },
            latePenalty: { mode: "fixed_amount_per_day", amountPerDay: "20.00", graceDays: 2 },
        });

        const edited = await updateLoanDraft(context("tenant-a", actor.id, "single-payment-update-fixed"), draft.publicId, {
            principal: "5000.00",
            singlePayment: { ...singlePayment, fixedAgreedInterest: "500.00" },
        });
        expect(edited.singlePayment).toEqual({
            dueDate: "2026-08-19",
            fixedAgreedInterest: "500.00",
            interestPolicy: "fixed_only",
            latePenalty: { mode: "none" },
        });

        const activated = await activateLoan(context("tenant-a", actor.id, "single-payment-activate"), draft.publicId);
        expect(activated).toMatchObject({
            status: "active",
            principal: "5000.00",
            interestRate: "99.00",
            nextDueDate: "2026-08-19",
            outstandingPrincipal: "5000.00",
            outstandingInterest: "500.00",
            singlePayment: edited.singlePayment,
        });
        const stored = await db.query.loans.findFirst({ where: eq(loans.publicId, draft.publicId) });
        expect(stored).toMatchObject({
            singlePaymentDueDate: "2026-08-19",
            singlePaymentFixedAgreedInterest: "500.00",
            singlePaymentInterestPolicy: "fixed_only",
            singlePaymentRetroactiveRateType: null,
            singlePaymentRetroactiveRate: null,
            singlePaymentLatePenaltyMode: "none",
            singlePaymentLatePenaltyAmountPerDay: null,
            singlePaymentLatePenaltyGraceDays: null,
        });
        expect(await db.select().from(loanSchedules).where(eq(loanSchedules.loanId, stored!.id))).toMatchObject([{
            installmentNo: 1,
            dueDate: "2026-08-19",
            scheduledPrincipal: "5000.00",
            scheduledInterest: "500.00",
            scheduledTotal: "5500.00",
            remainingDue: "5500.00",
        }]);
        expect(await db.select().from(loanFundingAllocations).where(eq(loanFundingAllocations.loanId, stored!.id))).toMatchObject([{
            bankProfileId: profile.id,
            bankLoanId: null,
            allocatedAmount: "5000.00",
        }]);
        expect(await db.select().from(loanDisbursements).where(eq(loanDisbursements.loanId, stored!.id))).toHaveLength(0);

        await expect(updateLoanDraft(context("tenant-a", actor.id, "single-payment-locked"), draft.publicId, {
            singlePayment: { ...singlePayment, fixedAgreedInterest: "999.00" },
        })).rejects.toMatchObject({ code: "LOAN_TERMS_LOCKED", status: 409 });
    });

    // Break caught: draft updates silently discard explicit incompatible term
    // objects and carry periodic installment metadata into a type transition.
    integrationTest("rejects explicit incompatible terms and clears only inherited transition metadata", async () => {
        const actor = await seedUser("tenant-a", "closed-update@example.test", "owner");
        const ctx = context("tenant-a", actor.id, "closed-update-create");
        const borrower = await createBorrower(ctx, { name: "Closed Update Borrower" });
        const draft = await createLoanDraft(ctx, {
            borrowerPublicId: borrower.publicId,
            principal: "5000.00", interestRate: "12.00", repaymentType: "monthly", termMonths: 3,
            totalInstallments: 3, installmentAmount: "1800.00", startDate: "2026-08-10",
        });
        const singlePayment = {
            dueDate: "2026-08-19", fixedAgreedInterest: "500.00", interestPolicy: "fixed_only" as const,
            latePenalty: { mode: "none" as const },
        };

        const sameType = await updateLoanDraft(context("tenant-a", actor.id, "closed-update-preserve-monthly"), draft.publicId, {
            principal: "5100.00",
        });
        expect(sameType).toMatchObject({
            repaymentType: "monthly", totalInstallments: 3, installmentAmount: "1800.00",
        });

        await expect(updateLoanDraft(context("tenant-a", actor.id, "closed-update-reject-single"), draft.publicId, {
            singlePayment,
        })).rejects.toMatchObject({ code: "INVALID_LOAN_TERMS", status: 400 });

        const transitioned = await updateLoanDraft(context("tenant-a", actor.id, "closed-update-to-single"), draft.publicId, {
            repaymentType: "single_payment",
            termMonths: 1,
            singlePayment,
        });
        expect(transitioned).toMatchObject({
            repaymentType: "single_payment", totalInstallments: null, installmentAmount: null,
            singlePayment,
        });
        expect(await db.query.loans.findFirst({ where: eq(loans.publicId, draft.publicId) })).toMatchObject({
            repaymentType: "single_payment", totalInstallments: null, installmentAmount: null,
        });

        await expect(updateLoanDraft(context("tenant-a", actor.id, "closed-update-reject-floating"), draft.publicId, {
            floatingDailyInterest: {
                mode: "percent", rate: "1.0000", firstDayTreatment: "start_next_day", accrualCycle: "weekly",
            },
        })).rejects.toMatchObject({ code: "INVALID_LOAN_TERMS", status: 400 });

        const floating = await updateLoanDraft(context("tenant-a", actor.id, "closed-update-to-floating"), draft.publicId, {
            repaymentType: "floating",
            floatingDailyInterest: {
                mode: "percent", rate: "1.0000", firstDayTreatment: "start_next_day", accrualCycle: "weekly",
            },
        });
        expect(floating).toMatchObject({
            repaymentType: "floating", totalInstallments: null, installmentAmount: null, singlePayment: null,
            floatingDailyInterest: { accrualCycle: "weekly" },
        });
    });

    // Break caught: activation stores 108.00 outstanding for a 100.00 zero-interest loan split over 12 months.
    integrationTest("activation conserves non-even schedule and rollup money exactly", async () => {
        const actor = await seedUser("tenant-a", "conservation@example.test", "collector");
        const ctx = context("tenant-a", actor.id);
        const borrower = await createBorrower(ctx, { name: "Exact Borrower" });
        const draft = await createLoanDraft(ctx, {
            borrowerPublicId: borrower.publicId,
            principal: "100.00",
            interestRate: "0.00",
            repaymentType: "monthly",
            termMonths: 12,
            startDate: "2026-08-10",
        });

        const activated = await activateLoan(ctx, draft.publicId);
        const rows = await db.select().from(loanSchedules).orderBy(loanSchedules.installmentNo);
        const sum = (field: "scheduledPrincipal" | "scheduledInterest" | "scheduledTotal") =>
            rows.reduce((total, row) => total.plus(row[field]), new Decimal(0)).toFixed(2);

        expect(sum("scheduledPrincipal")).toBe("100.00");
        expect(sum("scheduledInterest")).toBe("0.00");
        expect(sum("scheduledTotal")).toBe("100.00");
        expect(rows.every((row) => new Decimal(row.scheduledPrincipal).plus(row.scheduledInterest)
            .plus(row.scheduledFee).toFixed(2) === row.scheduledTotal)).toBe(true);
        expect(activated).toMatchObject({ outstandingPrincipal: "100.00", outstandingInterest: "0.00" });
    });

    // Break caught: floating activation converts an exact numeric principal through Number before storing its rollup.
    integrationTest("keeps floating-loan activation principal exact beyond Number safe integers", async () => {
        const actor = await seedUser("tenant-a", "floating-exact@example.test", "collector");
        const ctx = context("tenant-a", actor.id);
        const borrower = await createBorrower(ctx, { name: "Floating Exact Borrower" });
        const draft = await createLoanDraft(ctx, {
            borrowerPublicId: borrower.publicId,
            principal: "9007199254740993.00",
            interestRate: "0.00",
            repaymentType: "floating",
            termMonths: 1,
            startDate: "2026-08-10",
            floatingInterestPolicy: {
                periodUnit: "day",
                periodLength: 1,
                rateMode: "per_thousand",
                rate: "1.0000",
                advanceInterestPeriods: 0,
                advanceInterestRefundPolicy: "non_refundable",
            },
        });

        const activated = await activateLoan(ctx, draft.publicId);
        expect(activated.outstandingPrincipal).toBe("9007199254740993.00");
        const stored = await db.query.loans.findFirst({ where: eq(loans.publicId, draft.publicId) });
        expect(await db.select().from(loanInterestRatePeriods).where(eq(loanInterestRatePeriods.loanId, stored!.id))).toMatchObject([{
            effectiveDate: "2026-08-10", expiryDate: null, rateType: "per_thousand", rate: "1.0000",
        }]);
    });

    // Break caught: normalizing the legacy daily adapter into generalized
    // columns makes start-next-day loans accrue on their anchor date.
    integrationTest("preserves the legacy start-next-day boundary in projection and materialization", async () => {
        const actor = await seedUser("tenant-legacy-start-next", "legacy-start-next@example.test", "collector");
        const createContext = context(actor.tenantId, actor.id, "legacy-start-next-create");
        const borrower = await createBorrower(createContext, { name: "Legacy Start Next Borrower" });
        const draft = await createLoanDraft(createContext, {
            borrowerPublicId: borrower.publicId,
            principal: "1000.00", interestRate: "0.00", repaymentType: "floating", termMonths: 1,
            startDate: "2026-08-10",
            floatingDailyInterest: {
                mode: "per_thousand", rate: "15", firstDayTreatment: "start_next_day", accrualCycle: "daily",
            },
        });
        await activateLoan(createContext, draft.publicId);
        const stored = (await db.query.loans.findFirst({ where: eq(loans.publicId, draft.publicId) }))!;
        expect(stored).toMatchObject({
            interestPeriodUnit: "day", interestPeriodLength: 1, advanceInterestPeriods: 0,
            interestPeriodAnchorDate: "2026-08-10", firstDayTreatment: "start_next_day",
        });

        expect(await getLoanPaymentHealth(db, stored, {
            asOf: new Date("2026-08-10T12:00:00+07:00"),
            context: context(actor.tenantId, actor.id, "legacy-start-next-health-anchor"),
        })).toMatchObject({
            status: "current", dueTodayAmount: "0.00", overdueAmount: "0.00",
            overdueItemCount: 0, maxOverdueDays: 0,
        });
        expect(await db.select().from(loanInterestAccruals).where(eq(loanInterestAccruals.loanId, stored.id))).toHaveLength(0);

        expect(await accrueFloatingInterestThrough(
            db,
            stored,
            new Date("2026-08-10T12:00:00+07:00"),
            context(actor.tenantId, actor.id, "legacy-start-next-materialize-anchor"),
        )).toHaveLength(0);

        expect(await getLoanPaymentHealth(db, stored, {
            asOf: new Date("2026-08-11T12:00:00+07:00"),
            context: context(actor.tenantId, actor.id, "legacy-start-next-health-first-day"),
        })).toMatchObject({
            status: "due_today", dueTodayAmount: "15.00", overdueAmount: "0.00",
            overdueItemCount: 0, maxOverdueDays: 0,
        });
        const materialized = await accrueFloatingInterestThrough(
            db,
            stored,
            new Date("2026-08-11T12:00:00+07:00"),
            context(actor.tenantId, actor.id, "legacy-start-next-materialize-first-day"),
        );
        expect(materialized).toHaveLength(1);
        expect(materialized[0]).toMatchObject({
            accrualDate: "2026-08-11", interestAmount: "15.00", status: "accrued",
        });
    });

    // Break caught: the legacy scheduled-loan close endpoints bypass floating accrual,
    // reviewed preview, confirmation, idempotency, and append-only settlement history.
    integrationTest("rejects floating loans from both legacy close endpoints without mutation", async () => {
        const actor = await seedUser("tenant-a", "floating-legacy-close@example.test", "owner");
        const ctx = context("tenant-a", actor.id, "floating-legacy-close-activation");
        const borrower = await createBorrower(ctx, { name: "Floating Legacy Close Borrower" });
        const draft = await createLoanDraft(ctx, { borrowerPublicId: borrower.publicId, ...weeklyAdvanceTerms });
        await activateLoan(ctx, draft.publicId);
        const stored = await db.query.loans.findFirst({ where: eq(loans.publicId, draft.publicId) });
        const before = {
            loan: stored,
            audits: await db.select().from(auditLogs).where(eq(auditLogs.entityId, draft.publicId)),
            accruals: await db.select().from(loanInterestAccruals).where(eq(loanInterestAccruals.loanId, stored!.id)),
            transactions: await db.select().from(transactions).where(eq(transactions.loanId, stored!.id)),
        };
        const headers = {
            authorization: `Bearer ${await authToken(actor)}`,
            "content-type": "application/json",
        };
        const app = new Elysia().use(loansRoute);

        const summary = await jsonRequest(app, `/loans/${draft.publicId}/closing-summary`, { headers });
        const close = await jsonRequest(app, `/loans/${draft.publicId}/close`, {
            method: "POST",
            headers,
            body: JSON.stringify({ note: "Must use reviewed settlement" }),
        });

        expect(summary.response.status, summary.text).toBe(409);
        expect(summary.body).toEqual({
            code: "FLOATING_SETTLEMENT_REQUIRED",
            error: "Floating loans require the preview-and-execute settlement workflow",
        });
        expect(close.response.status, close.text).toBe(409);
        expect(close.body).toEqual(summary.body);
        expect(await db.query.loans.findFirst({ where: eq(loans.id, stored!.id) })).toEqual(before.loan);
        expect(await db.select().from(auditLogs).where(eq(auditLogs.entityId, draft.publicId))).toEqual(before.audits);
        expect(await db.select().from(loanInterestAccruals).where(eq(loanInterestAccruals.loanId, stored!.id))).toEqual(before.accruals);
        expect(await db.select().from(transactions).where(eq(transactions.loanId, stored!.id))).toEqual(before.transactions);
    });

    // Break caught: the legacy close endpoint overwrites the immutable lineage marker on an
    // already replaced loan, leaving an executed replacement whose old loan is no longer replaced.
    integrationTest("rejects legacy close after a loan has been replaced", async () => {
        const fixture = await seedReplacementFixture({ tenantId: "tenant-a" });
        const preview = await fixture.preview();
        await fixture.execute(preview, "legacy-close-lineage-execution");
        const app = new Elysia().use(loansRoute);
        const headers = {
            authorization: `Bearer ${await authToken(fixture.actor)}`,
            "content-type": "application/json",
        };

        const close = await jsonRequest(app, `/loans/${fixture.oldLoan.publicId}/close`, {
            method: "POST",
            headers,
            body: JSON.stringify({ note: "Must not erase replacement lineage" }),
        });

        expect(close.response.status, close.text).toBe(409);
        expect(close.body).toEqual({
            code: "LOAN_REPLACED",
            error: "Replaced loans cannot be closed directly",
        });
        expect(await db.query.loans.findFirst({ where: eq(loans.id, fixture.oldLoan.id) }))
            .toMatchObject({ status: "replaced" });
    });

    // Break caught: close reads `active` without a row lock, replacement commits `replaced`, and
    // the queued unconditional close update then commits `closed` over the replacement marker.
    integrationTest("serializes concurrent legacy close and replacement without overwriting terminal state", async () => {
        const fixture = await seedReplacementFixture({ tenantId: "tenant-a" });
        const preview = await fixture.preview();
        const app = new Elysia().use(loansRoute);
        const headers = {
            authorization: `Bearer ${await authToken(fixture.actor)}`,
            "content-type": "application/json",
        };

        let release!: () => void;
        const held = new Promise<void>((resolve) => { release = resolve; });
        let markLocked!: () => void;
        const locked = new Promise<void>((resolve) => { markLocked = resolve; });
        const blocker = db.transaction(async (tx) => {
            await tx.execute(sql`SELECT id FROM loans WHERE id = ${fixture.oldLoan.id} FOR UPDATE`);
            markLocked();
            await held;
        });
        await locked;

        const executionPromise = fixture.execute(preview, "legacy-close-race-execution");
        await Bun.sleep(20);
        const closePromise = jsonRequest(app, `/loans/${fixture.oldLoan.publicId}/close`, {
            method: "POST",
            headers,
            body: JSON.stringify({ note: "Concurrent legacy close" }),
        });
        await Bun.sleep(20);
        release();
        await blocker;

        const [execution, close] = await Promise.allSettled([executionPromise, closePromise]);
        const storedLoan = await db.query.loans.findFirst({ where: eq(loans.id, fixture.oldLoan.id) });
        const storedReplacement = await db.query.loanReplacements.findFirst({
            where: eq(loanReplacements.publicId, preview.publicId),
        });

        if (execution.status === "fulfilled") {
            expect(execution.value).toMatchObject({ status: "executed" });
            expect(close.status).toBe("fulfilled");
            if (close.status === "fulfilled") {
                expect(close.value.response.status, close.value.text).toBe(409);
                expect(close.value.body).toMatchObject({ code: "LOAN_REPLACED" });
            }
            expect(storedLoan).toMatchObject({ status: "replaced" });
            expect(storedReplacement).toMatchObject({ status: "executed" });
        } else {
            expect(execution.reason).toMatchObject({ code: "OLD_LOAN_NOT_REPLACEABLE", status: 409 });
            expect(close.status).toBe("fulfilled");
            if (close.status === "fulfilled") {
                expect(close.value.response.status, close.value.text).toBe(200);
                expect(close.value.body).toMatchObject({ status: "closed" });
            }
            expect(storedLoan).toMatchObject({ status: "closed" });
            expect(storedReplacement).toMatchObject({ status: "preview" });
        }
    });

    // Break caught: closing the active replacement child mutates its lifecycle, but reversal
    // still cancels that child and restores the old loan as though no downstream transition occurred.
    integrationTest("blocks replacement reversal after the replacement child is closed", async () => {
        const fixture = await seedReplacementFixture({ tenantId: "tenant-a" });
        const preview = await fixture.preview();
        await fixture.execute(preview, "replacement-child-close-execution");
        const app = new Elysia().use(loansRoute);
        const headers = {
            authorization: `Bearer ${await authToken(fixture.actor)}`,
            "content-type": "application/json",
        };

        const close = await jsonRequest(app, `/loans/${fixture.replacementDraft.publicId}/close`, {
            method: "POST",
            headers,
            body: JSON.stringify({ note: "Downstream terminal transition" }),
        });
        expect(close.response.status, close.text).toBe(200);
        expect(close.body).toMatchObject({ status: "closed" });

        await expect(fixture.reverse(preview.publicId, "replacement-child-close-reversal"))
            .rejects.toMatchObject({
                code: "REPLACEMENT_REVERSAL_LIFECYCLE_CHANGED",
                status: 409,
                details: {
                    reviewRequired: true,
                    blockerPublicIds: [fixture.replacementDraft.publicId],
                },
            });
        expect(await db.query.loans.findFirst({ where: eq(loans.id, fixture.oldLoan.id) }))
            .toMatchObject({ status: "replaced" });
        expect(await db.query.loans.findFirst({ where: eq(loans.id, fixture.replacementDraft.id) }))
            .toMatchObject({ status: "closed" });
    });

    // Break caught: after a safe reversal marks the replacement child `cancelled`, legacy close
    // overwrites that required cancellation marker with `closed`.
    integrationTest("rejects legacy close for a cancelled replacement child", async () => {
        const fixture = await seedReplacementFixture({ tenantId: "tenant-a" });
        const preview = await fixture.preview();
        await fixture.execute(preview, "cancelled-child-close-execution");
        await fixture.reverse(preview.publicId, "cancelled-child-close-reversal");
        const app = new Elysia().use(loansRoute);
        const headers = {
            authorization: `Bearer ${await authToken(fixture.actor)}`,
            "content-type": "application/json",
        };

        const close = await jsonRequest(app, `/loans/${fixture.replacementDraft.publicId}/close`, {
            method: "POST",
            headers,
            body: JSON.stringify({ note: "Must preserve cancellation lineage" }),
        });

        expect(close.response.status, close.text).toBe(409);
        expect(close.body).toEqual({
            code: "LOAN_NOT_CLOSEABLE",
            error: "Cancelled or reversed loans cannot be closed",
        });
        expect(await db.query.loans.findFirst({ where: eq(loans.id, fixture.replacementDraft.id) }))
            .toMatchObject({ status: "cancelled" });
    });

    // Break caught: a first-day paid accrual cannot prove which effective-dated rate produced it.
    integrationTest("links a weekly deducted first-period accrual to the initial rate period", async () => {
        const actor = await seedUser("tenant-a", "floating-first-day@example.test", "collector");
        const ctx = context("tenant-a", actor.id);
        const borrower = await createBorrower(ctx, { name: "Floating First Day Borrower" });
        const draft = await createLoanDraft(ctx, {
            borrowerPublicId: borrower.publicId,
            principal: "1000.00", interestRate: "0.00", repaymentType: "floating", termMonths: 1,
            startDate: "2026-08-10",
            floatingDailyInterest: {
                mode: "per_thousand", rate: "15", firstDayTreatment: "deduct", accrualCycle: "weekly",
            },
        });
        const stored = await db.query.loans.findFirst({ where: eq(loans.publicId, draft.publicId) });

        await activateLoan(ctx, draft.publicId);

        const [period] = await db.select().from(loanInterestRatePeriods).where(eq(loanInterestRatePeriods.loanId, stored!.id));
        const accruals = await db.select().from(loanInterestAccruals).where(eq(loanInterestAccruals.loanId, stored!.id))
            .orderBy(loanInterestAccruals.accrualDate);
        expect(await db.query.loans.findFirst({ where: eq(loans.id, stored!.id) })).toMatchObject({ floatingAccrualCycle: "weekly" });
        expect(accruals).toHaveLength(7);
        expect(accruals.reduce((sum, row) => sum.plus(row.interestAmount), new Decimal(0)).toFixed(2)).toBe("15.00");
        expect(accruals.every((row) => row.interestRatePeriodId === period!.id && row.status === "paid"
            && row.interestAmount === row.paidAmount)).toBe(true);
        expect(accruals[0]).toMatchObject({
            accrualDate: "2026-08-10", periodStartDate: "2026-08-10", periodEndDate: "2026-08-17",
            periodDayIndex: 1, periodDays: 7, openingPrincipal: "1000.00",
        });
        expect(accruals[6]).toMatchObject({
            accrualDate: "2026-08-16", periodDayIndex: 7, cumulativeInterestAmount: "15.00",
        });
    });

    // Break caught: correcting a future snapshot in an advance-paid period
    // reprices the non-refundable charge from a later principal payment.
    integrationTest("keeps the activation basis immutable when correcting a weekly advance period", async () => {
        const actor = await seedUser("tenant-advance-correction", "advance-correction@example.test", "owner");
        const createContext = context(actor.tenantId, actor.id, "advance-create");
        const borrower = await createBorrower(createContext, { name: "Advance Correction Borrower" });
        const draft = await createLoanDraft(createContext, {
            borrowerPublicId: borrower.publicId,
            principal: "5000.00", interestRate: "0.00", repaymentType: "floating", termMonths: 1,
            startDate: "2026-08-10",
            floatingDailyInterest: {
                mode: "percent", rate: "12.0000", firstDayTreatment: "deduct", accrualCycle: "weekly",
            },
        });
        await activateLoan(createContext, draft.publicId);
        const stored = (await db.query.loans.findFirst({ where: eq(loans.publicId, draft.publicId) }))!;
        await db.insert(transactions).values({
            tenantId: actor.tenantId, ownerUserId: actor.id, loanId: stored.id,
            amount: "1000.00", principalComponent: "1000.00", interestComponent: "0.00",
            feeComponent: "0.00", penaltyComponent: "0.00", transactionDate: new Date("2026-08-12T05:00:00.000Z"),
            recordedByUserId: actor.id, entryType: "repayment", postedAt: new Date("2026-08-12T05:00:00.000Z"),
        });

        await correctFloatingInterestAccruals(
            context(actor.tenantId, actor.id, "advance-correction"),
            draft.publicId,
            ["2026-08-13"],
            "Repair paid advance snapshot",
        );

        const active = await db.select().from(loanInterestAccruals).where(and(
            eq(loanInterestAccruals.loanId, stored.id),
            sql`${loanInterestAccruals.status} <> 'reversed'`,
        )).orderBy(loanInterestAccruals.accrualDate);
        expect(active).toHaveLength(7);
        expect(active.every((row) => row.status === "paid" && row.interestAmount === row.paidAmount)).toBe(true);
        expect(active.reduce((sum, row) => sum.plus(row.interestAmount), new Decimal(0)).toFixed(2)).toBe("600.00");
        expect(active.reduce((sum, row) => sum.plus(row.paidAmount), new Decimal(0)).toFixed(2)).toBe("600.00");
        expect(active[3]).toMatchObject({
            accrualDate: "2026-08-13", openingPrincipal: "5000.00",
            interestAmount: "85.72", cumulativeInterestAmount: "342.86", status: "paid",
        });
    });

    // Break caught: scheduled activation loses huge Decimal principal/interest before persisting rows and rollups.
    integrationTest("keeps scheduled-loan activation exact beyond Number safe integers", async () => {
        const actor = await seedUser("tenant-a", "scheduled-exact@example.test", "collector");
        const ctx = context("tenant-a", actor.id);
        const borrower = await createBorrower(ctx, { name: "Scheduled Exact Borrower" });
        const draft = await createLoanDraft(ctx, {
            borrowerPublicId: borrower.publicId,
            principal: "9007199254740993.00",
            interestRate: "12.00",
            repaymentType: "monthly",
            termMonths: 1,
            startDate: "2026-08-10",
        });

        const activated = await activateLoan(ctx, draft.publicId);
        const storedLoan = await db.query.loans.findFirst({ where: eq(loans.publicId, draft.publicId) });
        const [schedule] = await db.select().from(loanSchedules).where(eq(loanSchedules.loanId, storedLoan!.id));

        expect(schedule).toMatchObject({
            scheduledPrincipal: "9007199254740993.00",
            scheduledInterest: "90071992547409.93",
            scheduledTotal: "9097271247288402.93",
            remainingDue: "9097271247288402.93",
        });
        expect(activated).toMatchObject({
            outstandingPrincipal: "9007199254740993.00",
            outstandingInterest: "90071992547409.93",
        });
    });

    // Break caught: two callers that reach activation together create duplicate schedule/allocation/audit sets.
    integrationTest("serializes simultaneous activation into one schedule and one initial allocation", async () => {
        const actor = await seedUser("tenant-a", "double-activation@example.test", "owner");
        const ctx = context("tenant-a", actor.id);
        const borrower = await createBorrower(ctx, { name: "Concurrent Activation Borrower" });
        const profile = await db.insert(bankProfiles).values({
            tenantId: "tenant-a", name: "Concurrent Funding", type: "bank",
        }).returning().then((rows) => rows[0]!);
        const drawdown = await db.insert(bankLoans).values({
            tenantId: "tenant-a", bankProfileId: profile.id, amount: "10000.00",
        }).returning().then((rows) => rows[0]!);
        const draft = await createLoanDraft(ctx, {
            borrowerPublicId: borrower.publicId,
            bankLoanPublicId: drawdown.publicId,
            ...terms,
        });
        const stored = await db.query.loans.findFirst({ where: eq(loans.publicId, draft.publicId) });

        let release!: () => void;
        const held = new Promise<void>((resolve) => { release = resolve; });
        let locked!: () => void;
        const barrier = new Promise<void>((resolve) => { locked = resolve; });
        const blocker = db.transaction(async (tx) => {
            await tx.execute(sql`SELECT id FROM loans WHERE id = ${stored!.id} FOR UPDATE`);
            locked();
            await held;
        });
        await barrier;
        const first = activateLoan(context("tenant-a", actor.id, "simultaneous"), draft.publicId);
        const second = activateLoan(context("tenant-a", actor.id, "simultaneous"), draft.publicId);
        await Bun.sleep(20);
        release();
        await blocker;
        const [firstResult, secondResult] = await Promise.all([first, second]);

        expect(firstResult).toEqual(secondResult);
        expect(await db.select().from(loanSchedules).where(eq(loanSchedules.loanId, stored!.id))).toHaveLength(3);
        expect(await db.select().from(loanFundingAllocations).where(eq(loanFundingAllocations.loanId, stored!.id))).toHaveLength(1);
        expect(await db.select().from(auditLogs).where(and(
            eq(auditLogs.entityId, draft.publicId),
            eq(auditLogs.action, "activated"),
        ))).toHaveLength(1);
    });

    // Break caught: the replacement-only funding-gap behavior leaks through the shared
    // activation primitive and silently changes standalone activation allocation history.
    integrationTest("preserves an existing partial allocation during standalone activation", async () => {
        const actor = await seedUser("tenant-a", "partial-standalone@example.test", "owner");
        const ctx = context("tenant-a", actor.id, "partial-standalone-activation");
        const borrower = await createBorrower(ctx, { name: "Partial Standalone Borrower" });
        const profile = await db.insert(bankProfiles).values({
            tenantId: "tenant-a",
            name: "Partial Standalone Funding",
            type: "bank",
        }).returning().then((rows) => rows[0]!);
        const drawdown = await db.insert(bankLoans).values({
            tenantId: "tenant-a",
            bankProfileId: profile.id,
            amount: "10000.00",
        }).returning().then((rows) => rows[0]!);
        const draft = await createLoanDraft(ctx, {
            borrowerPublicId: borrower.publicId,
            bankLoanPublicId: drawdown.publicId,
            ...terms,
        });
        const stored = await db.query.loans.findFirst({ where: eq(loans.publicId, draft.publicId) });
        await db.insert(loanFundingAllocations).values({
            tenantId: "tenant-a",
            bankProfileId: profile.id,
            bankLoanId: drawdown.id,
            loanId: stored!.id,
            allocatedAmount: "200.00",
            allocationDate: "2026-08-10",
            allocationType: "initial",
            createdByUserId: actor.id,
        });

        await activateLoan(ctx, draft.publicId);

        const allocations = await db.select().from(loanFundingAllocations).where(eq(
            loanFundingAllocations.loanId,
            stored!.id,
        ));
        expect(allocations.map((row) => row.allocatedAmount)).toEqual(["200.00"]);
    });

    // Break caught: a capital-pool profile is accepted as a draft source but is not
    // persisted, capacity-checked, or recorded as the loan's initial allocation.
    integrationTest("activates a draft directly from available own capital", async () => {
        const actor = await seedUser("tenant-a", "own-capital@example.test", "owner");
        const ctx = context("tenant-a", actor.id);
        const borrower = await createBorrower(ctx, { name: "Own Capital Borrower" });
        const profile = await db.insert(bankProfiles).values({
            tenantId: "tenant-a", name: "Owner Capital", type: "personal_savings",
            accountingMode: "capital_pool", creditLimit: "1500.00",
        }).returning().then((rows) => rows[0]!);

        const draft = await createLoanDraft(ctx, {
            borrowerPublicId: borrower.publicId,
            bankProfilePublicId: profile.publicId,
            ...terms,
            principal: "1200.00",
        });
        expect(draft).toMatchObject({ bankProfilePublicId: profile.publicId, status: "draft" });

        const activated = await activateLoan(ctx, draft.publicId);
        expect(activated).toMatchObject({ bankProfilePublicId: profile.publicId, status: "active" });
        const allocation = await db.query.loanFundingAllocations.findFirst({
            where: and(eq(loanFundingAllocations.tenantId, "tenant-a"), eq(loanFundingAllocations.loanId,
                (await db.query.loans.findFirst({ where: eq(loans.publicId, draft.publicId) }))!.id)),
        });
        expect(allocation).toMatchObject({ bankProfileId: profile.id, bankLoanId: null, allocatedAmount: "1200.00" });
    });

    // Break caught: activating another draft ignores signed source allocations and overdraws one bank drawdown.
    integrationTest("rejects serial activation beyond net drawdown capacity and rolls back every activation effect", async () => {
        const actor = await seedUser("tenant-a", "serial-capacity@example.test", "owner");
        const ctx = context("tenant-a", actor.id);
        const borrower = await createBorrower(ctx, { name: "Serial Capacity Borrower" });
        const [sourceProfile, targetProfile] = await db.insert(bankProfiles).values([
            { tenantId: "tenant-a", name: "Serial Source", type: "bank" },
            { tenantId: "tenant-a", name: "Serial Target", type: "bank" },
        ]).returning();
        const [source, target] = await db.insert(bankLoans).values([
            { tenantId: "tenant-a", bankProfileId: sourceProfile!.id, amount: "100.00" },
            { tenantId: "tenant-a", bankProfileId: targetProfile!.id, amount: "100.00" },
        ]).returning();
        const firstDraft = await createLoanDraft(ctx, {
            borrowerPublicId: borrower.publicId,
            bankLoanPublicId: source!.publicId,
            ...terms,
            principal: "80.00",
        });
        const secondDraft = await createLoanDraft(context("tenant-a", actor.id, "serial-second-draft"), {
            borrowerPublicId: borrower.publicId,
            bankLoanPublicId: source!.publicId,
            ...terms,
            principal: "50.00",
        });
        await activateLoan(ctx, firstDraft.publicId);
        const firstLoan = await db.query.loans.findFirst({ where: eq(loans.publicId, firstDraft.publicId) });
        const secondLoan = await db.query.loans.findFirst({ where: eq(loans.publicId, secondDraft.publicId) });
        const allocationGroupId = crypto.randomUUID();
        await db.insert(loanFundingAllocations).values([
            {
                tenantId: "tenant-a", bankProfileId: sourceProfile!.id, bankLoanId: source!.id,
                loanId: firstLoan!.id, allocatedAmount: "-20.00", allocationDate: terms.startDate,
                allocationType: "reallocation_out", allocationGroupId, createdByUserId: actor.id,
            },
            {
                tenantId: "tenant-a", bankProfileId: targetProfile!.id, bankLoanId: target!.id,
                loanId: firstLoan!.id, allocatedAmount: "20.00", allocationDate: terms.startDate,
                allocationType: "reallocation_in", allocationGroupId, createdByUserId: actor.id,
            },
        ]);

        await expect(activateLoan(context("tenant-a", actor.id, "serial-capacity-reject"), secondDraft.publicId))
            .rejects.toMatchObject({
                code: "ALLOCATION_EXCEEDS_DRAWDOWN",
                status: 400,
                details: { sourceRemaining: "40.00" },
            });

        expect(await db.query.loans.findFirst({ where: eq(loans.id, secondLoan!.id) }))
            .toMatchObject({ status: "draft", outstandingPrincipal: "0.00" });
        expect(await db.select().from(loanSchedules).where(eq(loanSchedules.loanId, secondLoan!.id))).toHaveLength(0);
        expect(await db.select().from(loanFundingAllocations).where(eq(loanFundingAllocations.loanId, secondLoan!.id))).toHaveLength(0);
        expect(await db.select().from(auditLogs).where(and(
            eq(auditLogs.entityId, secondDraft.publicId),
            eq(auditLogs.action, "activated"),
        ))).toHaveLength(0);
        const sourceNet = await db.select({
            total: sql<string>`coalesce(sum(${loanFundingAllocations.allocatedAmount}), 0)`,
        }).from(loanFundingAllocations).where(and(
            eq(loanFundingAllocations.tenantId, "tenant-a"),
            eq(loanFundingAllocations.bankLoanId, source!.id),
        )).then((rows) => new Decimal(rows[0]?.total ?? 0).toFixed(2));
        expect(sourceNet).toBe("60.00");
    });

    // Break caught: two different draft rows bypass one another's locks and both consume the same insufficient drawdown.
    integrationTest("serializes concurrent activation of distinct drafts against one drawdown capacity", async () => {
        const actor = await seedUser("tenant-a", "concurrent-capacity@example.test", "owner");
        const borrower = await createBorrower(context("tenant-a", actor.id), { name: "Concurrent Capacity Borrower" });
        const profile = await db.insert(bankProfiles).values({
            tenantId: "tenant-a", name: "Concurrent Capacity Source", type: "bank",
        }).returning().then((rows) => rows[0]!);
        const drawdown = await db.insert(bankLoans).values({
            tenantId: "tenant-a", bankProfileId: profile.id, amount: "100.00", status: "active",
        }).returning().then((rows) => rows[0]!);
        const draftA = await createLoanDraft(context("tenant-a", actor.id, "concurrent-draft-a"), {
            borrowerPublicId: borrower.publicId, bankLoanPublicId: drawdown.publicId,
            ...terms, principal: "60.00",
        });
        const draftB = await createLoanDraft(context("tenant-a", actor.id, "concurrent-draft-b"), {
            borrowerPublicId: borrower.publicId, bankLoanPublicId: drawdown.publicId,
            ...terms, principal: "60.00",
        });
        const storedA = await db.query.loans.findFirst({ where: eq(loans.publicId, draftA.publicId) });
        const storedB = await db.query.loans.findFirst({ where: eq(loans.publicId, draftB.publicId) });

        let release!: () => void;
        const held = new Promise<void>((resolve) => { release = resolve; });
        let markLocked!: () => void;
        const locked = new Promise<void>((resolve) => { markLocked = resolve; });
        const blocker = db.transaction(async (tx) => {
            await tx.execute(sql`SELECT id FROM bank_loans WHERE id = ${drawdown.id} AND tenant_id = 'tenant-a' FOR UPDATE`);
            markLocked();
            await held;
        });
        await locked;
        const activationA = activateLoan(context("tenant-a", actor.id, "concurrent-activate-a"), draftA.publicId);
        const activationB = activateLoan(context("tenant-a", actor.id, "concurrent-activate-b"), draftB.publicId);
        await Bun.sleep(20);
        release();
        await blocker;
        const outcomes = await Promise.allSettled([activationA, activationB]);

        expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
        const rejected = outcomes.find((outcome) => outcome.status === "rejected") as PromiseRejectedResult | undefined;
        expect(rejected?.reason).toMatchObject({
            code: "ALLOCATION_EXCEEDS_DRAWDOWN",
            status: 400,
            details: { sourceRemaining: "40.00" },
        });
        const rows = await db.select().from(loans).where(sql`${loans.id} IN (${storedA!.id}, ${storedB!.id})`);
        expect(rows.map((row) => row.status).sort()).toEqual(["active", "draft"]);
        const winner = rows.find((row) => row.status === "active")!;
        const loser = rows.find((row) => row.status === "draft")!;
        expect(await db.select().from(loanSchedules).where(eq(loanSchedules.loanId, winner.id))).toHaveLength(3);
        expect(await db.select().from(loanSchedules).where(eq(loanSchedules.loanId, loser.id))).toHaveLength(0);
        expect(await db.select().from(loanFundingAllocations).where(eq(loanFundingAllocations.loanId, loser.id))).toHaveLength(0);
        expect(await db.select().from(auditLogs).where(and(
            eq(auditLogs.entityId, loser.publicId),
            eq(auditLogs.action, "activated"),
        ))).toHaveLength(0);
        const drawdownNet = await db.select({
            total: sql<string>`coalesce(sum(${loanFundingAllocations.allocatedAmount}), 0)`,
        }).from(loanFundingAllocations).where(and(
            eq(loanFundingAllocations.tenantId, "tenant-a"),
            eq(loanFundingAllocations.bankLoanId, drawdown.id),
        )).then((result) => new Decimal(result[0]?.total ?? 0));
        expect(drawdownNet.toFixed(2)).toBe("60.00");
        expect(drawdownNet.lte(drawdown.amount)).toBe(true);
    });

    // Break caught: an active loan's financial terms can be edited through the draft command.
    integrationTest("rejects term edits after activation", async () => {
        const actor = await seedUser("tenant-a", "immutable@example.test", "collector");
        const ctx = context("tenant-a", actor.id);
        const borrower = await createBorrower(ctx, { name: "Immutable Borrower" });
        const draft = await createLoanDraft(ctx, { borrowerPublicId: borrower.publicId, ...terms });
        await activateLoan(ctx, draft.publicId);

        await expect(updateLoanDraft(ctx, draft.publicId, { principal: "999.00" }))
            .rejects.toMatchObject({ code: "LOAN_TERMS_LOCKED", status: 409 });
        const stored = await db.query.loans.findFirst({ where: eq(loans.publicId, draft.publicId) });
        expect(stored?.principalAmount).toBe("1200.00");
    });

    // Break caught: an update that read a draft before activation overwrites terms after activation commits.
    integrationTest("rejects an in-flight draft update when activation wins the row lock", async () => {
        const actor = await seedUser("tenant-a", "concurrent@example.test", "collector");
        const ctx = context("tenant-a", actor.id);
        const borrower = await createBorrower(ctx, { name: "Concurrent Borrower" });
        const draft = await createLoanDraft(ctx, { borrowerPublicId: borrower.publicId, ...terms });
        const storedDraft = await db.query.loans.findFirst({ where: eq(loans.publicId, draft.publicId) });

        let markLocked!: () => void;
        const locked = new Promise<void>((resolve) => { markLocked = resolve; });
        let releaseLock!: () => void;
        const release = new Promise<void>((resolve) => { releaseLock = resolve; });
        const activationWinner = db.transaction(async (tx) => {
            await tx.execute(sql`SELECT id FROM loans WHERE id = ${storedDraft!.id} FOR UPDATE`);
            markLocked();
            await release;
            await tx.update(loans).set({ status: "active" }).where(eq(loans.id, storedDraft!.id));
        });

        await locked;
        const staleUpdate = updateLoanDraft(ctx, draft.publicId, { principal: "999.00" });
        const outcome = staleUpdate.then(
            (value) => ({ value, error: null }),
            (error: unknown) => ({ value: null, error }),
        );
        await Bun.sleep(20);
        releaseLock();
        await activationWinner;
        expect((await outcome).error).toMatchObject({ code: "LOAN_TERMS_LOCKED", status: 409 });

        const finalLoan = await db.query.loans.findFirst({ where: eq(loans.id, storedDraft!.id) });
        expect(finalLoan).toMatchObject({ status: "active", principalAmount: "1200.00" });
    });

    // Break caught: owner scoping is lost or legacy active rows require draft-only fields.
    integrationTest("preserves owner visibility and treats existing active loans as compatible", async () => {
        const first = await seedUser("tenant-a", "first-loan@example.test", "collector");
        const second = await seedUser("tenant-a", "second-loan@example.test", "collector");
        const firstCtx = context("tenant-a", first.id);
        const borrower = await createBorrower(firstCtx, { name: "Private Borrower" });

        await expect(createLoanDraft(context("tenant-a", second.id), { borrowerPublicId: borrower.publicId, ...terms }))
            .rejects.toMatchObject({ code: "BORROWER_NOT_FOUND", status: 404 });

        const borrowerRow = await db.query.borrowers.findFirst({ where: eq(borrowers.publicId, borrower.publicId) });
        const legacy = await db.insert(loans).values({
            tenantId: "tenant-a",
            ownerUserId: first.id,
            borrowerId: borrowerRow!.id,
            principalAmount: "500.00",
            interestRate: "5.00",
            repaymentType: "floating",
            status: "active",
        }).returning().then((rows) => rows[0]!);

        const compatible = await getLoanApplication(firstCtx, legacy.publicId);
        expect(compatible).toMatchObject({ publicId: legacy.publicId, status: "active", termMonths: null });
        expect(await db.select().from(loanSchedules).where(eq(loanSchedules.loanId, legacy.id))).toHaveLength(0);
    });

    // Break caught: create/update route variants leak raw floating normalization
    // exceptions or silently accept incompatible financial term objects.
    integrationTest("returns stable REST errors for invalid floating create/update and closed updates", async () => {
        const owner = await seedUser("tenant-a", "rest-invalid-terms@example.test", "owner");
        const ctx = context("tenant-a", owner.id);
        const borrower = await createBorrower(ctx, { name: "Invalid Terms Borrower" });
        const draft = await createLoanDraft(ctx, { borrowerPublicId: borrower.publicId, ...terms });
        const token = await authToken(owner);
        const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
        const app = new Elysia().use(loansRoute);
        const floatingBase = {
            principal: "5000.00", interestRate: "0.00", repaymentType: "floating", termMonths: 1,
            startDate: "2026-08-10", borrowerPublicId: borrower.publicId,
        };
        const policies = [
            { mode: "percent", rate: "0", firstDayTreatment: "start_next_day", accrualCycle: "daily" },
            { mode: "percent", rate: "not-a-rate", firstDayTreatment: "start_next_day", accrualCycle: "daily" },
            { mode: "percent", rate: "1.00000", firstDayTreatment: "start_next_day", accrualCycle: "daily" },
            { mode: "percent", rate: "1.0000", firstDayTreatment: "start_next_day", accrualCycle: "monthly" },
        ];
        for (const [index, floatingDailyInterest] of policies.entries()) {
            const created = await jsonRequest(app, "/loans", {
                method: "POST", headers, body: JSON.stringify({ ...floatingBase, floatingDailyInterest }),
            });
            expect(created.response.status, created.text).toBe(400);
            expect(created.body).toEqual({ error: "Floating interest policy is invalid", code: "INVALID_LOAN_TERMS" });
            expect(created.text).not.toContain("DecimalError");

            const updated = await jsonRequest(app, `/loans/${draft.publicId}`, {
                method: "PUT",
                headers: { ...headers, "x-request-id": `invalid-floating-update-${index}` },
                body: JSON.stringify({ repaymentType: "floating", floatingDailyInterest }),
            });
            expect(updated.response.status, updated.text).toBe(400);
            expect(updated.body).toEqual({ error: "Floating interest policy is invalid", code: "INVALID_LOAN_TERMS" });
            expect(updated.text).not.toContain("DecimalError");
        }
        expect(await db.select().from(loans)).toHaveLength(1);

        const singlePayment = {
            dueDate: "2026-08-19", fixedAgreedInterest: "500.00", interestPolicy: "fixed_only",
            latePenalty: { mode: "none" },
        };
        const incompatible = await jsonRequest(app, `/loans/${draft.publicId}`, {
            method: "PUT", headers, body: JSON.stringify({ singlePayment }),
        });
        expect(incompatible.response.status, incompatible.text).toBe(400);
        expect(incompatible.body).toMatchObject({ code: "INVALID_LOAN_TERMS" });

        const transitioned = await jsonRequest(app, `/loans/${draft.publicId}`, {
            method: "PUT", headers,
            body: JSON.stringify({ repaymentType: "single_payment", termMonths: 1, singlePayment }),
        });
        expect(transitioned.response.status, transitioned.text).toBe(200);
        expect(transitioned.body).toMatchObject({
            repaymentType: "single_payment", totalInstallments: null, installmentAmount: null,
        });
    });

    // Break caught: the legacy closing-summary route bypasses the reviewed
    // floating settlement workflow for an interim weekly period.
    integrationTest("rejects an interim weekly legacy closing summary", async () => {
        setSystemTime(new Date("2026-08-13T12:00:00+07:00"));
        try {
            const actor = await seedUser("tenant-weekly-closing", "weekly-closing@example.test", "owner");
            const ctx = context(actor.tenantId, actor.id, "weekly-closing-create");
            const borrower = await createBorrower(ctx, { name: "Weekly Closing Borrower" });
            const draft = await createLoanDraft(ctx, {
                borrowerPublicId: borrower.publicId,
                principal: "5000.00", interestRate: "0.00", repaymentType: "floating", termMonths: 1,
                startDate: "2026-08-10",
                floatingDailyInterest: {
                    mode: "percent", rate: "12.0000", firstDayTreatment: "start_next_day", accrualCycle: "weekly",
                },
            });
            await activateLoan(ctx, draft.publicId);
            const token = await authToken(actor);
            const app = new Elysia().use(loansRoute);
            const closing = await jsonRequest(app, `/loans/${draft.publicId}/closing-summary`, {
                headers: { authorization: `Bearer ${token}` },
            });

            expect(closing.response.status, closing.text).toBe(409);
            expect(closing.body).toEqual({
                code: "FLOATING_SETTLEMENT_REQUIRED",
                error: "Floating loans require the preview-and-execute settlement workflow",
            });
        } finally {
            setSystemTime();
        }
    });

    // Break caught: core loan REST adapters expose numeric database keys or accept numeric public money/source identifiers.
    integrationTest("runs the draft lifecycle through REST with UUID IDs, money strings, and stable errors", async () => {
        const owner = await seedUser("tenant-a", "rest-lifecycle@example.test", "owner");
        const borrower = await createBorrower(context("tenant-a", owner.id), { name: "REST Borrower" });
        const token = await authToken(owner);
        const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
        const app = new Elysia().use(loansRoute);

        const unauthorized = await jsonRequest(app, "/loans", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ borrowerPublicId: borrower.publicId, ...terms }),
        });
        expect(unauthorized.response.status).toBe(401);
        expect(unauthorized.body).toMatchObject({ code: "UNAUTHORIZED" });

        const created = await jsonRequest(app, "/loans", {
            method: "POST", headers, body: JSON.stringify({ borrowerPublicId: borrower.publicId, ...terms }),
        });
        expect(created.response.status, created.text).toBe(200);
        expect(created.body).toMatchObject({ id: created.body.publicId, status: "draft", principal: "1200.00" });
        expect(created.body).not.toHaveProperty("borrowerId");

        const list = await jsonRequest(app, "/loans", { headers });
        expect(list.response.status, list.text).toBe(200);
        expect(list.body[0]).toMatchObject({
            publicId: created.body.publicId,
            principal: "1200.00",
            outstandingPrincipal: "0.00",
            startDate: "2026-08-10",
        });

        const updated = await jsonRequest(app, `/loans/${created.body.publicId}`, {
            method: "PUT", headers, body: JSON.stringify({
                principal: "100.00", interestRate: "0.00", termMonths: 12,
                totalInstallments: 12, installmentAmount: "8.34",
            }),
        });
        expect(updated.response.status, updated.text).toBe(200);
        expect(updated.body).toMatchObject({ status: "draft", principal: "100.00" });

        const activated = await jsonRequest(app, `/loans/${created.body.publicId}/activate`, {
            method: "POST", headers: { ...headers, "idempotency-key": "rest-loan-activation" },
        });
        expect(activated.response.status, activated.text).toBe(200);
        expect(activated.body).toMatchObject({ status: "active", outstandingPrincipal: "100.00" });
        const activeList = await jsonRequest(app, "/loans", { headers });
        expect(activeList.body[0]).toMatchObject({
            principal: "100.00",
            outstandingPrincipal: "100.00",
        });
        const retried = await jsonRequest(app, `/loans/${created.body.publicId}/activate`, {
            method: "POST", headers: { ...headers, "idempotency-key": "rest-loan-activation" },
        });
        expect(retried.body).toEqual(activated.body);

        const locked = await jsonRequest(app, `/loans/${created.body.publicId}`, {
            method: "PUT", headers, body: JSON.stringify({ principal: "99.00" }),
        });
        expect(locked.response.status).toBe(409);
        expect(locked.body).toMatchObject({ code: "LOAN_TERMS_LOCKED" });
        const missing = await jsonRequest(app, "/loans/00000000-0000-0000-0000-000000000000", { headers });
        expect(missing.response.status).toBe(404);
        expect(missing.body).toMatchObject({ code: "LOAN_NOT_FOUND" });

        const schedule = await jsonRequest(app, `/loans/${created.body.publicId}/schedule`, { headers });
        expect(schedule.response.status, schedule.text).toBe(200);
        expect(schedule.body).toHaveLength(12);
        expect(schedule.body[0]).toMatchObject({
            id: schedule.body[0].publicId,
            loanPublicId: created.body.publicId,
            scheduledPrincipal: "8.34",
            scheduledTotal: "8.34",
            remainingDue: "8.34",
            penaltyDue: "0.00",
            totalDueNow: "8.34",
        });
        expect(schedule.body[0]).not.toHaveProperty("loanId");

        const state = await jsonRequest(app, `/loans/${created.body.publicId}/allocation-state`, { headers });
        expect(state.body).toMatchObject({
            loanId: created.body.publicId,
            loanPublicId: created.body.publicId,
            principalAmount: "100.00",
            netAllocatedPrincipal: "0.00",
            remainingGap: "100.00",
            overfundedAmount: "0.00",
        });
        const closing = await jsonRequest(app, `/loans/${created.body.publicId}/closing-summary`, { headers });
        expect(closing.body).toMatchObject({ loanId: created.body.publicId, principal: "100.00", totalPaid: "0.00" });
        expect(typeof closing.body.balance).toBe("string");

        const closed = await jsonRequest(app, `/loans/${created.body.publicId}/close`, {
            method: "POST", headers, body: JSON.stringify({ note: "REST close" }),
        });
        expect(closed.response.status, closed.text).toBe(200);
        expect(closed.body).toMatchObject({ id: created.body.publicId, publicId: created.body.publicId, status: "closed" });
        expect(closed.body).not.toHaveProperty("borrowerId");
        const duplicateClose = await jsonRequest(app, `/loans/${created.body.publicId}/close`, {
            method: "POST", headers, body: JSON.stringify({}),
        });
        expect(duplicateClose.response.status).toBe(409);
        expect(duplicateClose.body).toMatchObject({ code: "LOAN_ALREADY_CLOSED" });
    });

    // Break caught: the ordinary funding writer serializes a negative remaining capacity and leaks a 500 response.
    integrationTest("returns stable zero remaining capacity from REST funding allocation on an overallocated drawdown", async () => {
        const owner = await seedUser("tenant-a", "overallocated-rest@example.test", "owner");
        const ctx = context("tenant-a", owner.id);
        const borrower = await createBorrower(ctx, { name: "Overallocated REST Borrower" });
        const draft = await createLoanDraft(ctx, { borrowerPublicId: borrower.publicId, ...terms });
        const storedLoan = await db.query.loans.findFirst({ where: eq(loans.publicId, draft.publicId) });
        const profile = await db.insert(bankProfiles).values({
            tenantId: "tenant-a", name: "Overallocated REST Source", type: "bank",
        }).returning().then((rows) => rows[0]!);
        const drawdown = await db.insert(bankLoans).values({
            tenantId: "tenant-a", bankProfileId: profile.id, amount: "100.00", status: "active",
        }).returning().then((rows) => rows[0]!);
        await db.insert(loanFundingAllocations).values({
            tenantId: "tenant-a", bankProfileId: profile.id, bankLoanId: drawdown.id,
            loanId: storedLoan!.id, allocatedAmount: "120.00", allocationDate: "2026-08-10",
            allocationType: "initial", createdByUserId: owner.id,
        });
        const auditCountBefore = await db.select().from(auditLogs).then((rows) => rows.length);
        const app = new Elysia().use(loansRoute);
        const response = await app.handle(new Request(`http://localhost/loans/${draft.publicId}/funding-allocations`, {
            method: "POST",
            headers: {
                authorization: `Bearer ${await authToken(owner)}`,
                "content-type": "application/json",
                "idempotency-key": "funding-overallocated-rest",
            },
            body: JSON.stringify({
                bankLoanPublicId: drawdown.publicId,
                allocatedAmount: "1.00",
                allocationDate: "2026-08-10",
            }),
        }));
        const responseText = await response.text();

        expect(response.status, responseText).toBe(400);
        expect(JSON.parse(responseText)).toEqual({
            error: "Allocation exceeds remaining drawdown balance",
            code: "ALLOCATION_EXCEEDS_DRAWDOWN",
            details: { sourceRemaining: "0.00" },
        });
        expect(await db.select().from(loanFundingAllocations).where(and(
            eq(loanFundingAllocations.tenantId, "tenant-a"),
            eq(loanFundingAllocations.bankLoanId, drawdown.id),
        ))).toHaveLength(1);
        expect(await db.select().from(auditLogs).then((rows) => rows.length)).toBe(auditCountBefore);
    });

    // Break caught: funding allocation/reallocation REST paths accept internal numeric source IDs and return raw rows.
    integrationTest("accepts and returns public funding UUIDs and two-decimal strings", async () => {
        const owner = await seedUser("tenant-a", "reallocation@example.test", "owner");
        const ctx = context("tenant-a", owner.id);
        const borrower = await createBorrower(ctx, { name: "Reallocation Borrower" });
        const loan = await createLoanDraft(ctx, { borrowerPublicId: borrower.publicId, ...terms });
        const storedLoan = await db.query.loans.findFirst({ where: eq(loans.publicId, loan.publicId) });
        const profile = await db.insert(bankProfiles).values({
            tenantId: "tenant-a", name: "Funding", type: "bank",
        }).returning().then((rows) => rows[0]!);
        const [source, target] = await db.insert(bankLoans).values([
            { tenantId: "tenant-a", bankProfileId: profile.id, amount: "2000.00", status: "active" },
            { tenantId: "tenant-a", bankProfileId: profile.id, amount: "2000.00", status: "active" },
        ]).returning();
        const app = new Elysia().use(loansRoute);
        const headers = {
            authorization: `Bearer ${await authToken(owner)}`,
            "content-type": "application/json",
            "idempotency-key": "funding-reallocation-rest",
        };
        const allocated = await jsonRequest(app, `/loans/${loan.publicId}/funding-allocations`, {
            method: "POST",
            headers,
            body: JSON.stringify({
                bankLoanPublicId: source!.publicId,
                allocatedAmount: "500.00",
                allocationDate: "2026-08-10",
            }),
        });
        expect(allocated.response.status, allocated.text).toBe(200);
        expect(allocated.body).toMatchObject({
            id: allocated.body.publicId,
            loanPublicId: loan.publicId,
            bankLoanPublicId: source!.publicId,
            bankProfilePublicId: profile.publicId,
            allocatedAmount: "500.00",
        });
        expect(allocated.body).not.toHaveProperty("bankLoanId");

        const profitability = await jsonRequest(app, `/loans/${loan.publicId}/profitability`, { headers });
        expect(profitability.response.status, profitability.text).toBe(200);
        expect(profitability.body).toMatchObject({
            loanId: loan.publicId,
            loanPublicId: loan.publicId,
            principalAmount: "1200.00",
            fundedPrincipal: "500.00",
            fundingComposition: [expect.objectContaining({
                bankLoanPublicId: source!.publicId,
                bankProfilePublicId: profile.publicId,
                netAllocatedPrincipal: "500.00",
            })],
        });
        expect(profitability.body.fundingComposition[0]).not.toHaveProperty("bankLoanId");
        expect(profitability.body.fundingComposition[0]).not.toHaveProperty("bankProfileId");

        const response = await app.handle(new Request(`http://localhost/loans/${loan.publicId}/funding-reallocations`, {
            method: "POST",
            headers,
            body: JSON.stringify({
                fromBankLoanPublicId: source!.publicId,
                toBankLoanPublicId: target!.publicId,
                amount: "100.00",
                allocationDate: "2026-08-11",
            }),
        }));

        const responseText = await response.text();
        expect(response.status, responseText).toBe(200);
        const result = JSON.parse(responseText) as Array<Record<string, unknown>>;
        expect(result).toHaveLength(2);
        expect(result.every((row) => typeof row.id === "string" && typeof row.allocatedAmount === "string")).toBe(true);
        expect(result[0]).not.toHaveProperty("bankLoanId");
        expect(String(result[0]?.note)).toContain(target!.publicId);
        expect(String(result[1]?.note)).toContain(source!.publicId);
    });
});
