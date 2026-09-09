import { expect, test } from "bun:test";
import { canDeferScheduleRow } from "../src/pages/dashboard/loans/loan-schedule-deferral-model";

test("shows deferral only for a fully unpaid installment", () => {
    expect(canDeferScheduleRow({ paidTotal: "0.00", remainingDue: "200.00", status: "pending" })).toBe(true);
    expect(canDeferScheduleRow({ paidTotal: "100.00", remainingDue: "100.00", status: "partial" })).toBe(false);
    expect(canDeferScheduleRow({ paidTotal: "0.00", remainingDue: "0.00", status: "paid" })).toBe(false);
});
