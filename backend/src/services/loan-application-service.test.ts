import { beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import Decimal from "decimal.js";
import { and, eq, sql } from "drizzle-orm";
import { Elysia } from "elysia";
import { db } from "../db";
import { auditLogs, bankLoans, bankProfiles, borrowers, loanDisbursements, loanFundingAllocations, loanInterestAccruals, loanInterestRatePeriods, loanSchedules, loans, transactions, users } from "../db/schema";
import { loansRoute } from "../modules/loans";
import type { CommandContext } from "./command-context";
import { createBorrower } from "./borrower-service";
import {
    activateLoan,
    createLoanDraft,
    previewLoan,
    updateLoanDraft,
} from "./loan-application-service";
import { correctFloatingInterestAccruals } from "./floating-interest-service";

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
        expect(preview.terms).toMatchObject({ principal: "1200.00", interestRate: "12.00" });
        expect(preview.schedule[0]).toMatchObject({ amount: "412.00", principalComponent: "400.00" });
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

    // Break caught: single-payment preview recreates agreed fixed interest from the
    // compatibility interestRate field instead of the closed contract terms.
    test("previews one exact single-payment maturity obligation", () => {
        const preview = previewLoan({
            principal: "5000.00",
            interestRate: "99.00",
            repaymentType: "single_payment",
            termMonths: 1,
            startDate: "2026-08-10",
            singlePayment: {
                dueDate: "2026-08-19",
                fixedAgreedInterest: "500.00",
                interestPolicy: "fixed_only",
                latePenalty: { mode: "none" },
            },
        });

        expect(preview.terms).toMatchObject({
            principal: "5000.00",
            interestRate: "99.00",
            repaymentType: "single_payment",
            singlePayment: {
                dueDate: "2026-08-19",
                fixedAgreedInterest: "500.00",
                interestPolicy: "fixed_only",
                latePenalty: { mode: "none" },
            },
        });
        expect(preview.schedule).toEqual([{
            installmentNo: 1,
            dueDate: "2026-08-19",
            amount: "5500.00",
            principalComponent: "5000.00",
            interestComponent: "500.00",
            remainingPrincipal: "0.00",
        }]);
    });

    // Break caught: new floating contracts persist a null accrual cycle or force
    // all callers to opt into a field that legacy daily callers never sent.
    test("defaults legacy floating input to daily and preserves an explicit weekly accrual cycle", () => {
        const base = {
            principal: "5000.00",
            interestRate: "0.00",
            repaymentType: "floating" as const,
            termMonths: 1,
            startDate: "2026-08-10",
        };
        expect(previewLoan({
            ...base,
            floatingDailyInterest: { mode: "percent", rate: "1", firstDayTreatment: "start_next_day" },
        }).floatingDailyInterest).toEqual({
            mode: "percent", rate: "1.0000", firstDayTreatment: "start_next_day", accrualCycle: "daily",
        });
        const weekly = previewLoan({
            ...base,
            floatingDailyInterest: { mode: "percent", rate: "1", firstDayTreatment: "start_next_day", accrualCycle: "weekly" },
        });
        expect(weekly.floatingDailyInterest).toEqual({
            mode: "percent", rate: "1.0000", firstDayTreatment: "start_next_day", accrualCycle: "weekly",
        });
        expect(weekly).toMatchObject({
            fullPeriodInterest: "50.00",
            firstPeriodStartDate: "2026-08-10",
            coveredStartDate: null,
            coveredEndDate: null,
            firstPeriodDueDate: "2026-08-17",
            advanceInterestAmount: "0.00",
            netDisbursement: "5000.00",
            nextAccrualDate: "2026-08-17",
            periodDays: 7,
            advanceInterestRefundPolicy: "non_refundable",
        });
        expect(weekly).not.toHaveProperty("firstPeriodInterest");
        expect(weekly).not.toHaveProperty("advanceInterest");
        expect(weekly).not.toHaveProperty("netBorrowerPayout");
        expect(weekly).not.toHaveProperty("nextInterestDate");
        expect(weekly).not.toHaveProperty("nonRefundable");
        expect(weekly).not.toHaveProperty("dailyInterestAtCurrentPrincipal");
        const advance = previewLoan({
            ...base,
            floatingDailyInterest: { mode: "percent", rate: "12", firstDayTreatment: "deduct", accrualCycle: "weekly" },
        });
        expect(advance).toMatchObject({
            fullPeriodInterest: "600.00",
            firstPeriodStartDate: "2026-08-10",
            coveredStartDate: "2026-08-10",
            coveredEndDate: "2026-08-16",
            firstPeriodDueDate: "2026-08-17",
            advanceInterestAmount: "600.00",
            netDisbursement: "4400.00",
            nextAccrualDate: "2026-08-17",
            periodDays: 7,
            advanceInterestRefundPolicy: "non_refundable",
        });
        expect(advance).not.toHaveProperty("firstPeriodInterest");
        expect(advance).not.toHaveProperty("advanceInterest");
        expect(advance).not.toHaveProperty("netBorrowerPayout");
        expect(advance).not.toHaveProperty("nextInterestDate");
        expect(advance).not.toHaveProperty("nonRefundable");
        expect(advance).not.toHaveProperty("dailyInterestAtCurrentPrincipal");
    });

    if (integrationEnabled) beforeEach(resetApplicationTables);

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
            repaymentType: "monthly",
            startDate: "2026-08-11",
        });
        expect(edited).toMatchObject({ status: "draft", principal: "1500.00", startDate: "2026-08-11" });

        const activated = await activateLoan(ctx, draft.publicId);
        expect(activated).toMatchObject({ status: "active", principal: "1500.00" });
        const firstSchedules = await db.select().from(loanSchedules);
        expect(firstSchedules).toHaveLength(3);

        const retried = await activateLoan(context("tenant-a", actor.id, "activation-retry"), draft.publicId);
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
            floatingDailyInterest: {
                mode: "per_thousand",
                rate: "1.0000",
                firstDayTreatment: "start_next_day",
            },
        });

        const activated = await activateLoan(ctx, draft.publicId);
        expect(activated.outstandingPrincipal).toBe("9007199254740993.00");
        const stored = await db.query.loans.findFirst({ where: eq(loans.publicId, draft.publicId) });
        expect(await db.select().from(loanInterestRatePeriods).where(eq(loanInterestRatePeriods.loanId, stored!.id))).toMatchObject([{
            effectiveDate: "2026-08-10", expiryDate: null, rateType: "per_thousand", rate: "1.0000",
        }]);
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
            floatingDailyInterest: { mode: "per_thousand", rate: "15", firstDayTreatment: "deduct", accrualCycle: "weekly" },
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
            accrualDate: "2026-08-11", periodStartDate: "2026-08-10", periodEndDate: "2026-08-17",
            periodDayIndex: 1, periodDays: 7, openingPrincipal: "1000.00",
        });
        expect(accruals[6]).toMatchObject({
            accrualDate: "2026-08-17", periodDayIndex: 7, cumulativeInterestAmount: "15.00",
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
        expect(active[2]).toMatchObject({
            accrualDate: "2026-08-13", openingPrincipal: "5000.00",
            interestAmount: "85.71", cumulativeInterestAmount: "257.14", status: "paid",
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
        const first = activateLoan(context("tenant-a", actor.id, "simultaneous-a"), draft.publicId);
        const second = activateLoan(context("tenant-a", actor.id, "simultaneous-b"), draft.publicId);
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
            tenantId: "tenant-a", bankProfileId: profile.id, amount: "100.00",
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

        const compatible = await activateLoan(firstCtx, legacy.publicId);
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

    // Break caught: the legacy annual-rate closing calculator reports zero or
    // native-number drift instead of the current weekly period projection.
    integrationTest("includes exact interim weekly interest in the closing summary", async () => {
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

            expect(closing.response.status, closing.text).toBe(200);
            expect(closing.body).toMatchObject({
                principal: "5000.00", totalInterest: "257.14", totalDue: "5257.14", balance: "5257.14",
                accruingInterest: "257.14", dueInterest: "0.00", totalPaid: "0.00",
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
            method: "PUT", headers, body: JSON.stringify({ principal: "100.00", interestRate: "0.00", termMonths: 12 }),
        });
        expect(updated.response.status, updated.text).toBe(200);
        expect(updated.body).toMatchObject({ status: "draft", principal: "100.00" });

        const activated = await jsonRequest(app, `/loans/${created.body.publicId}/activate`, { method: "POST", headers });
        expect(activated.response.status, activated.text).toBe(200);
        expect(activated.body).toMatchObject({ status: "active", outstandingPrincipal: "100.00" });
        const activeList = await jsonRequest(app, "/loans", { headers });
        expect(activeList.body[0]).toMatchObject({
            principal: "100.00",
            outstandingPrincipal: "100.00",
        });
        const retried = await jsonRequest(app, `/loans/${created.body.publicId}/activate`, { method: "POST", headers });
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
            scheduledPrincipal: "8.33",
            scheduledTotal: "8.33",
            remainingDue: "8.33",
            penaltyDue: "0.00",
            totalDueNow: "8.33",
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
            tenantId: "tenant-a", bankProfileId: profile.id, amount: "100.00",
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
            { tenantId: "tenant-a", bankProfileId: profile.id, amount: "2000.00" },
            { tenantId: "tenant-a", bankProfileId: profile.id, amount: "2000.00" },
        ]).returning();
        const app = new Elysia().use(loansRoute);
        const headers = {
            authorization: `Bearer ${await authToken(owner)}`,
            "content-type": "application/json",
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
