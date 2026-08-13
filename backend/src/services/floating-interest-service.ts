import { and, asc, eq, inArray, sql } from "drizzle-orm";
import Decimal from "decimal.js";
import { db } from "../db";
import {
    floatingPenaltyLedgerEntries,
    floatingTransactionAllocations,
    loanAdjustments,
    loanInterestAccruals,
    loanInterestRatePeriods,
    loans,
    transactions,
} from "../db/schema";
import { createAuditLog } from "../lib/audit-log";
import { calculateDailyInterest, interestDatesThrough, type FloatingAccrualCycle, type FloatingDailyInterest, type FloatingDailyInterestInput } from "../lib/floating-daily-interest";
import { calculateWeeklyAccruedInterest, weeklySnapshotPeriod } from "../lib/floating-interest-period";
import { resolveRatePeriod, type RatePeriodValue, type RateType } from "../lib/interest-rate-periods";
import { DomainError } from "./domain-error";
import type { CommandContext } from "./command-context";

type Executor = any;

function bangkokDate(value: Date) {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(value);
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value;
    return `${part("year")}-${part("month")}-${part("day")}`;
}

function calendarDays(from: string, to: string) {
    return Math.max(0, Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000));
}

type WeeklyExpectedAccrual = {
    accrualDate: string;
    interestRatePeriodId: number;
    openingPrincipal: string;
    rateMode: RateType;
    rate: string;
    periodStartDate: string;
    periodEndDate: string;
    periodDayIndex: number;
    periodDays: number;
    cumulativeInterestAmount: string;
    interestAmount: string;
    status: "accruing" | "due" | "paid";
    paidAmount: string;
};

async function weeklyExpectedAccruals(
    tx: Executor,
    loan: typeof loans.$inferSelect,
    throughDate: string,
): Promise<WeeklyExpectedAccrual[]> {
    if (!loan.interestStartDate || !loan.firstDayTreatment) return [];
    const periodRows = await tx.select().from(loanInterestRatePeriods).where(and(
        eq(loanInterestRatePeriods.tenantId, loan.tenantId),
        eq(loanInterestRatePeriods.loanId, loan.id),
    )).orderBy(asc(loanInterestRatePeriods.effectiveDate));
    const periods: RatePeriodValue[] = periodRows.map((row: typeof loanInterestRatePeriods.$inferSelect) => ({
        publicId: row.publicId,
        effectiveDate: row.effectiveDate,
        expiryDate: row.expiryDate,
        rateType: row.rateType as RateType,
        rate: row.rate,
    }));
    const rowByPublicId = new Map<string, typeof loanInterestRatePeriods.$inferSelect>(
        periodRows.map((row: typeof loanInterestRatePeriods.$inferSelect) => [row.publicId, row]),
    );
    const allTransactions = await tx.select().from(transactions).where(and(
        eq(transactions.tenantId, loan.tenantId),
        eq(transactions.loanId, loan.id),
    ));
    const dates = interestDatesThrough(
        loan.interestStartDate,
        throughDate,
        loan.firstDayTreatment as FloatingDailyInterest["firstDayTreatment"],
        "weekly",
    );

    let segmentKey = "";
    let segmentElapsed = 0;
    let periodKey = "";
    let periodCumulative = new Decimal(0);
    return dates.map((accrualDate) => {
        const snapshot = weeklySnapshotPeriod(loan.interestStartDate!, accrualDate);
        const advanceCovered = loan.firstDayTreatment === "deduct" && snapshot.periodStartDate === loan.interestStartDate;
        const periodValue = resolveRatePeriod(periods, advanceCovered ? loan.interestStartDate! : accrualDate);
        const storedPeriod = periodValue ? rowByPublicId.get(periodValue.publicId) : undefined;
        if (!periodValue || !storedPeriod) {
            throw new DomainError("RATE_PERIOD_MISSING_COVERAGE", "Floating loan has no interest rate for an accrual date", 409, {
                accrualDate,
                loanPublicId: loan.publicId,
            });
        }
        const principalAppliedBefore = allTransactions
            .filter((row: typeof transactions.$inferSelect) => row.postedAt
                && row.transactionDate
                && bangkokDate(row.transactionDate) < accrualDate)
            .reduce((sum: Decimal, row: typeof transactions.$inferSelect) => sum.plus(row.principalComponent), new Decimal(0));
        const openingPrincipal = advanceCovered
            ? new Decimal(loan.principalAmount).toFixed(2)
            : Decimal.max(0, new Decimal(loan.principalAmount).minus(principalAppliedBefore)).toFixed(2);
        const nextPeriodKey = `${snapshot.periodStartDate}:${snapshot.periodEndDate}`;
        if (nextPeriodKey !== periodKey) {
            periodKey = nextPeriodKey;
            periodCumulative = new Decimal(0);
            segmentKey = "";
        }
        const nextSegmentKey = `${nextPeriodKey}:${storedPeriod.id}:${openingPrincipal}:${periodValue.rateType}:${periodValue.rate}`;
        segmentElapsed = advanceCovered ? snapshot.dayIndex : nextSegmentKey === segmentKey ? segmentElapsed + 1 : 1;
        segmentKey = nextSegmentKey;
        const calculated = calculateWeeklyAccruedInterest(openingPrincipal, periodValue.rateType, periodValue.rate, segmentElapsed);
        periodCumulative = periodCumulative.plus(calculated.incrementAmount);
        const advancePaid = advanceCovered;
        const periodComplete = throughDate >= snapshot.periodEndDate;
        return {
            accrualDate,
            interestRatePeriodId: storedPeriod.id,
            openingPrincipal,
            rateMode: periodValue.rateType,
            rate: periodValue.rate,
            periodStartDate: snapshot.periodStartDate,
            periodEndDate: snapshot.periodEndDate,
            periodDayIndex: snapshot.dayIndex,
            periodDays: snapshot.periodDays,
            cumulativeInterestAmount: periodCumulative.toFixed(2),
            interestAmount: calculated.incrementAmount,
            status: advancePaid ? "paid" : periodComplete ? "due" : "accruing",
            paidAmount: advancePaid ? calculated.incrementAmount : "0.00",
        };
    });
}

export async function accrueFloatingInterestThrough(tx: Executor, loan: typeof loans.$inferSelect, through: Date, actorUserId: number | null) {
    if (loan.repaymentType !== "floating" || !loan.dailyInterestMode || !loan.dailyInterestRate || !loan.firstDayTreatment || !loan.interestStartDate) return [];
    const firstDayTreatment = loan.firstDayTreatment as FloatingDailyInterest["firstDayTreatment"];
    const accrualCycle = (loan.floatingAccrualCycle ?? "daily") as FloatingAccrualCycle;
    const existing = await tx.select().from(loanInterestAccruals).where(and(eq(loanInterestAccruals.tenantId, loan.tenantId), eq(loanInterestAccruals.loanId, loan.id)));
    if (accrualCycle === "weekly") {
        const throughDate = bangkokDate(through);
        const expected = await weeklyExpectedAccruals(tx, loan, throughDate);
        const dates = new Set(existing.filter((row: typeof loanInterestAccruals.$inferSelect) => row.status !== "reversed").map((row: typeof loanInterestAccruals.$inferSelect) => row.accrualDate));
        const legacyCoveredPeriods = new Set<string>();
        for (const row of existing as Array<typeof loanInterestAccruals.$inferSelect>) {
            if (row.status === "reversed" || row.periodStartDate !== null) continue;
            if (row.accrualDate === loan.interestStartDate && firstDayTreatment === "deduct") {
                legacyCoveredPeriods.add(loan.interestStartDate);
                continue;
            }
            try {
                legacyCoveredPeriods.add(weeklySnapshotPeriod(loan.interestStartDate, row.accrualDate).periodStartDate);
            } catch {
                // A legacy anchor-date advance row is handled above; malformed history remains visible for correction.
            }
        }
        const missing = expected.filter((row) => !dates.has(row.accrualDate) && !legacyCoveredPeriods.has(row.periodStartDate));
        if (missing.length) {
            await tx.insert(loanInterestAccruals).values(missing.map((row) => ({
                tenantId: loan.tenantId,
                loanId: loan.id,
                interestRatePeriodId: row.interestRatePeriodId,
                accrualDate: row.accrualDate,
                openingPrincipal: row.openingPrincipal,
                rateMode: row.rateMode,
                rate: row.rate,
                periodStartDate: row.periodStartDate,
                periodEndDate: row.periodEndDate,
                periodDayIndex: row.periodDayIndex,
                periodDays: row.periodDays,
                cumulativeInterestAmount: row.cumulativeInterestAmount,
                interestAmount: row.interestAmount,
                paidAmount: row.paidAmount,
                status: row.status,
                createdByUserId: actorUserId,
            }))).onConflictDoNothing();
        }
        const completedPeriodStarts = [...new Set(expected.filter((row) => row.status === "due").map((row) => row.periodStartDate))];
        if (completedPeriodStarts.length) {
            await tx.update(loanInterestAccruals).set({ status: "due" }).where(and(
                eq(loanInterestAccruals.tenantId, loan.tenantId),
                eq(loanInterestAccruals.loanId, loan.id),
                inArray(loanInterestAccruals.periodStartDate, completedPeriodStarts),
                eq(loanInterestAccruals.status, "accruing"),
            ));
        }
        return await tx.select().from(loanInterestAccruals).where(and(eq(loanInterestAccruals.tenantId, loan.tenantId), eq(loanInterestAccruals.loanId, loan.id)));
    }
    const dates = new Set(existing.map((row: typeof loanInterestAccruals.$inferSelect) => row.accrualDate));
    const dueDates = interestDatesThrough(loan.interestStartDate, bangkokDate(through), firstDayTreatment, accrualCycle).filter((date) => !dates.has(date));
    if (!dueDates.length) return existing;
    const periodRows = await tx.select().from(loanInterestRatePeriods).where(and(
        eq(loanInterestRatePeriods.tenantId, loan.tenantId),
        eq(loanInterestRatePeriods.loanId, loan.id),
    )).orderBy(asc(loanInterestRatePeriods.effectiveDate));
    const periods: RatePeriodValue[] = periodRows.map((row: typeof loanInterestRatePeriods.$inferSelect) => ({
        publicId: row.publicId,
        effectiveDate: row.effectiveDate,
        expiryDate: row.expiryDate,
        rateType: row.rateType as RateType,
        rate: row.rate,
    }));
    const rowByPublicId = new Map<string, typeof loanInterestRatePeriods.$inferSelect>(
        periodRows.map((row: typeof loanInterestRatePeriods.$inferSelect) => [row.publicId, row]),
    );
    const resolved = dueDates.map((accrualDate) => ({ accrualDate, period: resolveRatePeriod(periods, accrualDate) }));
    const missing = resolved.find((item) => item.period === null);
    if (missing) {
        throw new DomainError("RATE_PERIOD_MISSING_COVERAGE", "Floating loan has no interest rate for an accrual date", 409, {
            accrualDate: missing.accrualDate,
            loanPublicId: loan.publicId,
        });
    }
    const allTransactions = await tx.select().from(transactions).where(and(
        eq(transactions.tenantId, loan.tenantId),
        eq(transactions.loanId, loan.id),
    ));
    await tx.insert(loanInterestAccruals).values(resolved.map(({ accrualDate, period }) => {
        const effectivePeriod = period!;
        const storedPeriod = rowByPublicId.get(effectivePeriod.publicId)!;
        const principalAppliedBefore = allTransactions
            .filter((row: typeof transactions.$inferSelect) => row.postedAt
                && row.transactionDate
                && bangkokDate(row.transactionDate) < accrualDate)
            .reduce((sum: Decimal, row: typeof transactions.$inferSelect) => sum.plus(row.principalComponent), new Decimal(0));
        const openingPrincipal = Decimal.max(0, new Decimal(loan.principalAmount).minus(principalAppliedBefore));
        const policy: FloatingDailyInterestInput = {
            mode: effectivePeriod.rateType,
            rate: effectivePeriod.rate,
            firstDayTreatment,
            accrualCycle,
        };
        const interestAmount = calculateDailyInterest(openingPrincipal.toFixed(2), policy);
        const advancePaid = firstDayTreatment === "deduct" && accrualDate === loan.interestStartDate;
        return {
            tenantId: loan.tenantId,
            loanId: loan.id,
            interestRatePeriodId: storedPeriod.id,
            accrualDate,
            openingPrincipal: openingPrincipal.toFixed(2),
            rateMode: policy.mode,
            rate: policy.rate,
            interestAmount,
            paidAmount: advancePaid ? interestAmount : "0.00",
            status: advancePaid ? "paid" : "accrued",
            createdByUserId: actorUserId,
        };
    })).onConflictDoNothing();
    return await tx.select().from(loanInterestAccruals).where(and(eq(loanInterestAccruals.tenantId, loan.tenantId), eq(loanInterestAccruals.loanId, loan.id)));
}

function assertFloatingAccrualHistory(
    rows: Array<typeof loanInterestAccruals.$inferSelect>,
    loan: typeof loans.$inferSelect,
    throughDate: string,
) {
    const corrupt = rows.find((row: typeof loanInterestAccruals.$inferSelect) =>
        row.status !== "reversed"
        && row.accrualDate <= throughDate
        && new Decimal(row.openingPrincipal).eq(0)
        && new Decimal(row.interestAmount).eq(0)
        && new Decimal(row.rate).gt(0)
        && new Decimal(loan.outstandingPrincipal ?? loan.principalAmount).gt(0));
    if (corrupt) {
        throw new DomainError("FLOATING_INTEREST_ACCRUAL_CORRUPT", "Floating interest history must be corrected before allocating a payment", 409, {
            loanPublicId: loan.publicId,
            accrualDate: corrupt.accrualDate,
            accrualPublicId: corrupt.publicId,
        });
    }
}

export type FloatingPenaltyGroup = {
    dueDate: string;
    accruedPenalty: Decimal;
    paidPenalty: Decimal;
    penaltyDue: Decimal;
    interestDue: Decimal;
};

type ProjectedAccrual = typeof loanInterestAccruals.$inferSelect;

type ProjectedPenaltyAssessment = {
    dueDate: string;
    penaltyDate: string;
    entryType: "fixed_assessment" | "daily_percent_accrual";
    amount: Decimal;
    openingInterestBasis: Decimal;
};

function datesBetweenInclusive(from: string, through: string) {
    const dates: string[] = [];
    const cursor = new Date(`${from}T00:00:00Z`);
    const end = new Date(`${through}T00:00:00Z`);
    while (cursor <= end) {
        dates.push(cursor.toISOString().slice(0, 10));
        cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return dates;
}

async function expectedDailyAccruals(
    tx: Executor,
    loan: typeof loans.$inferSelect,
    throughDate: string,
): Promise<Array<Omit<ProjectedAccrual, "id" | "publicId" | "createdAt">>> {
    if (!loan.interestStartDate || !loan.firstDayTreatment) return [];
    const periodRows = await tx.select().from(loanInterestRatePeriods).where(and(
        eq(loanInterestRatePeriods.tenantId, loan.tenantId),
        eq(loanInterestRatePeriods.loanId, loan.id),
    )).orderBy(asc(loanInterestRatePeriods.effectiveDate));
    const periods: RatePeriodValue[] = periodRows.map((row: typeof loanInterestRatePeriods.$inferSelect) => ({
        publicId: row.publicId,
        effectiveDate: row.effectiveDate,
        expiryDate: row.expiryDate,
        rateType: row.rateType as RateType,
        rate: row.rate,
    }));
    const rowByPublicId = new Map<string, typeof loanInterestRatePeriods.$inferSelect>(
        periodRows.map((row: typeof loanInterestRatePeriods.$inferSelect) => [row.publicId, row]),
    );
    const allTransactions = await tx.select().from(transactions).where(and(
        eq(transactions.tenantId, loan.tenantId), eq(transactions.loanId, loan.id),
    ));
    const dates = interestDatesThrough(
        loan.interestStartDate,
        throughDate,
        loan.firstDayTreatment as FloatingDailyInterest["firstDayTreatment"],
        "daily",
    );
    return dates.map((accrualDate) => {
        const period = resolveRatePeriod(periods, accrualDate);
        const storedPeriod = period ? rowByPublicId.get(period.publicId) : undefined;
        if (!period || !storedPeriod) {
            throw new DomainError("RATE_PERIOD_MISSING_COVERAGE", "Floating loan has no interest rate for an accrual date", 409, {
                accrualDate, loanPublicId: loan.publicId,
            });
        }
        const principalAppliedBefore = allTransactions
            .filter((row: typeof transactions.$inferSelect) => row.postedAt
                && row.transactionDate
                && bangkokDate(row.transactionDate) < accrualDate)
            .reduce((sum: Decimal, row: typeof transactions.$inferSelect) => sum.plus(row.principalComponent), new Decimal(0));
        const openingPrincipal = Decimal.max(0, new Decimal(loan.principalAmount).minus(principalAppliedBefore)).toFixed(2);
        const interestAmount = calculateDailyInterest(openingPrincipal, {
            mode: period.rateType,
            rate: period.rate,
            firstDayTreatment: loan.firstDayTreatment as FloatingDailyInterest["firstDayTreatment"],
            accrualCycle: "daily",
        });
        const advancePaid = loan.firstDayTreatment === "deduct" && accrualDate === loan.interestStartDate;
        return {
            tenantId: loan.tenantId,
            loanId: loan.id,
            interestRatePeriodId: storedPeriod.id,
            accrualDate,
            openingPrincipal,
            rateMode: period.rateType,
            rate: period.rate,
            periodStartDate: null,
            periodEndDate: null,
            periodDayIndex: null,
            periodDays: null,
            cumulativeInterestAmount: null,
            interestAmount,
            paidAmount: advancePaid ? interestAmount : "0.00",
            accruedPenalty: "0.00",
            paidPenalty: "0.00",
            status: advancePaid ? "paid" : "accrued",
            sourceTransactionId: null,
            reversedAccrualId: null,
            createdByUserId: null,
        };
    });
}

async function projectFloatingAccrualRows(
    tx: Executor,
    loan: typeof loans.$inferSelect,
    throughDate: string,
): Promise<ProjectedAccrual[]> {
    if (loan.repaymentType !== "floating" || !loan.dailyInterestMode || !loan.dailyInterestRate || !loan.firstDayTreatment || !loan.interestStartDate) return [];
    const existing = await tx.select().from(loanInterestAccruals).where(and(
        eq(loanInterestAccruals.tenantId, loan.tenantId),
        eq(loanInterestAccruals.loanId, loan.id),
    )) as ProjectedAccrual[];
    const activeByDate = new Map<string, ProjectedAccrual>(existing
        .filter((row: ProjectedAccrual) => row.status !== "reversed")
        .map((row: ProjectedAccrual) => [row.accrualDate, row] as [string, ProjectedAccrual]));
    const accrualCycle = (loan.floatingAccrualCycle ?? "daily") as FloatingAccrualCycle;
    const expected = accrualCycle === "weekly"
        ? await weeklyExpectedAccruals(tx, loan, throughDate)
        : await expectedDailyAccruals(tx, loan, throughDate);
    const legacyCoveredPeriods = new Set<string>();
    if (accrualCycle === "weekly") {
        for (const row of activeByDate.values()) {
            if (row.periodStartDate !== null) continue;
            if (row.accrualDate === loan.interestStartDate && loan.firstDayTreatment === "deduct") {
                legacyCoveredPeriods.add(loan.interestStartDate);
                continue;
            }
            try {
                legacyCoveredPeriods.add(weeklySnapshotPeriod(loan.interestStartDate, row.accrualDate).periodStartDate);
            } catch {
                // Malformed legacy history stays visible below for explicit correction.
            }
        }
    }
    let virtualId = -1;
    const expectedRows: ProjectedAccrual[] = expected
        .filter((expectedRow) => !("periodStartDate" in expectedRow
            && expectedRow.periodStartDate !== null
            && legacyCoveredPeriods.has(expectedRow.periodStartDate)))
        .map((expectedRow) => {
        const row = expectedRow as WeeklyExpectedAccrual & Partial<ProjectedAccrual>;
        return activeByDate.get(row.accrualDate) ?? {
        ...(row as ProjectedAccrual),
        id: virtualId--,
        publicId: `projected:${loan.publicId}:${row.accrualDate}`,
        tenantId: loan.tenantId,
        loanId: loan.id,
        accruedPenalty: "0.00",
        paidPenalty: "0.00",
        sourceTransactionId: null,
        reversedAccrualId: null,
        createdByUserId: null,
        createdAt: null,
    } as ProjectedAccrual;
        });
    const expectedDates = new Set(expectedRows.map((row) => row.accrualDate));
    for (const row of activeByDate.values()) {
        if (row.accrualDate <= throughDate && !expectedDates.has(row.accrualDate)) expectedRows.push(row);
    }
    const allocations = await tx.select().from(floatingTransactionAllocations).where(and(
        eq(floatingTransactionAllocations.tenantId, loan.tenantId),
        eq(floatingTransactionAllocations.loanId, loan.id),
        eq(floatingTransactionAllocations.component, "interest"),
    ));
    const legacyCutovers = await tx.select().from(floatingPenaltyLedgerEntries).where(and(
        eq(floatingPenaltyLedgerEntries.tenantId, loan.tenantId),
        eq(floatingPenaltyLedgerEntries.loanId, loan.id),
        eq(floatingPenaltyLedgerEntries.entryType, "legacy_cutover"),
    ));
    const legacyCutoverDate = (legacyCutovers as Array<typeof floatingPenaltyLedgerEntries.$inferSelect>)
        .reduce((latest: string | null, entry: typeof floatingPenaltyLedgerEntries.$inferSelect) =>
            !latest || entry.penaltyDate > latest ? entry.penaltyDate : latest, null);
    if (legacyCutoverDate && throughDate < legacyCutoverDate) {
        throw new DomainError(
            "FLOATING_HISTORY_BEFORE_LEDGER_CUTOVER",
            "Floating history before the exact ledger cutover requires manual reconciliation",
            409,
            { loanPublicId: loan.publicId, earliestSupportedDate: legacyCutoverDate },
        );
    }
    const allByAccrual = new Map<number, Decimal>();
    const asOfByAccrual = new Map<number, Decimal>();
    for (const allocation of allocations as Array<typeof floatingTransactionAllocations.$inferSelect>) {
        if (!allocation.interestAccrualId) continue;
        allByAccrual.set(allocation.interestAccrualId, (allByAccrual.get(allocation.interestAccrualId) ?? new Decimal(0)).plus(allocation.amount));
        if (allocation.effectiveDate <= throughDate) {
            asOfByAccrual.set(allocation.interestAccrualId, (asOfByAccrual.get(allocation.interestAccrualId) ?? new Decimal(0)).plus(allocation.amount));
        }
    }
    return expectedRows.sort((left, right) => left.accrualDate.localeCompare(right.accrualDate) || left.id - right.id).map((row) => {
        const allAllocated = row.id > 0 ? allByAccrual.get(row.id) ?? new Decimal(0) : new Decimal(0);
        const asOfAllocated = row.id > 0 ? asOfByAccrual.get(row.id) ?? new Decimal(0) : new Decimal(0);
        const baselinePaid = Decimal.max(new Decimal(row.paidAmount).minus(allAllocated), 0);
        const paidAmount = Decimal.min(new Decimal(row.interestAmount), Decimal.max(0, baselinePaid.plus(asOfAllocated)));
        const dueDate = row.periodEndDate ?? row.accrualDate;
        const status: ProjectedAccrual["status"] = paidAmount.eq(row.interestAmount)
            ? "paid"
            : paidAmount.gt(0) && row.periodEndDate
                ? "partially_paid"
                : row.periodEndDate && throughDate < row.periodEndDate
                    ? "accruing"
                    : row.periodEndDate
                        ? "due"
                        : "accrued";
        return { ...row, paidAmount: paidAmount.toFixed(2), status, periodEndDate: row.periodEndDate ?? (dueDate === row.accrualDate ? null : dueDate) };
    });
}

async function projectFloatingPenaltyGroups(
    tx: Executor,
    loan: typeof loans.$inferSelect,
    rows: ProjectedAccrual[],
    throughDate: string,
) {
    const grouped = new Map<string, ProjectedAccrual[]>();
    for (const row of rows) {
        if (row.status === "reversed") continue;
        const dueDate = row.periodEndDate ?? row.accrualDate;
        grouped.set(dueDate, [...(grouped.get(dueDate) ?? []), row]);
    }
    const allocations = await tx.select().from(floatingTransactionAllocations).where(and(
        eq(floatingTransactionAllocations.tenantId, loan.tenantId),
        eq(floatingTransactionAllocations.loanId, loan.id),
    ));
    const ledger = await tx.select().from(floatingPenaltyLedgerEntries).where(and(
        eq(floatingPenaltyLedgerEntries.tenantId, loan.tenantId),
        eq(floatingPenaltyLedgerEntries.loanId, loan.id),
    ));
    const feeValue = new Decimal(loan.lateFeeAmount ?? "0.00");
    const graceDays = Math.max(0, loan.gracePeriodDays ?? 0);
    const loanCutoverDate = ledger
        .filter((entry: typeof floatingPenaltyLedgerEntries.$inferSelect) => entry.entryType === "legacy_cutover")
        .reduce((latest: string | null, entry: typeof floatingPenaltyLedgerEntries.$inferSelect) =>
            !latest || entry.penaltyDate > latest ? entry.penaltyDate : latest, null);
    const groups: FloatingPenaltyGroup[] = [];
    const assessments: ProjectedPenaltyAssessment[] = [];
    const effectiveAssessments: ProjectedPenaltyAssessment[] = [];
    for (const [dueDate, groupRows] of [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right))) {
        const baseInterest = groupRows.reduce((sum, row) => sum.plus(row.interestAmount), new Decimal(0));
        const currentInterest = groupRows.reduce((sum, row) => sum.plus(Decimal.max(new Decimal(row.interestAmount).minus(row.paidAmount), 0)), new Decimal(0));
        const currentGroupAllocations = allocations.filter((row: typeof floatingTransactionAllocations.$inferSelect) =>
            row.dueDate === dueDate && row.effectiveDate <= throughDate);
        const interestAllocatedThrough = currentGroupAllocations
            .filter((row: typeof floatingTransactionAllocations.$inferSelect) => row.component === "interest")
            .reduce((sum: Decimal, row: typeof floatingTransactionAllocations.$inferSelect) => sum.plus(row.amount), new Decimal(0));
        const baselinePaid = Decimal.max(baseInterest.minus(currentInterest).minus(interestAllocatedThrough), 0);
        const firstPenaltyDate = new Date(`${dueDate}T00:00:00Z`);
        firstPenaltyDate.setUTCDate(firstPenaltyDate.getUTCDate() + graceDays + 1);
        const eligibleStart = firstPenaltyDate.toISOString().slice(0, 10);
        let fixedAssessmentProjected = false;
        if (eligibleStart <= throughDate) {
            for (const penaltyDate of datesBetweenInclusive(eligibleStart, throughDate)) {
                const paidBeforeDate = allocations
                    .filter((row: typeof floatingTransactionAllocations.$inferSelect) =>
                        row.dueDate === dueDate && row.component === "interest" && row.effectiveDate < penaltyDate)
                    .reduce((sum: Decimal, row: typeof floatingTransactionAllocations.$inferSelect) => sum.plus(row.amount), new Decimal(0));
                const openingInterestBasis = Decimal.max(baseInterest.minus(baselinePaid).minus(paidBeforeDate), 0);
                if (openingInterestBasis.lte(0)) continue;
                if (!fixedAssessmentProjected && (loan.lateFeeMode === "fixed" || loan.lateFeeMode === "fixed_plus_percent") && feeValue.gt(0)) {
                    assessments.push({ dueDate, penaltyDate, entryType: "fixed_assessment", amount: feeValue.toDecimalPlaces(2, Decimal.ROUND_HALF_UP), openingInterestBasis });
                    fixedAssessmentProjected = true;
                }
                if ((loan.lateFeeMode === "daily_percent" || loan.lateFeeMode === "fixed_plus_percent") && feeValue.gt(0)) {
                    assessments.push({
                        dueDate,
                        penaltyDate,
                        entryType: "daily_percent_accrual",
                        amount: openingInterestBasis.times(feeValue).div(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP),
                        openingInterestBasis,
                    });
                }
            }
        }
        const ledgerForGroupThrough = ledger.filter((entry: typeof floatingPenaltyLedgerEntries.$inferSelect) =>
            entry.dueDate === dueDate && entry.penaltyDate <= throughDate);
        const expectedForGroup = assessments.filter((entry) =>
            entry.dueDate === dueDate && (!loanCutoverDate || entry.penaltyDate > loanCutoverDate));
        effectiveAssessments.push(...expectedForGroup);
        const baseEntries = ledgerForGroupThrough.filter((entry: typeof floatingPenaltyLedgerEntries.$inferSelect) =>
            entry.entryType !== "adjustment" && entry.entryType !== "legacy_cutover");
        let accruedPenalty = new Decimal(0);
        for (const expected of expectedForGroup) {
            const base = baseEntries.find((entry: typeof floatingPenaltyLedgerEntries.$inferSelect) =>
                entry.penaltyDate === expected.penaltyDate && entry.entryType === expected.entryType);
            if (!base) {
                accruedPenalty = accruedPenalty.plus(expected.amount);
                continue;
            }
            accruedPenalty = accruedPenalty.plus(ledgerForGroupThrough
                .filter((entry: typeof floatingPenaltyLedgerEntries.$inferSelect) => entry.id === base.id || entry.adjustsEntryId === base.id)
                .reduce((sum: Decimal, entry: typeof floatingPenaltyLedgerEntries.$inferSelect) => sum.plus(entry.amount), new Decimal(0)));
        }
        for (const base of baseEntries) {
            const hasExpected = expectedForGroup.some((entry) =>
                entry.penaltyDate === base.penaltyDate && entry.entryType === base.entryType);
            if (hasExpected) continue;
            accruedPenalty = accruedPenalty.plus(ledgerForGroupThrough
                .filter((entry: typeof floatingPenaltyLedgerEntries.$inferSelect) => entry.id === base.id || entry.adjustsEntryId === base.id)
                .reduce((sum: Decimal, entry: typeof floatingPenaltyLedgerEntries.$inferSelect) => sum.plus(entry.amount), new Decimal(0)));
        }
        const paidPenalty = currentGroupAllocations
            .filter((row: typeof floatingTransactionAllocations.$inferSelect) => row.component === "penalty")
            .reduce((sum: Decimal, row: typeof floatingTransactionAllocations.$inferSelect) => sum.plus(row.amount), new Decimal(0));
        groups.push({ dueDate, accruedPenalty, paidPenalty, penaltyDue: Decimal.max(accruedPenalty.minus(paidPenalty), 0), interestDue: currentInterest });
    }
    return { groups, assessments: effectiveAssessments };
}

export async function floatingPaymentObligations(
    tx: Executor,
    loan: typeof loans.$inferSelect,
    through: Date,
    actorUserId: number | null,
) {
    const throughDate = bangkokDate(through);
    const rows = await projectFloatingAccrualRows(tx, loan, throughDate);
    assertFloatingAccrualHistory(rows, loan, throughDate);
    const projectedPenalty = await projectFloatingPenaltyGroups(tx, loan, rows, throughDate);
    const penaltyGroups = projectedPenalty.groups;
    const dueInterest = rows
        .filter((row) => ["accrued", "due", "partially_paid"].includes(row.status) && (row.periodEndDate ?? row.accrualDate) <= throughDate)
        .reduce((total, row) => total.plus(Decimal.max(new Decimal(row.interestAmount).minus(row.paidAmount), 0)), new Decimal(0));
    const duePenalty = penaltyGroups.reduce((total, group) => total.plus(group.penaltyDue), new Decimal(0));
    return { rows, dueInterest, duePenalty, penaltyGroups, penaltyAssessments: projectedPenalty.assessments };
}

export async function materializeFloatingPenaltyAssessments(
    tx: Executor,
    ctx: CommandContext,
    loan: typeof loans.$inferSelect,
    through: Date,
    auditPublicId: string,
    sourceTransactionId: number,
) {
    if (!ctx.idempotencyKey) throw new DomainError("IDEMPOTENCY_KEY_REQUIRED", "Penalty materialization requires an idempotency key", 400);
    const obligations = await floatingPaymentObligations(tx, loan, through, ctx.actorUserId);
    const existing = await tx.select().from(floatingPenaltyLedgerEntries).where(and(
        eq(floatingPenaltyLedgerEntries.tenantId, ctx.tenantId),
        eq(floatingPenaltyLedgerEntries.loanId, loan.id),
    ));
    const keys = new Set(existing.filter((row: typeof floatingPenaltyLedgerEntries.$inferSelect) => row.entryType !== "adjustment")
        .map((row: typeof floatingPenaltyLedgerEntries.$inferSelect) => `${row.dueDate}:${row.penaltyDate}:${row.entryType}`));
    const missing = obligations.penaltyAssessments.filter((entry) => !keys.has(`${entry.dueDate}:${entry.penaltyDate}:${entry.entryType}`) && entry.amount.gt(0));
    if (missing.length) {
        await tx.insert(floatingPenaltyLedgerEntries).values(missing.map((entry) => ({
            tenantId: ctx.tenantId,
            loanId: loan.id,
            dueDate: entry.dueDate,
            penaltyDate: entry.penaltyDate,
            entryType: entry.entryType,
            amount: entry.amount.toFixed(2),
            openingInterestBasis: entry.openingInterestBasis.toFixed(2),
            lateFeeMode: loan.lateFeeMode ?? "none",
            lateFeeValue: new Decimal(loan.lateFeeAmount ?? 0).toFixed(2),
            gracePeriodDays: Math.max(0, loan.gracePeriodDays ?? 0),
            sourceTransactionId,
            idempotencyKey: `floating-penalty:${loan.publicId}:${entry.dueDate}:${entry.penaltyDate}:${entry.entryType}`,
            auditPublicId,
            actorSource: ctx.actorSource,
            requestId: ctx.requestId,
            correlationId: ctx.correlationId,
            createdByUserId: ctx.actorUserId,
        }))).onConflictDoNothing();
    }
    return floatingPaymentObligations(tx, loan, through, ctx.actorUserId);
}

export async function reconcileFloatingPenaltyLedgerAfterInterestAllocation(
    tx: Executor,
    ctx: CommandContext,
    loan: typeof loans.$inferSelect,
    effectiveDate: string,
    sourceTransaction: Pick<typeof transactions.$inferSelect, "id" | "publicId">,
    input: { includeEffectiveDate?: boolean } = {},
) {
    if (!ctx.idempotencyKey) throw new DomainError("IDEMPOTENCY_KEY_REQUIRED", "Penalty reconciliation requires an idempotency key", 400);
    const ledger = await tx.select().from(floatingPenaltyLedgerEntries).where(and(
        eq(floatingPenaltyLedgerEntries.tenantId, ctx.tenantId),
        eq(floatingPenaltyLedgerEntries.loanId, loan.id),
    ));
    const futureBases = ledger.filter((entry: typeof floatingPenaltyLedgerEntries.$inferSelect) =>
        entry.entryType !== "adjustment" && entry.entryType !== "legacy_snapshot" && entry.entryType !== "legacy_cutover"
        && (input.includeEffectiveDate ? entry.penaltyDate >= effectiveDate : entry.penaltyDate > effectiveDate));
    if (!futureBases.length) return [];

    const throughDate = futureBases.reduce((latest: string, entry: typeof floatingPenaltyLedgerEntries.$inferSelect) =>
        entry.penaltyDate > latest ? entry.penaltyDate : latest, effectiveDate);
    const projectedRows = await projectFloatingAccrualRows(tx, loan, throughDate);
    const projected = await projectFloatingPenaltyGroups(tx, loan, projectedRows, throughDate);
    const allTimePaidPenaltyByDueDate = new Map<string, Decimal>();
    const allPenaltyAllocations = await tx.select().from(floatingTransactionAllocations).where(and(
        eq(floatingTransactionAllocations.tenantId, ctx.tenantId),
        eq(floatingTransactionAllocations.loanId, loan.id),
        eq(floatingTransactionAllocations.component, "penalty"),
    ));
    for (const allocation of allPenaltyAllocations as Array<typeof floatingTransactionAllocations.$inferSelect>) {
        allTimePaidPenaltyByDueDate.set(
            allocation.dueDate,
            (allTimePaidPenaltyByDueDate.get(allocation.dueDate) ?? new Decimal(0)).plus(allocation.amount),
        );
    }
    const expectedByKey = new Map(projected.assessments.map((entry) => [
        `${entry.dueDate}:${entry.penaltyDate}:${entry.entryType}`,
        entry,
    ]));
    const adjustments: Array<{
        base: typeof floatingPenaltyLedgerEntries.$inferSelect;
        expected: ProjectedPenaltyAssessment | undefined;
        delta: Decimal;
    }> = futureBases.flatMap((base: typeof floatingPenaltyLedgerEntries.$inferSelect) => {
        const current = ledger
            .filter((entry: typeof floatingPenaltyLedgerEntries.$inferSelect) => entry.id === base.id || entry.adjustsEntryId === base.id)
            .reduce((sum: Decimal, entry: typeof floatingPenaltyLedgerEntries.$inferSelect) => sum.plus(entry.amount), new Decimal(0));
        const expected = expectedByKey.get(`${base.dueDate}:${base.penaltyDate}:${base.entryType}`);
        const expectedAmount = expected?.amount ?? new Decimal(0);
        const delta = expectedAmount.minus(current).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
        return delta.eq(0) ? [] : [{ base, expected, delta }];
    });
    const plannedDeltaByDueDate = new Map<string, Decimal>();
    for (const adjustment of adjustments) {
        plannedDeltaByDueDate.set(
            adjustment.base.dueDate,
            (plannedDeltaByDueDate.get(adjustment.base.dueDate) ?? new Decimal(0)).plus(adjustment.delta),
        );
    }
    for (const [dueDate, plannedDelta] of plannedDeltaByDueDate) {
        if (plannedDelta.gte(0)) continue;
        const group = projected.groups.find((candidate) => candidate.dueDate === dueDate);
        const paidFloor = allTimePaidPenaltyByDueDate.get(dueDate) ?? group?.paidPenalty ?? new Decimal(0);
        if (group && group.accruedPenalty.plus(plannedDelta).lt(paidFloor)) {
            throw new DomainError(
                "FLOATING_PENALTY_COMPENSATION_EXCEEDS_UNPAID",
                "Penalty compensation would reduce assessed penalty below the amount already paid",
                409,
                { loanPublicId: loan.publicId, dueDate },
            );
        }
    }
    if (!adjustments.length) return [];

    const audit = await createAuditLog(tx, {
        tenantId: ctx.tenantId,
        actorUserId: ctx.actorUserId,
        actorSource: ctx.actorSource,
        requestId: ctx.requestId,
        correlationId: ctx.correlationId,
        entityType: "transaction",
        entityId: sourceTransaction.publicId,
        action: "floating_penalty_ledger_compensated",
        payload: {
            loanPublicId: loan.publicId,
            sourceTransactionPublicId: sourceTransaction.publicId,
            effectiveDate,
            adjustments: adjustments.map(({ base, expected, delta }) => ({
                adjustedEntryPublicId: base.publicId,
                dueDate: base.dueDate,
                penaltyDate: base.penaltyDate,
                amount: delta.toFixed(2),
                openingInterestBasis: (expected?.openingInterestBasis ?? new Decimal(0)).toFixed(2),
            })),
        },
    });
    return tx.insert(floatingPenaltyLedgerEntries).values(adjustments.map(({ base, expected, delta }) => ({
        tenantId: ctx.tenantId,
        loanId: loan.id,
        dueDate: base.dueDate,
        penaltyDate: base.penaltyDate,
        entryType: "adjustment",
        amount: delta.toFixed(2),
        openingInterestBasis: (expected?.openingInterestBasis ?? new Decimal(0)).toFixed(2),
        lateFeeMode: base.lateFeeMode,
        lateFeeValue: base.lateFeeValue,
        gracePeriodDays: base.gracePeriodDays,
        adjustsEntryId: base.id,
        sourceTransactionId: sourceTransaction.id,
        reason: "Backdated interest allocation changed a later daily penalty basis",
        idempotencyKey: `floating-penalty-adjustment:${sourceTransaction.publicId}:${base.publicId}:${input.includeEffectiveDate ? "inclusive" : "future"}`,
        auditPublicId: audit.publicId,
        actorSource: ctx.actorSource,
        requestId: ctx.requestId,
        correlationId: ctx.correlationId,
        createdByUserId: ctx.actorUserId,
    }))).onConflictDoNothing().returning();
}

export async function floatingInterestDue(tx: Executor, loan: typeof loans.$inferSelect, through: Date, actorUserId: number | null) {
    return (await floatingPaymentObligations(tx, loan, through, actorUserId)).dueInterest;
}

export async function floatingInterestBalances(tx: Executor, loan: typeof loans.$inferSelect, through: Date, actorUserId: number | null) {
    const obligations = await floatingPaymentObligations(tx, loan, through, actorUserId);
    let accruingInterest = new Decimal(0);
    for (const row of obligations.rows) {
        if (row.status !== "accruing") continue;
        accruingInterest = accruingInterest.plus(Decimal.max(new Decimal(row.interestAmount).minus(row.paidAmount), 0));
    }
    return {
        rows: obligations.rows,
        dueInterest: obligations.dueInterest,
        accruingInterest,
        applicablePenalty: obligations.duePenalty,
        penaltyGroups: obligations.penaltyGroups,
    };
}

export async function correctFloatingInterestAccruals(ctx: CommandContext, loanPublicId: string, dates: string[], reason: string) {
    if (!ctx.idempotencyKey) throw new DomainError("IDEMPOTENCY_KEY_REQUIRED", "Accrual correction requires an idempotency key", 400);
    const cleanReason = reason.trim();
    if (!cleanReason) throw new DomainError("CORRECTION_REASON_REQUIRED", "Accrual correction requires a reason", 400);
    const uniqueDates = [...new Set(dates)].sort();
    if (!uniqueDates.length) throw new DomainError("CORRECTION_DATES_REQUIRED", "Select at least one accrual date", 400);
    return db.transaction(async (tx) => {
        const prior = await tx.query.loanAdjustments.findFirst({ where: and(eq(loanAdjustments.tenantId, ctx.tenantId), eq(loanAdjustments.idempotencyKey, ctx.idempotencyKey!)) });
        if (prior) return { adjustmentPublicId: prior.publicId, correctedDates: uniqueDates, amount: new Decimal(prior.amount).toFixed(2) };
        const loan = await tx.query.loans.findFirst({ where: and(eq(loans.tenantId, ctx.tenantId), eq(loans.publicId, loanPublicId)) });
        if (!loan || loan.repaymentType !== "floating") throw new DomainError("FLOATING_LOAN_NOT_FOUND", "Floating loan not found", 404);
        await tx.execute(sql`SELECT id FROM loans WHERE tenant_id = ${ctx.tenantId} AND id = ${loan.id} FOR UPDATE`);
        if (!loan.interestStartDate || !loan.firstDayTreatment) {
            throw new DomainError("INVALID_LOAN_TERMS", "Floating interest policy is invalid", 409);
        }
        const firstDayTreatment = loan.firstDayTreatment as FloatingDailyInterest["firstDayTreatment"];
        const accrualCycle = (loan.floatingAccrualCycle ?? "daily") as FloatingAccrualCycle;
        for (const accrualDate of uniqueDates) {
            let scheduled = false;
            try {
                scheduled = interestDatesThrough(
                    loan.interestStartDate,
                    accrualDate,
                    firstDayTreatment,
                    accrualCycle,
                ).includes(accrualDate);
            } catch {
                scheduled = false;
            }
            if (!scheduled) {
                throw new DomainError(
                    "ACCRUAL_DATE_NOT_SCHEDULED",
                    "Floating accrual date is outside the loan's accrual cycle",
                    409,
                    { accrualDate },
                );
            }
        }
        const oldRows = await tx.select().from(loanInterestAccruals).where(and(
            eq(loanInterestAccruals.tenantId, ctx.tenantId), eq(loanInterestAccruals.loanId, loan.id),
            inArray(loanInterestAccruals.accrualDate, uniqueDates), sql`${loanInterestAccruals.status} <> 'reversed'`,
        )).orderBy(asc(loanInterestAccruals.accrualDate));
        if (oldRows.length !== uniqueDates.length) throw new DomainError("ACCRUAL_CORRECTION_TARGET_MISMATCH", "Every correction date must identify one active accrual", 409);
        const allocatedTargets = oldRows.length ? await tx.select({
            interestAccrualId: floatingTransactionAllocations.interestAccrualId,
        }).from(floatingTransactionAllocations).where(and(
            eq(floatingTransactionAllocations.tenantId, ctx.tenantId),
            eq(floatingTransactionAllocations.loanId, loan.id),
            eq(floatingTransactionAllocations.component, "interest"),
            inArray(floatingTransactionAllocations.interestAccrualId, oldRows.map((row) => row.id)),
        )) : [];
        if (allocatedTargets.length) {
            throw new DomainError(
                "ACCRUAL_CORRECTION_HAS_ALLOCATIONS",
                "Reverse payments allocated to an accrual before correcting it",
                409,
                { accrualPublicIds: oldRows.filter((row) => allocatedTargets.some((allocation) => allocation.interestAccrualId === row.id)).map((row) => row.publicId) },
            );
        }
        const correctedDueDates = new Set(oldRows.map((row) => row.periodEndDate ?? row.accrualDate));
        const dependentPenaltyHistory = await tx.select({
            dueDate: floatingPenaltyLedgerEntries.dueDate,
            entryType: floatingPenaltyLedgerEntries.entryType,
        }).from(floatingPenaltyLedgerEntries).where(and(
            eq(floatingPenaltyLedgerEntries.tenantId, ctx.tenantId),
            eq(floatingPenaltyLedgerEntries.loanId, loan.id),
            inArray(floatingPenaltyLedgerEntries.dueDate, [...correctedDueDates]),
        ));
        if (dependentPenaltyHistory.some((entry) => entry.entryType !== "legacy_cutover"
            && entry.dueDate && correctedDueDates.has(entry.dueDate))) {
            throw new DomainError(
                "ACCRUAL_CORRECTION_HAS_PENALTY_HISTORY",
                "Accruals with immutable penalty history require a compensating financial workflow",
                409,
                { dueDates: [...correctedDueDates] },
            );
        }
        const periodRows = await tx.select().from(loanInterestRatePeriods).where(and(eq(loanInterestRatePeriods.tenantId, ctx.tenantId), eq(loanInterestRatePeriods.loanId, loan.id))).orderBy(asc(loanInterestRatePeriods.effectiveDate));
        const periodValues: RatePeriodValue[] = periodRows.map((row) => ({ publicId: row.publicId, effectiveDate: row.effectiveDate, expiryDate: row.expiryDate, rateType: row.rateType as RateType, rate: row.rate }));
        const allTransactions = await tx.select().from(transactions).where(and(eq(transactions.tenantId, ctx.tenantId), eq(transactions.loanId, loan.id)));
        const weeklyExpected = accrualCycle === "weekly"
            ? new Map((await weeklyExpectedAccruals(tx, loan, uniqueDates.at(-1)!)).map((row) => [row.accrualDate, row]))
            : null;
        let delta = new Decimal(0);
        const replacements = [] as Array<typeof loanInterestAccruals.$inferSelect>;
        for (const old of oldRows) {
            const weekly = weeklyExpected?.get(old.accrualDate);
            if (accrualCycle === "weekly" && !weekly) {
                throw new DomainError("ACCRUAL_DATE_NOT_SCHEDULED", "Floating accrual date is outside the loan's accrual cycle", 409, { accrualDate: old.accrualDate });
            }
            const periodValue = resolveRatePeriod(periodValues, old.accrualDate);
            const period = periodRows.find((row) => row.publicId === periodValue?.publicId);
            if (!periodValue || !period) throw new DomainError("RATE_PERIOD_MISSING_COVERAGE", "Floating loan has no interest rate for a correction date", 409, { accrualDate: old.accrualDate });
            const principalAppliedBefore = allTransactions
                .filter((row) => row.postedAt && row.transactionDate && bangkokDate(row.transactionDate) < old.accrualDate)
                .reduce((sum, row) => sum.plus(row.principalComponent), new Decimal(0));
            const openingPrincipal = weekly
                ? new Decimal(weekly.openingPrincipal)
                : Decimal.max(0, new Decimal(loan.principalAmount).minus(principalAppliedBefore));
            const policy: FloatingDailyInterestInput = {
                mode: periodValue.rateType,
                rate: periodValue.rate,
                firstDayTreatment,
                accrualCycle,
            };
            const interestAmount = weekly?.interestAmount ?? calculateDailyInterest(openingPrincipal.toFixed(2), policy);
            const paidAmount = weekly?.status === "paid" || (old.accrualDate === loan.interestStartDate && loan.firstDayTreatment === "deduct")
                ? interestAmount
                : Decimal.min(new Decimal(old.paidAmount), new Decimal(interestAmount)).toFixed(2);
            await tx.update(loanInterestAccruals).set({ status: "reversed" }).where(and(eq(loanInterestAccruals.tenantId, ctx.tenantId), eq(loanInterestAccruals.id, old.id)));
            const replacement = await tx.insert(loanInterestAccruals).values({
                tenantId: ctx.tenantId, loanId: loan.id, interestRatePeriodId: period.id, accrualDate: old.accrualDate,
                openingPrincipal: openingPrincipal.toFixed(2), rateMode: periodValue.rateType, rate: periodValue.rate,
                periodStartDate: weekly?.periodStartDate ?? null,
                periodEndDate: weekly?.periodEndDate ?? null,
                periodDayIndex: weekly?.periodDayIndex ?? null,
                periodDays: weekly?.periodDays ?? null,
                cumulativeInterestAmount: weekly?.cumulativeInterestAmount ?? null,
                interestAmount, paidAmount,
                accruedPenalty: old.accruedPenalty,
                paidPenalty: old.paidPenalty,
                status: new Decimal(paidAmount).eq(interestAmount) ? "paid" : weekly?.status ?? "accrued",
                reversedAccrualId: old.id, createdByUserId: ctx.actorUserId,
            }).returning().then((rows) => rows[0]!);
            replacements.push(replacement);
            delta = delta.plus(new Decimal(interestAmount).minus(old.interestAmount));
        }
        const active = await tx.select().from(loanInterestAccruals).where(and(eq(loanInterestAccruals.tenantId, ctx.tenantId), eq(loanInterestAccruals.loanId, loan.id), sql`${loanInterestAccruals.status} <> 'reversed'`));
        const outstandingInterest = active
            .filter((row) => row.status !== "accruing" && row.status !== "paid")
            .reduce((sum, row) => sum.plus(new Decimal(row.interestAmount).minus(row.paidAmount)), new Decimal(0));
        await tx.update(loans).set({ outstandingInterest: outstandingInterest.toFixed(2), updatedAt: new Date() }).where(and(eq(loans.tenantId, ctx.tenantId), eq(loans.id, loan.id)));
        const adjustment = await tx.insert(loanAdjustments).values({
            tenantId: ctx.tenantId, loanId: loan.id, adjustmentType: "floating_interest_accrual_correction", amount: delta.toFixed(2),
            idempotencyKey: ctx.idempotencyKey, reason: cleanReason, createdByUserId: ctx.actorUserId, updatedByUserId: ctx.actorUserId,
        }).returning().then((rows) => rows[0]!);
        await createAuditLog(tx, {
            tenantId: ctx.tenantId, actorUserId: ctx.actorUserId, actorSource: ctx.actorSource, requestId: ctx.requestId, correlationId: ctx.correlationId,
            entityType: "loan", entityId: loan.publicId, action: "floating_interest_accruals_corrected",
            payload: { adjustmentPublicId: adjustment.publicId, reason: cleanReason, corrected: replacements.map((row) => ({ accrualDate: row.accrualDate, accrualPublicId: row.publicId, openingPrincipal: new Decimal(row.openingPrincipal).toFixed(2), interestAmount: new Decimal(row.interestAmount).toFixed(2), paidAmount: new Decimal(row.paidAmount).toFixed(2) })) },
        });
        return { adjustmentPublicId: adjustment.publicId, correctedDates: uniqueDates, amount: delta.toFixed(2) };
    });
}
