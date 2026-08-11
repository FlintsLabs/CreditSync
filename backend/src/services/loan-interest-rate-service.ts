import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import {
    auditLogs,
    loanInterestAccruals,
    loanInterestRatePeriods,
    loanInterestRatePreviews,
    loans,
    users,
} from "../db/schema";
import { canAccessTenantWideData } from "../lib/access";
import { calculateDailyInterest } from "../lib/floating-daily-interest";
import {
    normalizeRatePeriodInput,
    replaceRateRange,
    resolveRatePeriod,
    timelineVersion,
    type RatePeriodInput,
    type RatePeriodValue,
    type RateType,
} from "../lib/interest-rate-periods";
import { serializeMoney } from "../lib/money";
import type { CommandContext } from "./command-context";
import { DomainError } from "./domain-error";

type Executor = any;
type LoanRow = typeof loans.$inferSelect;
type PeriodRow = typeof loanInterestRatePeriods.$inferSelect;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const previewHashPattern = /^v1:[0-9a-f]{64}$/i;
const previewTtlMilliseconds = 15 * 60 * 1000;

export type RateChangeInput = {
    effectiveDate: string;
    expiryDate: string | null;
    rateType: RateType;
    rate: string;
};

export type ExecuteRateChangeInput = {
    previewPublicId: string;
    previewHash: string;
    reason: string;
};

function requirePublicId(value: string, field: string) {
    if (!uuidPattern.test(value)) throw new DomainError("INVALID_PUBLIC_ID", `${field} must be a UUID`, 400, { field });
}

function sha256(value: unknown) {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function bangkokDate(value: Date) {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(value);
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value;
    return `${part("year")}-${part("month")}-${part("day")}`;
}

function nextDate(date: string) {
    const value = new Date(`${date}T00:00:00.000Z`);
    value.setUTCDate(value.getUTCDate() + 1);
    return value.toISOString().slice(0, 10);
}

function periodValue(row: PeriodRow): RatePeriodValue {
    return {
        publicId: row.publicId,
        effectiveDate: row.effectiveDate,
        expiryDate: row.expiryDate,
        rateType: row.rateType as RateType,
        rate: row.rate,
    };
}

function safeProjectedIds(timeline: RatePeriodValue[]) {
    return timeline.map((period) => ({
        ...period,
        publicId: uuidPattern.test(period.publicId) ? period.publicId : randomUUID(),
    }));
}

async function actorFor(ctx: CommandContext, executor: Executor = db) {
    if (ctx.actorUserId === null) return null;
    return executor.query.users.findFirst({ where: and(eq(users.id, ctx.actorUserId), eq(users.tenantId, ctx.tenantId)) });
}

async function accessibleLoan(ctx: CommandContext, loanPublicId: string, executor: Executor = db): Promise<LoanRow> {
    requirePublicId(loanPublicId, "loanPublicId");
    const loan = await executor.query.loans.findFirst({ where: and(eq(loans.publicId, loanPublicId), eq(loans.tenantId, ctx.tenantId)) });
    const actor = await actorFor(ctx, executor);
    if (!loan || (actor && !canAccessTenantWideData({ role: actor.role ?? "viewer" }) && loan.ownerUserId !== actor.id)) {
        throw new DomainError("LOAN_NOT_FOUND", "Loan not found", 404);
    }
    if (loan.repaymentType !== "floating") throw new DomainError("INVALID_RATE_PERIOD", "Interest rate periods require a floating loan", 409);
    return loan as LoanRow;
}

async function loadPeriodRows(executor: Executor, tenantId: string, loanId: number) {
    return executor.select().from(loanInterestRatePeriods).where(and(
        eq(loanInterestRatePeriods.tenantId, tenantId),
        eq(loanInterestRatePeriods.loanId, loanId),
    )).orderBy(asc(loanInterestRatePeriods.effectiveDate), asc(loanInterestRatePeriods.id)) as Promise<PeriodRow[]>;
}

async function latestAccrualDate(executor: Executor, tenantId: string, loanId: number) {
    const rows = await executor.select({ accrualDate: loanInterestAccruals.accrualDate })
        .from(loanInterestAccruals)
        .where(and(eq(loanInterestAccruals.tenantId, tenantId), eq(loanInterestAccruals.loanId, loanId)))
        .orderBy(sql`${loanInterestAccruals.accrualDate} DESC`)
        .limit(1);
    return rows[0]?.accrualDate ?? null;
}

function firstEditableDate(loan: LoanRow, latestAccrual: string | null) {
    if (latestAccrual) return nextDate(latestAccrual);
    if (!loan.interestStartDate) return loan.startDate ?? bangkokDate(new Date());
    return loan.firstDayTreatment === "start_next_day" ? nextDate(loan.interestStartDate) : loan.interestStartDate;
}

function presentPeriod(period: RatePeriodValue) {
    return { ...period };
}

async function presentTimeline(executor: Executor, loan: LoanRow, asOf: Date) {
    const rows = await loadPeriodRows(executor, loan.tenantId, loan.id);
    const timeline = rows.map(periodValue);
    const businessDate = bangkokDate(asOf);
    const currentPeriod = resolveRatePeriod(timeline, businessDate);
    const latestAccrual = await latestAccrualDate(executor, loan.tenantId, loan.id);
    const nextChange = timeline.find((period) => period.effectiveDate > businessDate) ?? null;
    return {
        loanPublicId: loan.publicId,
        asOfDate: businessDate,
        currentPeriod: currentPeriod ? presentPeriod(currentPeriod) : null,
        dailyInterestAtCurrentPrincipal: currentPeriod
            ? calculateDailyInterest(serializeMoney(loan.outstandingPrincipal ?? loan.principalAmount), {
                mode: currentPeriod.rateType,
                rate: currentPeriod.rate,
                firstDayTreatment: "start_next_day",
            })
            : null,
        nextChange: nextChange ? presentPeriod(nextChange) : null,
        earliestEditableDate: firstEditableDate(loan, latestAccrual),
        timeline: timeline.map(presentPeriod),
        timelineVersion: timelineVersion(timeline),
    };
}

export async function listLoanInterestRates(ctx: CommandContext, loanPublicId: string, asOf = new Date()) {
    const loan = await accessibleLoan(ctx, loanPublicId);
    return presentTimeline(db, loan, asOf);
}

function requestedDatesIncludeAccrual(input: RatePeriodInput, accrualDate: string) {
    return input.effectiveDate <= accrualDate && (input.expiryDate === null || accrualDate <= input.expiryDate);
}

async function assertNoAccruedDateConflict(executor: Executor, loan: LoanRow, input: RatePeriodInput) {
    const accruals = await executor.select({ accrualDate: loanInterestAccruals.accrualDate })
        .from(loanInterestAccruals)
        .where(and(eq(loanInterestAccruals.tenantId, loan.tenantId), eq(loanInterestAccruals.loanId, loan.id)))
        .orderBy(asc(loanInterestAccruals.accrualDate));
    const latest = accruals.at(-1)?.accrualDate ?? null;
    if (accruals.some((row: { accrualDate: string }) => requestedDatesIncludeAccrual(input, row.accrualDate))) {
        throw new DomainError("RATE_PERIOD_ACCRUED_DATE_CONFLICT", "The requested range includes an immutable accrued date", 409, {
            earliestEditableDate: firstEditableDate(loan, latest),
        });
    }
}

function normalizeChangeInput(input: RateChangeInput) {
    try {
        const normalized = normalizeRatePeriodInput(input, randomUUID());
        const { publicId: _publicId, ...request } = normalized;
        return request;
    } catch (error) {
        throw new DomainError("INVALID_RATE_PERIOD", error instanceof Error ? error.message : "Interest rate period is invalid", 400);
    }
}

function buildPreviewHash(input: {
    loanPublicId: string;
    request: RatePeriodInput;
    timelineVersion: string;
    afterTimeline: RatePeriodValue[];
    expiresAt: Date;
}) {
    return `v1:${sha256({
        loanPublicId: input.loanPublicId,
        request: input.request,
        timelineVersion: input.timelineVersion,
        afterTimeline: input.afterTimeline,
        expiresAt: input.expiresAt.toISOString(),
    })}`;
}

export async function previewLoanInterestRateChange(ctx: CommandContext, loanPublicId: string, input: RateChangeInput) {
    const loan = await accessibleLoan(ctx, loanPublicId);
    const request = normalizeChangeInput(input);
    await assertNoAccruedDateConflict(db, loan, request);
    const beforeTimeline = (await loadPeriodRows(db, loan.tenantId, loan.id)).map(periodValue);
    const version = timelineVersion(beforeTimeline);
    const projected = replaceRateRange(beforeTimeline, { ...request, newPublicId: randomUUID() });
    const afterTimeline = safeProjectedIds(projected.timeline);
    const expiresAt = new Date(Date.now() + previewTtlMilliseconds);
    const previewHash = buildPreviewHash({ loanPublicId, request, timelineVersion: version, afterTimeline, expiresAt });
    const row = await db.insert(loanInterestRatePreviews).values({
        tenantId: ctx.tenantId,
        loanId: loan.id,
        createdByUserId: ctx.actorUserId,
        request,
        requestHash: sha256(request),
        previewHash,
        beforeTimeline,
        afterTimeline,
        timelineVersion: version,
        expiresAt,
    }).returning().then((rows) => rows[0]!);
    return {
        id: row.publicId,
        publicId: row.publicId,
        loanPublicId,
        request,
        beforeTimeline,
        afterTimeline,
        supersededPeriodPublicIds: projected.supersededPublicIds,
        warnings: [],
        timelineVersion: version,
        previewHash,
        expiresAt: expiresAt.toISOString(),
    };
}

function requireExecute(ctx: CommandContext, input: ExecuteRateChangeInput) {
    requirePublicId(input.previewPublicId, "previewPublicId");
    if (!previewHashPattern.test(input.previewHash)) throw new DomainError("INVALID_PREVIEW_HASH", "previewHash must be a versioned SHA-256 hash", 400);
    const reason = input.reason?.trim();
    if (!reason) throw new DomainError("RATE_PERIOD_REASON_REQUIRED", "Interest rate execution requires a reason", 400);
    const idempotencyKey = ctx.idempotencyKey?.trim();
    if (!idempotencyKey) throw new DomainError("IDEMPOTENCY_KEY_REQUIRED", "Interest rate execution requires a non-blank Idempotency-Key", 400);
    return { reason, idempotencyKey };
}

async function applyTimeline(executor: Executor, loan: LoanRow, beforeRows: PeriodRow[], afterTimeline: RatePeriodValue[], actorUserId: number | null) {
    const desiredIds = new Set(afterTimeline.map((period) => period.publicId));
    const removableIds = beforeRows.filter((row) => !desiredIds.has(row.publicId)).map((row) => row.id);
    if (removableIds.length) await executor.delete(loanInterestRatePeriods).where(and(
        eq(loanInterestRatePeriods.tenantId, loan.tenantId),
        inArray(loanInterestRatePeriods.id, removableIds),
    ));

    const existingByPublicId = new Map(beforeRows.map((row) => [row.publicId, row]));
    for (const period of afterTimeline) {
        const existing = existingByPublicId.get(period.publicId);
        const values = {
            effectiveDate: period.effectiveDate,
            expiryDate: period.expiryDate,
            rateType: period.rateType,
            rate: period.rate,
            updatedAt: new Date(),
        };
        if (existing) {
            await executor.update(loanInterestRatePeriods).set(values).where(and(
                eq(loanInterestRatePeriods.tenantId, loan.tenantId),
                eq(loanInterestRatePeriods.id, existing.id),
            ));
        } else {
            await executor.insert(loanInterestRatePeriods).values({
                publicId: period.publicId,
                tenantId: loan.tenantId,
                loanId: loan.id,
                ...values,
                createdByUserId: actorUserId,
            });
        }
    }
}

export async function executeLoanInterestRateChange(
    ctx: CommandContext,
    loanPublicId: string,
    input: ExecuteRateChangeInput,
) {
    const { reason, idempotencyKey } = requireExecute(ctx, input);
    await accessibleLoan(ctx, loanPublicId);
    return db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`loan-rate-change:${ctx.tenantId}:${loanPublicId}`}, 0))`);
        const loan = await accessibleLoan(ctx, loanPublicId, tx);
        const reused = await tx.query.loanInterestRatePreviews.findFirst({ where: and(
            eq(loanInterestRatePreviews.tenantId, ctx.tenantId),
            eq(loanInterestRatePreviews.executeIdempotencyKey, idempotencyKey),
        ) });
        if (reused && reused.publicId !== input.previewPublicId) {
            throw new DomainError("IDEMPOTENCY_KEY_CONFLICT", "Idempotency-Key was already used for another interest rate preview", 409);
        }
        await tx.execute(sql`SELECT id FROM loan_interest_rate_previews WHERE tenant_id = ${ctx.tenantId} AND public_id = ${input.previewPublicId} FOR UPDATE`);
        const preview = await tx.query.loanInterestRatePreviews.findFirst({ where: and(
            eq(loanInterestRatePreviews.tenantId, ctx.tenantId),
            eq(loanInterestRatePreviews.loanId, loan.id),
            eq(loanInterestRatePreviews.publicId, input.previewPublicId),
        ) });
        if (!preview) throw new DomainError("RATE_PERIOD_PREVIEW_NOT_FOUND", "Interest rate preview not found", 404);
        if (preview.status === "executed") {
            if (preview.executeIdempotencyKey !== idempotencyKey || preview.previewHash !== input.previewHash) {
                throw new DomainError("IDEMPOTENCY_KEY_CONFLICT", "Interest rate preview was already executed with different authority", 409);
            }
            const timeline = await presentTimeline(tx, loan, new Date());
            return {
                ...timeline,
                auditPublicId: preview.executedAuditPublicId!,
                correlationId: ctx.correlationId,
            };
        }
        if (preview.status !== "ready" || preview.expiresAt.getTime() <= Date.now() || preview.previewHash !== input.previewHash) {
            throw new DomainError("RATE_PERIOD_PREVIEW_STALE", "Interest rate preview is stale or expired", 409);
        }
        const beforeRows = await loadPeriodRows(tx, loan.tenantId, loan.id);
        const beforeTimeline = beforeRows.map(periodValue);
        if (timelineVersion(beforeTimeline) !== preview.timelineVersion) {
            throw new DomainError("RATE_PERIOD_PREVIEW_STALE", "Interest rate timeline changed after preview", 409);
        }
        await assertNoAccruedDateConflict(tx, loan, preview.request as RatePeriodInput);
        await applyTimeline(tx, loan, beforeRows, preview.afterTimeline as RatePeriodValue[], ctx.actorUserId);
        const audit = await tx.insert(auditLogs).values({
            tenantId: ctx.tenantId,
            entityType: "loan_interest_rate_timeline",
            entityId: loan.publicId,
            action: "interest_rate_timeline_changed",
            actorUserId: ctx.actorUserId,
            actorSource: ctx.actorSource,
            requestId: ctx.requestId,
            correlationId: ctx.correlationId,
            payload: {
                before: beforeTimeline,
                after: preview.afterTimeline,
                request: preview.request,
                reason,
                previewPublicId: preview.publicId,
                previewHash: preview.previewHash,
                idempotencyKey,
            },
        }).returning().then((rows) => rows[0]!);
        await tx.update(loanInterestRatePreviews).set({
            status: "executed",
            executeIdempotencyKey: idempotencyKey,
            executedAuditPublicId: audit.publicId,
            executedAt: new Date(),
            updatedAt: new Date(),
        }).where(and(eq(loanInterestRatePreviews.tenantId, ctx.tenantId), eq(loanInterestRatePreviews.id, preview.id)));
        const timeline = await presentTimeline(tx, loan, new Date());
        return { ...timeline, auditPublicId: audit.publicId, correlationId: ctx.correlationId };
    }).catch((error: unknown) => {
        const code = (error as { cause?: { code?: string }; code?: string })?.cause?.code ?? (error as { code?: string })?.code;
        if (code === "23P01") throw new DomainError("RATE_PERIOD_OVERLAP_CONFLICT", "Interest rate periods overlap", 409);
        throw error;
    });
}
