import { render, screen, within } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { LoanAccrualsTab, type LoanAccrualRow } from "./LoanAccrualsTab";

vi.mock("react-i18next", () => ({
    useTranslation: () => ({
        t: (_key: string, fallback?: string) => fallback ?? _key,
        i18n: { language: "th-TH" },
    }),
}));

describe("LoanAccrualsTab", () => {
    // Break caught: missing projected rows, double-counted reversals, or incorrect current totals.
    test("renders every daily row and exact totals while preserving reversal history", () => {
        const dates = ["2026-09-24", "2026-09-25", "2026-09-26", "2026-09-27", "2026-09-28", "2026-09-29", "2026-09-30",
            "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07"];
        const rows: LoanAccrualRow[] = dates.map((date, index) => ({
            publicId: index === 0 ? "first-paid-row" : `projected:loan:${date}`,
            accrualDate: date, periodStartDate: date, periodEndDate: null, periodUnit: "day", periodDayIndex: 1,
            interestAmount: "80.00", paidAmount: index === 0 ? "80.00" : "0.00",
            remainingAmount: index === 0 ? "0.00" : "80.00", status: index === 0 ? "paid" : "accrued",
        }));
        rows.push({ ...rows[0], publicId: "reversed-row", interestAmount: "100.00", paidAmount: "0.00", remainingAmount: "100.00", status: "reversed" });
        render(<LoanAccrualsTab rows={rows} />);
        expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(16);
        expect(screen.getByRole("cell", { name: "7 ต.ค. 2569" })).toBeTruthy();
        expect(screen.getByText("total").parentElement?.textContent).toContain("1,120.00");
        const summary = screen.getByText("total").parentElement!.parentElement!;
        expect(within(summary).getByText("paid").parentElement?.textContent).toContain("80.00");
        expect(screen.getByText("remaining").parentElement?.textContent).toContain("1,040.00");
        expect(screen.getByText("reversed")).toBeTruthy();
    });
});
