import { expect, test } from "bun:test";
import { getReplacementScheduleDate, canDeferSchedule, getDeferredLoanRollupUpdate, countLoanScheduleDeferrals } from "./loan-schedule-deferral-service";

test("places a replacement installment on the next calendar day after the schedule tail", () => {
    expect(getReplacementScheduleDate("2026-08-31")).toBe("2026-09-01");
});

test("allows deferral only for a fully unpaid row with a positive balance", () => {
    expect(canDeferSchedule({ paidTotal: "0.00", remainingDue: "200.00", status: "pending" })).toBe(true);
    expect(canDeferSchedule({ paidTotal: "100.00", remainingDue: "100.00", status: "partial" })).toBe(false);
    expect(canDeferSchedule({ paidTotal: "0.00", remainingDue: "0.00", status: "paid" })).toBe(false);
    expect(canDeferSchedule({ paidTotal: "0.00", remainingDue: "200.00", status: "deferred" })).toBe(false);
});

test("does not change the immutable contract installment count during deferral", () => {
    const update = getDeferredLoanRollupUpdate({
        outstandingPrincipal: { toFixed: () => "200.00" } as never,
        outstandingInterest: { toFixed: () => "50.00" } as never,
        outstandingFees: { toFixed: () => "0.00" } as never,
        nextDueDate: "2026-08-27",
        status: "active",
    });

    expect(update).toEqual({
        outstandingPrincipal: "200.00",
        outstandingInterest: "50.00",
        outstandingFees: "0.00",
        nextDueDate: "2026-08-27",
        status: "active",
    });
    expect(update).not.toHaveProperty("totalInstallments");
});

test("counts deferral ledger entries for the schedule summary", () => {
    expect(countLoanScheduleDeferrals([{ id: 1 }, { id: 2 }, { id: 3 }])).toBe(3);
});
