import { describe, expect, test } from "bun:test";
import { computeOverdueSnapshot } from "./overdue";

describe("computeOverdueSnapshot", () => {
    test("labels an unpaid installment due on the Bangkok business date as due", () => {
        expect(computeOverdueSnapshot({
            dueDate: "2026-08-18",
            remainingDue: "100.00",
            asOf: new Date("2026-08-18T00:30:00.000Z"),
            baseStatus: "pending",
        })).toMatchObject({ effectiveStatus: "due", overdueDays: 0 });
    });

    test("keeps a future unpaid installment pending", () => {
        expect(computeOverdueSnapshot({
            dueDate: "2026-08-19",
            remainingDue: "100.00",
            asOf: new Date("2026-08-18T00:30:00.000Z"),
            baseStatus: "pending",
        })).toMatchObject({ effectiveStatus: "pending", overdueDays: 0 });
    });
});
