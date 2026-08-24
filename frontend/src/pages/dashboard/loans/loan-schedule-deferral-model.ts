import Decimal from "decimal.js";

export function canDeferScheduleRow(row: { paidTotal?: string; remainingDue: string; status: string }) {
    return row.status !== "deferred" && new Decimal(row.paidTotal ?? "0.00").isZero() && new Decimal(row.remainingDue).greaterThan(0);
}
