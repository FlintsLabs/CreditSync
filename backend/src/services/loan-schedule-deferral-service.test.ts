import { expect, test } from "bun:test";
import { getReplacementScheduleDate, canDeferSchedule } from "./loan-schedule-deferral-service";

test("places a replacement installment on the next calendar day after the schedule tail", () => {
    expect(getReplacementScheduleDate("2026-08-31")).toBe("2026-09-01");
});

test("allows deferral only for a fully unpaid row with a positive balance", () => {
    expect(canDeferSchedule({ paidTotal: "0.00", remainingDue: "200.00", status: "pending" })).toBe(true);
    expect(canDeferSchedule({ paidTotal: "100.00", remainingDue: "100.00", status: "partial" })).toBe(false);
    expect(canDeferSchedule({ paidTotal: "0.00", remainingDue: "0.00", status: "paid" })).toBe(false);
    expect(canDeferSchedule({ paidTotal: "0.00", remainingDue: "200.00", status: "deferred" })).toBe(false);
});
