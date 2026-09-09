import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import DashboardCollectionSummary from "../src/pages/dashboard/DashboardCollectionSummary";
import i18n from "../src/lib/i18n";

describe("Dashboard collection summary", () => {
    it("shows due-today categories and collection responsibility per intermediary without overdue amounts", async () => {
        await i18n.changeLanguage("th");
        render(<DashboardCollectionSummary summary={{
            totalDueToday: "725.00",
            categories: [
                { key: "floating_daily_interest", totalDueToday: "75.00", items: [{ loanPublicId: "loan-float-day", borrowerName: "Floating Daily", dueTodayAmount: "75.00" }] },
                { key: "floating_weekly_interest", totalDueToday: "200.00", items: [{ loanPublicId: "loan-float-week", borrowerName: "Floating Weekly", dueTodayAmount: "200.00" }] },
                { key: "daily_installment", totalDueToday: "120.00", items: [{ loanPublicId: "loan-daily", borrowerName: "Daily Installment", dueTodayAmount: "120.00" }] },
                { key: "weekly_installment", totalDueToday: "140.00", items: [{ loanPublicId: "loan-weekly", borrowerName: "Weekly Installment", dueTodayAmount: "140.00" }] },
                { key: "monthly_installment", totalDueToday: "100.00", items: [{ loanPublicId: "loan-monthly", borrowerName: "Monthly Installment", dueTodayAmount: "100.00" }] },
                { key: "other", totalDueToday: "90.00", items: [{ loanPublicId: "loan-other", borrowerName: "Single Payment", dueTodayAmount: "90.00" }] },
            ],
            intermediaries: [{ intermediaryPublicId: "agent-alice", intermediaryName: "Alice", totalDueToday: "120.00", items: [{ loanPublicId: "loan-daily", borrowerName: "Daily Installment", dueTodayAmount: "120.00" }] }],
        }} />);

        expect(screen.getByRole("heading", { name: "สรุปยอดรับวันนี้แยกประเภท" })).toBeInTheDocument();
        expect(screen.getByText("รวมยอดรับวันนี้")).toBeInTheDocument();
        expect(screen.getByText("฿725.00")).toBeInTheDocument();
        expect(screen.getByText("ยอดลอย — ดอกรายวัน")).toBeInTheDocument();
        expect(screen.getByText("งวดรายเดือน (ต้น+ดอก)")).toBeInTheDocument();
        expect(screen.getByText("ยอดที่คนกลางต้องเก็บวันนี้")).toBeInTheDocument();
        expect(screen.getByText("Alice")).toBeInTheDocument();
        expect(screen.getAllByText("Daily Installment")).toHaveLength(2);
        expect(screen.queryByText("Overdue Only")).not.toBeInTheDocument();
    });
});
