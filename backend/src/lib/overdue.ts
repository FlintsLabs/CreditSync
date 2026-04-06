function startOfDay(value: Date | string) {
    const date = typeof value === "string" ? new Date(value) : new Date(value);
    date.setHours(0, 0, 0, 0);
    return date;
}

function daysBetween(from: Date, to: Date) {
    const diff = startOfDay(to).getTime() - startOfDay(from).getTime();
    return Math.max(0, Math.floor(diff / 86400000));
}

type LateFeeMode = "none" | "fixed" | "daily_percent" | "fixed_plus_percent";

export interface OverdueComputationInput {
    dueDate: string;
    remainingDue: string | number;
    paidPenalty?: string | number | null;
    gracePeriodDays?: number | null;
    lateFeeMode?: string | null;
    lateFeeAmount?: string | number | null;
    baseStatus?: string | null;
    asOf?: Date | string;
}

export function computeOverdueSnapshot(input: OverdueComputationInput) {
    const asOf = input.asOf ? startOfDay(input.asOf) : startOfDay(new Date());
    const dueDate = startOfDay(input.dueDate);
    const remainingDue = Number(input.remainingDue ?? 0);
    const paidPenalty = Number(input.paidPenalty ?? 0);
    const gracePeriodDays = Number(input.gracePeriodDays ?? 0);
    const lateFeeMode = (input.lateFeeMode ?? "none") as LateFeeMode;
    const lateFeeAmount = Number(input.lateFeeAmount ?? 0);

    const overdueDays = remainingDue > 0
        ? Math.max(0, daysBetween(dueDate, asOf) - gracePeriodDays)
        : 0;

    let accruedPenalty = 0;
    if (remainingDue > 0 && overdueDays > 0) {
        if (lateFeeMode === "fixed" || lateFeeMode === "fixed_plus_percent") {
            accruedPenalty += lateFeeAmount;
        }
        if (lateFeeMode === "daily_percent" || lateFeeMode === "fixed_plus_percent") {
            accruedPenalty += remainingDue * (lateFeeAmount / 100) * overdueDays;
        }
    }

    const penaltyDue = Math.max(0, Number(accruedPenalty.toFixed(2)) - paidPenalty);
    const effectiveStatus = remainingDue <= 0 && penaltyDue <= 0
        ? "paid"
        : overdueDays > 0
            ? "overdue"
            : input.baseStatus === "partial"
                ? "partial"
                : "pending";

    return {
        overdueDays,
        accruedPenalty: Number(accruedPenalty.toFixed(2)),
        penaltyDue: Number(penaltyDue.toFixed(2)),
        totalDueNow: Number((remainingDue + penaltyDue).toFixed(2)),
        effectiveStatus,
    };
}
