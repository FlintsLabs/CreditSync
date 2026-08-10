import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, test, vi } from "vitest";
import i18n from "../src/lib/i18n";
import LoanList from "../src/pages/dashboard/loans/LoanList";
import { api } from "../src/lib/api";

vi.mock("../src/lib/api", () => ({ api: { get: vi.fn() } }));

describe("LoanList", () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        await i18n.changeLanguage("en");
    });

    test("shows agreed repayment details and clear dates without funding metric requests", async () => {
        vi.mocked(api.get).mockResolvedValue({ data: [
            { id: "daily", publicId: "daily", borrowerName: "Daily", principal: "5000.00", outstandingPrincipal: "3750.00", status: "active", repaymentType: "daily", installmentAmount: "250.00", totalInstallments: 12, startDate: "2026-08-01", createdAt: "2026-08-10T07:30:00.000Z", paymentHealth: { status: "current", dueTodayAmount: "0.00", overdueAmount: "0.00", overdueItemCount: 0, maxOverdueDays: 0 } },
            { id: "floating", publicId: "floating", borrowerName: "Floating", principal: "900.00", outstandingPrincipal: "900.00", status: "draft", repaymentType: "floating", installmentAmount: null, totalInstallments: null, startDate: null, createdAt: "2026-08-10T07:30:00.000Z", paymentHealth: { status: "current", dueTodayAmount: "0.00", overdueAmount: "0.00", overdueItemCount: 0, maxOverdueDays: 0 } },
        ] });

        render(<MemoryRouter><LoanList /></MemoryRouter>);

        expect(await screen.findByText("Daily")).toBeInTheDocument();
        expect(screen.getByText(/THB\s*3,750\.00/)).toBeInTheDocument();
        expect(screen.getByText(/Original principal.*THB\s*5,000\.00/)).toBeInTheDocument();
        expect(screen.getByText(/250\.00/)).toBeInTheDocument();
        expect(screen.getByText(/12 installments/)).toBeInTheDocument();
        expect(screen.getAllByText("Start date")).toHaveLength(2);
        expect(screen.getAllByText(/^Created at:/)).toHaveLength(2);
        expect(screen.getByText("Floating repayment has no fixed schedule")).toBeInTheDocument();
        expect(screen.getByText("Not set")).toBeInTheDocument();
        expect(vi.mocked(api.get).mock.calls.map(([url]) => url)).toEqual(["/loans"]);
    });

    // Break caught: payment health is invisible, imprecisely formatted, or replaces lifecycle status/navigation.
    test("shows accessible overdue and due-now indicators without extra requests", async () => {
        vi.mocked(api.get).mockResolvedValue({ data: [
            { id: "scheduled-overdue", publicId: "scheduled-overdue", borrowerName: "Scheduled Overdue", principal: "9007199254740993.01", outstandingPrincipal: "9007199254740993.01", status: "active", repaymentType: "daily", installmentAmount: "500.00", totalInstallments: 20, startDate: "2026-08-01", createdAt: "2026-08-10T07:30:00.000Z", paymentHealth: { status: "overdue", dueTodayAmount: "0.00", overdueAmount: "9007199254740993.01", overdueItemCount: 2, maxOverdueDays: 3 } },
            { id: "floating-overdue", publicId: "floating-overdue", borrowerName: "Floating Overdue", principal: "1000.00", outstandingPrincipal: "1000.00", status: "active", repaymentType: "floating", installmentAmount: null, totalInstallments: null, startDate: "2026-08-01", createdAt: "2026-08-10T07:30:00.000Z", paymentHealth: { status: "overdue", dueTodayAmount: "15.00", overdueAmount: "45.00", overdueItemCount: 3, maxOverdueDays: 3 } },
            { id: "due-now", publicId: "due-now", borrowerName: "Due Now", principal: "500.00", outstandingPrincipal: "500.00", status: "active", repaymentType: "daily", installmentAmount: "50.00", totalInstallments: 10, startDate: "2026-08-11", createdAt: "2026-08-10T07:30:00.000Z", paymentHealth: { status: "due_today", dueTodayAmount: "50.00", overdueAmount: "0.00", overdueItemCount: 0, maxOverdueDays: 0 } },
            { id: "current", publicId: "current", borrowerName: "Current Loan", principal: "400.00", outstandingPrincipal: "400.00", status: "active", repaymentType: "daily", installmentAmount: "40.00", totalInstallments: 10, startDate: "2026-08-12", createdAt: "2026-08-10T07:30:00.000Z", paymentHealth: { status: "current", dueTodayAmount: "0.00", overdueAmount: "0.00", overdueItemCount: 0, maxOverdueDays: 0 } },
        ] });

        render(<MemoryRouter><LoanList /></MemoryRouter>);

        const scheduledBadge = await screen.findByText("Overdue 2 installments");
        expect(scheduledBadge.closest("div")).toHaveClass("bg-destructive");
        expect(screen.getByText("Overdue 3 days")).toBeInTheDocument();
        expect(screen.getByText(/THB\s*9,007,199,254,740,993\.01.*up to 3 days overdue/)).toBeInTheDocument();
        expect(screen.getByText(/Due now.*THB\s*50\.00/)).toBeInTheDocument();
        expect(screen.queryByText("Current")).not.toBeInTheDocument();
        expect(screen.getAllByText("active")).toHaveLength(4);
        expect(screen.getByText("Scheduled Overdue").closest("a")).toHaveAttribute("href", "/loans/scheduled-overdue");
        expect(vi.mocked(api.get).mock.calls.map(([url]) => url)).toEqual(["/loans"]);
    });

    // Break caught: Thai floating cards reuse English or installment-specific overdue copy.
    test("localizes floating overdue days in Thai", async () => {
        await i18n.changeLanguage("th");
        vi.mocked(api.get).mockResolvedValue({ data: [
            { id: "floating-th", publicId: "floating-th", borrowerName: "ลูกค้ารายวัน", principal: "1000.00", outstandingPrincipal: "1000.00", status: "active", repaymentType: "floating", installmentAmount: null, totalInstallments: null, startDate: "2026-08-01", createdAt: "2026-08-10T07:30:00.000Z", paymentHealth: { status: "overdue", dueTodayAmount: "15.00", overdueAmount: "45.00", overdueItemCount: 3, maxOverdueDays: 3 } },
        ] });

        render(<MemoryRouter><LoanList /></MemoryRouter>);

        expect(await screen.findByText("ค้างชำระ 3 วัน")).toBeInTheDocument();
        expect(screen.getByText(/ค้างสูงสุด 3 วัน/)).toBeInTheDocument();
    });
});
