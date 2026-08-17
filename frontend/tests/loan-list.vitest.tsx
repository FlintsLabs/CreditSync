import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
            { id: "daily", publicId: "daily", borrowerName: "Daily", principal: "5000.00", outstandingPrincipal: "3750.00", interestReceived: "0.00", paidToDate: "0.00", status: "active", repaymentType: "daily", installmentAmount: "250.00", totalInstallments: 12, startDate: "2026-08-01", createdAt: "2026-08-10T07:30:00.000Z", paymentHealth: { status: "current", dueTodayAmount: "0.00", overdueAmount: "0.00", overdueItemCount: 0, maxOverdueDays: 0 } },
            { id: "floating", publicId: "floating", borrowerName: "Floating", principal: "900.00", outstandingPrincipal: "900.00", interestReceived: "0.00", paidToDate: "0.00", status: "draft", repaymentType: "floating", installmentAmount: null, totalInstallments: null, startDate: null, createdAt: "2026-08-10T07:30:00.000Z", paymentHealth: { status: "current", dueTodayAmount: "0.00", overdueAmount: "0.00", overdueItemCount: 0, maxOverdueDays: 0 } },
        ] });

        render(<MemoryRouter><LoanList /></MemoryRouter>);

        const dailyCard = (await screen.findByText("Daily")).closest("a")!;
        expect(within(dailyCard).getByText(/Interest received.*THB\s*0\.00.*Paid to date.*THB\s*0\.00/)).toBeInTheDocument();
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

    test("renders status-aware exact financial summaries without extra requests", async () => {
        const active = {
            id: "active-summary", publicId: "active-summary", borrowerName: "Active Summary",
            principal: "5000.00", outstandingPrincipal: "3750.00",
            interestReceived: "200.25", paidToDate: "1450.25",
            status: "active", repaymentType: "daily", installmentAmount: "250.00",
            totalInstallments: 20, startDate: "2026-08-01",
            createdAt: "2026-08-10T07:30:00.000Z",
            paymentHealth: { status: "current", dueTodayAmount: "0.00", overdueAmount: "0.00", overdueItemCount: 0, maxOverdueDays: 0 },
        };
        const paid = {
            ...active,
            id: "paid-summary", publicId: "paid-summary", borrowerName: "Paid Summary",
            principal: "10000.00", outstandingPrincipal: "0.00",
            interestReceived: "2000.00", paidToDate: "12000.00", status: "paid",
        };
        vi.mocked(api.get).mockResolvedValue({ data: [active, paid] });

        render(<MemoryRouter><LoanList /></MemoryRouter>);

        const activeCard = (await screen.findByText("Active Summary")).closest("a")!;
        const activeOutstanding = within(activeCard).getByText(/THB\s*3,750\.00/);
        expect(within(activeOutstanding.parentElement!).getByText(/Original principal.*THB\s*5,000\.00/)).toBeInTheDocument();
        expect(within(activeCard).getByText(/Interest received.*THB\s*200\.25.*Paid to date.*THB\s*1,450\.25/)).toBeInTheDocument();

        expect(screen.queryByText("Paid Summary")).not.toBeInTheDocument();
        await userEvent.click(screen.getByRole("tab", { name: "Done" }));
        const paidCard = await screen.findByText("Paid Summary").then((node) => node.closest("a")!);
        const paidStatus = within(paidCard).getByText("PAID");
        expect(paidStatus.parentElement?.querySelector("svg.lucide-circle-check")).not.toBeNull();
        expect(within(paidCard).queryByText(/THB\s*0\.00/)).not.toBeInTheDocument();
        expect(within(paidCard).getByText(/Original principal.*THB\s*10,000\.00.*Interest received.*THB\s*2,000\.00/)).toBeInTheDocument();
        expect(within(paidCard).queryByText(/Paid to date/)).not.toBeInTheDocument();
        await userEvent.click(screen.getByRole("tab", { name: "All" }));
        expect(screen.getByText("Active Summary")).toBeInTheDocument();
        expect(screen.getByText("Paid Summary")).toBeInTheDocument();
        expect(screen.getByRole("option", { name: "Closed" })).toBeInTheDocument();
        expect(vi.mocked(api.get).mock.calls.map(([url]) => url)).toEqual(["/loans"]);
    });

    test("shows replaced only in Done and All without the paid treatment", async () => {
        vi.mocked(api.get).mockResolvedValue({ data: [{
            id: "replaced-summary", publicId: "replaced-summary", borrowerName: "Replaced Summary",
            principal: "36000.00", outstandingPrincipal: "0.00", interestReceived: "0.00", paidToDate: "0.00",
            status: "replaced", repaymentType: "daily", installmentAmount: "300.00", totalInstallments: 200,
            startDate: "2026-07-12", createdAt: "2026-08-10T07:30:00.000Z",
            paymentHealth: { status: "current", dueTodayAmount: "0.00", overdueAmount: "0.00", overdueItemCount: 0, maxOverdueDays: 0 },
        }] });

        render(<MemoryRouter><LoanList /></MemoryRouter>);

        expect(await screen.findByText("No Active Loans")).toBeInTheDocument();
        expect(screen.queryByText("Replaced Summary")).not.toBeInTheDocument();
        await userEvent.click(screen.getByRole("tab", { name: "Done" }));
        const doneCard = (await screen.findByText("Replaced Summary")).closest("a")!;
        expect(within(doneCard).getByText("Closed — Replaced")).toBeInTheDocument();
        expect(within(doneCard).queryByText("PAID")).not.toBeInTheDocument();
        expect(doneCard.querySelector("svg.lucide-circle-check")).toBeNull();
        await userEvent.click(screen.getByRole("tab", { name: "All" }));
        expect(screen.getByText("Replaced Summary")).toBeInTheDocument();
    });

    // Break caught: payment health is invisible, imprecisely formatted, or replaces lifecycle status/navigation.
    test("shows accessible overdue and due-now indicators without extra requests", async () => {
        vi.mocked(api.get).mockResolvedValue({ data: [
            { id: "scheduled-overdue", publicId: "scheduled-overdue", borrowerName: "Scheduled Overdue", principal: "9007199254740993.01", outstandingPrincipal: "9007199254740993.01", interestReceived: "0.00", paidToDate: "0.00", status: "active", repaymentType: "daily", installmentAmount: "500.00", totalInstallments: 20, startDate: "2026-08-01", createdAt: "2026-08-10T07:30:00.000Z", paymentHealth: { status: "overdue", dueTodayAmount: "0.00", overdueAmount: "9007199254740993.01", overdueItemCount: 2, maxOverdueDays: 3 } },
            { id: "floating-overdue", publicId: "floating-overdue", borrowerName: "Floating Overdue", principal: "1000.00", outstandingPrincipal: "1000.00", interestReceived: "0.00", paidToDate: "0.00", status: "active", repaymentType: "floating", installmentAmount: null, totalInstallments: null, startDate: "2026-08-01", createdAt: "2026-08-10T07:30:00.000Z", paymentHealth: { status: "overdue", dueTodayAmount: "15.00", overdueAmount: "45.00", overdueItemCount: 3, maxOverdueDays: 3 } },
            { id: "due-now", publicId: "due-now", borrowerName: "Due Now", principal: "500.00", outstandingPrincipal: "500.00", interestReceived: "0.00", paidToDate: "0.00", status: "active", repaymentType: "daily", installmentAmount: "50.00", totalInstallments: 10, startDate: "2026-08-11", createdAt: "2026-08-10T07:30:00.000Z", paymentHealth: { status: "due_today", dueTodayAmount: "50.00", overdueAmount: "0.00", overdueItemCount: 0, maxOverdueDays: 0 } },
            { id: "current", publicId: "current", borrowerName: "Current Loan", principal: "400.00", outstandingPrincipal: "400.00", interestReceived: "0.00", paidToDate: "0.00", status: "active", repaymentType: "daily", installmentAmount: "40.00", totalInstallments: 10, startDate: "2026-08-12", createdAt: "2026-08-10T07:30:00.000Z", paymentHealth: { status: "current", dueTodayAmount: "0.00", overdueAmount: "0.00", overdueItemCount: 0, maxOverdueDays: 0 } },
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
            { id: "floating-th", publicId: "floating-th", borrowerName: "ลูกค้ารายวัน", principal: "1000.00", outstandingPrincipal: "800.00", interestReceived: "50.25", paidToDate: "250.25", status: "active", repaymentType: "floating", installmentAmount: null, totalInstallments: null, startDate: "2026-08-01", createdAt: "2026-08-10T07:30:00.000Z", paymentHealth: { status: "overdue", dueTodayAmount: "15.00", overdueAmount: "45.00", overdueItemCount: 3, maxOverdueDays: 3 } },
            { id: "paid-th", publicId: "paid-th", borrowerName: "ลูกค้าปิดบัญชี", principal: "2000.00", outstandingPrincipal: "0.00", interestReceived: "300.00", paidToDate: "2300.00", status: "paid", repaymentType: "daily", installmentAmount: "200.00", totalInstallments: 10, startDate: "2026-08-01", createdAt: "2026-08-10T07:30:00.000Z", paymentHealth: { status: "current", dueTodayAmount: "0.00", overdueAmount: "0.00", overdueItemCount: 0, maxOverdueDays: 0 } },
        ] });

        render(<MemoryRouter><LoanList /></MemoryRouter>);

        expect(await screen.findByText("ค้างชำระ 3 วัน")).toBeInTheDocument();
        expect(screen.getByText(/ค้างสูงสุด 3 วัน/)).toBeInTheDocument();
        expect(screen.getByText(/ดอกเบี้ยรับแล้ว.*฿50\.25.*จ่ายแล้ว.*฿250\.25/)).toBeInTheDocument();
        await userEvent.click(screen.getByRole("tab", { name: "เสร็จสิ้น" }));
        const paidCard = screen.getByText("ลูกค้าปิดบัญชี").closest("a")!;
        expect(within(paidCard).getByText("PAID")).toBeInTheDocument();
        expect(within(paidCard).getByText(/เงินต้นตั้งต้น.*฿2,000\.00.*ดอกเบี้ยรับแล้ว.*฿300\.00/)).toBeInTheDocument();
        expect(within(paidCard).queryByText(/จ่ายแล้ว/)).not.toBeInTheDocument();
    });

    test("renders borrower labels above overflow and searches aliases and tags", async () => {
        await i18n.changeLanguage("en");
        vi.mocked(api.get).mockResolvedValue({ data: [
            {
                id: "loan-labels",
                publicId: "loan-labels",
                borrowerName: "สมหญิงใจดี",
                borrowerAliases: [" นก ", "VIP", "", "vip"],
                borrowerTags: ["vip", "ตลาดเช้า", "เจ้าประจำ"],
                principal: "5000.00",
                outstandingPrincipal: "4900.00",
                interestReceived: "0.00",
                paidToDate: "0.00",
                status: "active",
                repaymentType: "daily",
                installmentAmount: "250.00",
                totalInstallments: 12,
                startDate: "2026-08-01",
                createdAt: "2026-08-10T07:30:00.000Z",
                paymentHealth: { status: "current", dueTodayAmount: "0.00", overdueAmount: "0.00", overdueItemCount: 0, maxOverdueDays: 0 },
            },
            {
                id: "loan-no-labels",
                publicId: "loan-no-labels",
                borrowerName: "แปะ",
                principal: "1000.00",
                outstandingPrincipal: "900.00",
                interestReceived: "0.00",
                paidToDate: "0.00",
                status: "active",
                repaymentType: "floating",
                installmentAmount: null,
                totalInstallments: null,
                startDate: "2026-08-01",
                createdAt: "2026-08-10T07:30:00.000Z",
                paymentHealth: { status: "current", dueTodayAmount: "0.00", overdueAmount: "0.00", overdueItemCount: 0, maxOverdueDays: 0 },
            },
        ] });

        render(<MemoryRouter><LoanList /></MemoryRouter>);

        const firstLoanCard = await screen.findByText("สมหญิงใจดี");
        const labeledCard = firstLoanCard.closest("a");
        expect(labeledCard).not.toBeNull();
        expect(within(labeledCard!).getByText("นก")).toBeInTheDocument();
        expect(within(labeledCard!).getByText("VIP")).toBeInTheDocument();
        expect(within(labeledCard!).getByText("ตลาดเช้า")).toBeInTheDocument();
        expect(within(labeledCard!).queryByText("เจ้าประจำ")).not.toBeInTheDocument();
        const overflow = within(labeledCard!).getByText("+1");
        expect(overflow).toBeInTheDocument();
        expect(overflow).toHaveAttribute("aria-label", "1 more borrower label");

        const searchInput = screen.getByPlaceholderText("Name, nickname, tag, or loan #");
        await userEvent.type(searchInput, "เจ้าประจำ");
        expect(await screen.findByText("สมหญิงใจดี")).toBeInTheDocument();
        expect(screen.queryByText("แปะ")).not.toBeInTheDocument();
    });

    test("localizes borrower label helper copy in Thai", async () => {
        await i18n.changeLanguage("th");
        vi.mocked(api.get).mockResolvedValue({ data: [
            {
                id: "loan-th-labels",
                publicId: "loan-th-labels",
                borrowerName: "ลูกหนี้",
                borrowerAliases: ["ชื่อเล่น", "สมชาย"],
                borrowerTags: ["แท็ก", "แผง"],
                principal: "1200.00",
                outstandingPrincipal: "1200.00",
                interestReceived: "0.00",
                paidToDate: "0.00",
                status: "active",
                repaymentType: "daily",
                installmentAmount: "100.00",
                totalInstallments: 12,
                startDate: "2026-08-01",
                createdAt: "2026-08-10T07:30:00.000Z",
                paymentHealth: { status: "current", dueTodayAmount: "0.00", overdueAmount: "0.00", overdueItemCount: 0, maxOverdueDays: 0 },
            },
        ] });

        render(<MemoryRouter><LoanList /></MemoryRouter>);

        expect(await screen.findByPlaceholderText("ชื่อ ชื่อเล่น แท็ก หรือเลขสัญญา")).toBeInTheDocument();
        const overflow = await screen.findByText("+1");
        expect(overflow).toHaveAttribute("aria-label", "ป้ายกำกับลูกหนี้เพิ่มเติม 1 รายการ");
        expect(screen.getByText("ลูกหนี้")).toBeInTheDocument();
    });

    test("shows current agents on overdue cards and searches confirmed agent aliases", async () => {
        vi.mocked(api.get).mockResolvedValue({ data: [{
            id: "agent-loan", publicId: "agent-loan", borrowerName: "Borrower A", principal: "1000.00", outstandingPrincipal: "900.00", interestReceived: "20.00", paidToDate: "120.00", status: "active", repaymentType: "daily", installmentAmount: "100.00", totalInstallments: 10, startDate: "2026-08-01", createdAt: "2026-08-10T07:30:00.000Z", paymentHealth: { status: "overdue", dueTodayAmount: "0.00", overdueAmount: "100.00", overdueItemCount: 1, maxOverdueDays: 2 }, currentAgent: { name: "Agent Alpha", aliases: ["พี่เอ"] },
        }] });

        render(<MemoryRouter><LoanList /></MemoryRouter>);

        const card = (await screen.findByText("Borrower A")).closest("a")!;
        expect(within(card).getByText("Agent Alpha")).toBeInTheDocument();
        expect(within(card).getByText("Overdue 1 installment")).toBeInTheDocument();
        await userEvent.type(screen.getByPlaceholderText("Name, nickname, tag, or loan #"), "พี่เอ");
        expect(screen.getByText("Borrower A")).toBeInTheDocument();
        expect(vi.mocked(api.get).mock.calls.map(([url]) => url)).toEqual(["/loans"]);
    });

    test("shows a localized load error instead of the empty state and retries", async () => {
        vi.mocked(api.get)
            .mockRejectedValueOnce(new Error("unavailable"))
            .mockResolvedValueOnce({ data: [{
                id: "retry-loan",
                publicId: "retry-loan",
                borrowerName: "Retry Borrower",
                principal: "1000.00",
                outstandingPrincipal: "1000.00",
                interestReceived: "0.00",
                paidToDate: "0.00",
                status: "active",
                repaymentType: "daily",
                installmentAmount: "100.00",
                totalInstallments: 10,
                startDate: "2026-08-01",
                createdAt: "2026-08-10T07:30:00.000Z",
                paymentHealth: { status: "current", dueTodayAmount: "0.00", overdueAmount: "0.00", overdueItemCount: 0, maxOverdueDays: 0 },
            }] });

        render(<MemoryRouter><LoanList /></MemoryRouter>);

        expect(await screen.findByText("Unable to load loans")).toBeInTheDocument();
        expect(screen.queryByText("No Active Loans")).not.toBeInTheDocument();

        await userEvent.click(screen.getByRole("button", { name: "Try again" }));

        expect(await screen.findByText("Retry Borrower")).toBeInTheDocument();
        expect(screen.queryByText("Unable to load loans")).not.toBeInTheDocument();
        expect(vi.mocked(api.get)).toHaveBeenCalledTimes(2);
    });
});
