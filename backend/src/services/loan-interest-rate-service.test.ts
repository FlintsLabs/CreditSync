import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { auditLogs, borrowers, loanInterestAccruals, loanInterestRatePeriods, loanInterestRatePreviews, loans, users } from "../db/schema";
import type { CommandContext } from "./command-context";
import { DomainError } from "./domain-error";
import { executeLoanInterestRateChange, listLoanInterestRates, previewLoanInterestRateChange } from "./loan-interest-rate-service";

const integrationEnabled = Boolean(process.env.TEST_DATABASE_URL);
const integrationTest = integrationEnabled ? test : test.skip;

async function resetTables() {
    await db.execute(sql`SET client_min_messages TO WARNING`);
    await db.execute(sql`TRUNCATE TABLE audit_logs, loan_interest_rate_previews, loan_interest_accruals, loan_interest_rate_periods, loans, borrowers, users RESTART IDENTITY CASCADE`);
}

function context(tenantId: string, actorUserId: number, idempotencyKey?: string): CommandContext {
    return { tenantId, actorUserId, actorSource: "web", requestId: `req-${tenantId}`, correlationId: `corr-${tenantId}`, idempotencyKey };
}

async function seedFloatingLoan(tenantId: string, suffix: string, principal = "1000.00", status = "active") {
    const actor = await db.insert(users).values({ tenantId, email: `${tenantId}-${suffix}@rate-service.test`, role: "owner" }).returning().then((rows) => rows[0]!);
    const borrower = await db.insert(borrowers).values({ tenantId, ownerUserId: actor.id, name: `${tenantId} Borrower` }).returning().then((rows) => rows[0]!);
    const loan = await db.insert(loans).values({
        tenantId, ownerUserId: actor.id, borrowerId: borrower.id,
        principalAmount: principal, interestRate: "0.00", repaymentType: "floating",
        firstDayTreatment: "start_next_day", interestStartDate: "2026-08-01",
        outstandingPrincipal: principal, status,
    }).returning().then((rows) => rows[0]!);
    const period = await db.insert(loanInterestRatePeriods).values({
        tenantId, loanId: loan.id, effectiveDate: "2026-08-01", expiryDate: null,
        rateType: "per_thousand", rate: "15.0000", createdByUserId: actor.id,
    }).returning().then((rows) => rows[0]!);
    return { actor, borrower, loan, period };
}

describe("loan interest rate service", () => {
    if (integrationEnabled) beforeEach(resetTables);
    afterEach(() => setSystemTime());

    integrationTest("lists only an accessible loan timeline with exact current daily interest", async () => {
        const first = await seedFloatingLoan("tenant-a", "first", "9007199254740993.00");
        await seedFloatingLoan("tenant-b", "second");

        const result = await listLoanInterestRates(context("tenant-a", first.actor.id), first.loan.publicId, new Date("2026-08-11T12:00:00+07:00"));

        expect(result).toMatchObject({
            loanPublicId: first.loan.publicId,
            dailyInterestAtCurrentPrincipal: "135107988821114.90",
            earliestEditableDate: "2026-08-02",
            currentPeriod: { publicId: first.period.publicId, rateType: "per_thousand", rate: "15.0000" },
            nextChange: null,
        });
        expect(result.timeline).toHaveLength(1);
        await expect(listLoanInterestRates(context("tenant-b", first.actor.id), first.loan.publicId)).rejects.toMatchObject({ code: "LOAN_NOT_FOUND" });
    });

    integrationTest("previews an automatic split without changing live periods", async () => {
        setSystemTime(new Date("2026-08-11T10:00:00+07:00"));
        const { actor, loan } = await seedFloatingLoan("tenant-a", "preview");

        const preview = await previewLoanInterestRateChange(context("tenant-a", actor.id), loan.publicId, {
            effectiveDate: "2026-09-01", expiryDate: "2026-09-30", rateType: "per_thousand", rate: "18",
        });

        expect(preview).toMatchObject({
            loanPublicId: loan.publicId,
            request: { effectiveDate: "2026-09-01", expiryDate: "2026-09-30", rateType: "per_thousand", rate: "18.0000" },
            expiresAt: "2026-08-11T03:15:00.000Z",
        });
        expect(preview.previewHash).toMatch(/^v1:[0-9a-f]{64}$/);
        expect(preview.afterTimeline.map(({ effectiveDate, expiryDate, rate }) => ({ effectiveDate, expiryDate, rate }))).toEqual([
            { effectiveDate: "2026-08-01", expiryDate: "2026-08-31", rate: "15.0000" },
            { effectiveDate: "2026-09-01", expiryDate: "2026-09-30", rate: "18.0000" },
            { effectiveDate: "2026-10-01", expiryDate: null, rate: "15.0000" },
        ]);
        expect(await db.select().from(loanInterestRatePeriods).where(eq(loanInterestRatePeriods.loanId, loan.id))).toHaveLength(1);
        expect(await db.select().from(loanInterestRatePreviews).where(eq(loanInterestRatePreviews.loanId, loan.id))).toHaveLength(1);
    });

    integrationTest("blocks a preview that would replace a materialized accrual date", async () => {
        const { actor, loan, period } = await seedFloatingLoan("tenant-a", "accrued");
        await db.insert(loanInterestAccruals).values({
            tenantId: "tenant-a", loanId: loan.id, interestRatePeriodId: period.id,
            accrualDate: "2026-08-10", openingPrincipal: "1000.00", rateMode: "per_thousand", rate: "15.0000",
            interestAmount: "15.00", status: "accrued", createdByUserId: actor.id,
        });

        await expect(previewLoanInterestRateChange(context("tenant-a", actor.id), loan.publicId, {
            effectiveDate: "2026-08-10", expiryDate: null, rateType: "percent", rate: "1",
        })).rejects.toMatchObject({
            code: "RATE_PERIOD_ACCRUED_DATE_CONFLICT",
            details: { earliestEditableDate: "2026-08-11" },
        });
    });

    integrationTest("executes the latest preview once with audit context and idempotent replay", async () => {
        setSystemTime(new Date("2026-08-11T10:00:00+07:00"));
        const { actor, loan } = await seedFloatingLoan("tenant-a", "execute", "1000.00", "active");
        const preview = await previewLoanInterestRateChange(context("tenant-a", actor.id), loan.publicId, {
            effectiveDate: "2026-09-01", expiryDate: null, rateType: "percent", rate: "1",
        });
        const executeContext = context("tenant-a", actor.id, "rate-change-execute-1");

        const first = await executeLoanInterestRateChange(executeContext, loan.publicId, {
            previewPublicId: preview.publicId, previewHash: preview.previewHash, reason: "Owner approved the scheduled rate",
        });
        const replay = await executeLoanInterestRateChange(executeContext, loan.publicId, {
            previewPublicId: preview.publicId, previewHash: preview.previewHash, reason: "Owner approved the scheduled rate",
        });

        expect(replay).toEqual(first);
        expect(first).toMatchObject({ loanPublicId: loan.publicId, correlationId: "corr-tenant-a" });
        expect(first.auditPublicId).toMatch(/^[0-9a-f-]{36}$/);
        expect(first.timeline.map(({ effectiveDate, rate }) => ({ effectiveDate, rate }))).toEqual([
            { effectiveDate: "2026-08-01", rate: "15.0000" },
            { effectiveDate: "2026-09-01", rate: "1.0000" },
        ]);
        expect(await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, loan.publicId), eq(auditLogs.action, "interest_rate_timeline_changed")))).toHaveLength(1);
    });

    integrationTest("rejects missing execution authority, hash mismatch, and stale timeline", async () => {
        const { actor, loan } = await seedFloatingLoan("tenant-a", "stale");
        const preview = await previewLoanInterestRateChange(context("tenant-a", actor.id), loan.publicId, {
            effectiveDate: "2026-09-01", expiryDate: null, rateType: "percent", rate: "1",
        });
        const input = { previewPublicId: preview.publicId, previewHash: preview.previewHash, reason: "Approved" };

        await expect(executeLoanInterestRateChange(context("tenant-a", actor.id), loan.publicId, input)).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REQUIRED" });
        await expect(executeLoanInterestRateChange(context("tenant-a", actor.id, "hash"), loan.publicId, { ...input, previewHash: `v1:${"0".repeat(64)}` })).rejects.toMatchObject({ code: "RATE_PERIOD_PREVIEW_STALE" });

        await db.update(loanInterestRatePeriods).set({ rate: "16.0000" }).where(eq(loanInterestRatePeriods.loanId, loan.id));
        try {
            await executeLoanInterestRateChange(context("tenant-a", actor.id, "stale"), loan.publicId, input);
            throw new Error("expected stale preview");
        } catch (error) {
            expect(error).toBeInstanceOf(DomainError);
            expect((error as DomainError).code).toBe("RATE_PERIOD_PREVIEW_STALE");
        }
    });

    integrationTest("rejects a new interest-rate execution after the floating loan is paid", async () => {
        const { actor, loan } = await seedFloatingLoan("tenant-paid-rate", "paid-guard");
        const preview = await previewLoanInterestRateChange(context("tenant-paid-rate", actor.id), loan.publicId, {
            effectiveDate: "2026-09-01", expiryDate: null, rateType: "percent", rate: "1",
        });
        await db.update(loans).set({ status: "paid" }).where(eq(loans.id, loan.id));

        await expect(executeLoanInterestRateChange(context("tenant-paid-rate", actor.id, "paid-rate-change"), loan.publicId, {
            previewPublicId: preview.publicId,
            previewHash: preview.previewHash,
            reason: "Must not mutate a paid loan",
        })).rejects.toMatchObject({ code: "LOAN_NOT_ACTIVE", status: 409 });
        expect(await db.select().from(auditLogs).where(and(
            eq(auditLogs.entityId, loan.publicId),
            eq(auditLogs.action, "interest_rate_timeline_changed"),
        ))).toHaveLength(0);
    });

    integrationTest("serializes concurrent execution into one timeline and audit", async () => {
        const { actor, loan } = await seedFloatingLoan("tenant-a", "concurrent");
        const preview = await previewLoanInterestRateChange(context("tenant-a", actor.id), loan.publicId, {
            effectiveDate: "2026-09-01", expiryDate: null, rateType: "percent", rate: "1",
        });
        const executeContext = context("tenant-a", actor.id, "rate-change-concurrent");
        const input = { previewPublicId: preview.publicId, previewHash: preview.previewHash, reason: "Approved once" };

        const [first, second] = await Promise.all([
            executeLoanInterestRateChange(executeContext, loan.publicId, input),
            executeLoanInterestRateChange(executeContext, loan.publicId, input),
        ]);

        expect(first).toEqual(second);
        expect(await db.select().from(loanInterestRatePeriods).where(eq(loanInterestRatePeriods.loanId, loan.id))).toHaveLength(2);
        expect(await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, loan.publicId), eq(auditLogs.action, "interest_rate_timeline_changed")))).toHaveLength(1);
    });
});
