import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import LoanDetail from "../src/pages/dashboard/loans/LoanDetail";
import { api } from "../src/lib/api";
import appI18n from "../src/lib/i18n";

vi.mock("../src/lib/api", () => ({ api: { get: vi.fn(), post: vi.fn() } }));
vi.mock("../src/lib/session", () => ({ getStoredUser: () => null, isTenantAdminUser: () => false }));
vi.mock("../src/pages/dashboard/loans/LoanRenewalPanel", () => ({ LoanRenewalPanel: () => null }));
vi.mock("../src/pages/dashboard/loans/LoanDisbursements", () => ({ LoanDisbursements: () => null }));
vi.mock("../src/pages/dashboard/loans/LoanRepaymentHistory", () => ({ LoanRepaymentHistory: () => null }));
vi.mock("../src/pages/dashboard/loans/LoanRestructurePanel", () => ({ LoanRestructurePanel: () => <div data-testid="restructure-panel" /> }));

const LOAN_ID = "019ff023-fd64-7d41-9aae-723d2a458a8a";
const BORROWER_ID = "019fea17-6068-7ccb-b267-9f39880bb762";
const schedule = Array.from({ length: 25 }, (_, index) => ({
    id: `schedule-${index + 1}`,
    publicId: `schedule-public-${index + 1}`,
    installmentNo: index + 1,
    dueDate: `2026-07-${String(index + 1).padStart(2, "0")}`,
    scheduledTotal: "200.00",
    remainingDue: index === 1 ? "0.00" : "200.00",
    status: index === 0 ? "overdue" : index === 1 ? "paid" : index === 2 ? "deferred" : "scheduled",
    ...(index === 2 ? { deferralReason: "ลูกหนี้ป่วย", deferredReplacementSchedulePublicId: "schedule-public-26" } : {}),
}));

const loan = {
    id: LOAN_ID,
    publicId: LOAN_ID,
    borrowerPublicId: BORROWER_ID,
    principalAmount: "4000.00",
    interestRate: "0.00",
    repaymentType: "monthly",
    termMonths: 12,
    installmentAmount: "200.00",
    totalInstallments: 12,
    startDate: "2026-07-01",
    nextDueDate: "2026-07-01",
    outstandingPrincipal: "4000.00",
    outstandingInterest: "0.00",
    outstandingFees: "0.00",
    status: "active",
};

function renderLoanDetail(loanData = loan) {
    vi.mocked(api.get).mockImplementation(async (url) => {
        if (url === `/loans/${LOAN_ID}`) return { data: loanData };
        if (url === `/borrowers/${BORROWER_ID}`) return { data: { id: BORROWER_ID, publicId: BORROWER_ID, name: "พี่ฟ้า" } };
        if (url.endsWith("/schedule")) return { data: schedule };
        if (url.endsWith("/schedule-summary")) return { data: { businessDate: "2026-08-18", totalInstallments: 25, deferralCount: 2, paidInstallments: 1, overdueInstallments: 10, dueTodayInstallments: 1, dueTodayAmount: "200.00", pendingInstallments: 13 } };
        if (url.endsWith("/funding-allocations")) return { data: [] };
        if (url.endsWith("/allocation-state")) return { data: { principalAmount: "4000.00", netAllocatedPrincipal: "0.00", remainingGap: "4000.00", overfundedAmount: "0.00", state: "unfunded" } };
        throw new Error(`Unexpected GET ${url}`);
    });
    render(
        <MemoryRouter initialEntries={[`/loans/${LOAN_ID}`]}>
            <Routes>
                <Route path="/loans/:id" element={<LoanDetail />} />
            </Routes>
        </MemoryRouter>,
    );
}

describe("Loan detail repayment schedule table", () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        await appI18n.changeLanguage("th");
    });

    it("paginates the full schedule so rows after the first page remain accessible", async () => {
        renderLoanDetail();
        await userEvent.click(await screen.findByRole("tab", { name: "ตารางผ่อน" }));

        const section = (await screen.findByRole("heading", { name: "ตารางผ่อน" })).closest("div.rounded-lg");
        expect(section).not.toBeNull();

        const table = within(section as HTMLElement).getByRole("table");
        expect(within(table).getByRole("columnheader", { name: "งวด" })).toBeInTheDocument();
        expect(within(table).getByRole("columnheader", { name: "ลำดับ" })).toBeInTheDocument();
        expect(within(table).getByRole("columnheader", { name: "วันครบกำหนด" })).toBeInTheDocument();
        expect(within(table).getByRole("columnheader", { name: "ยอดคงค้าง" })).toBeInTheDocument();
        expect(within(table).getByRole("columnheader", { name: "สถานะ" })).toBeInTheDocument();
        expect(within(table).queryByRole("columnheader", { name: "ค่าคอมมิชชันที่เกิดขึ้น" })).not.toBeInTheDocument();
        expect(within(section as HTMLElement).getByText("ค่าคอมมิชชันจากดอกเบี้ยที่เก็บได้")).toBeInTheDocument();
        expect(within(section as HTMLElement).getByText("รวม: 25 รายการ")).toBeInTheDocument();
        expect(within(section as HTMLElement).getByTestId("schedule-summary")).toHaveTextContent("ชำระแล้ว");
        expect(within(section as HTMLElement).getByTestId("schedule-summary")).toHaveTextContent("1 / 25 งวด");
        expect(within(section as HTMLElement).getByTestId("schedule-summary")).toHaveTextContent("ค้างชำระ");
        expect(within(section as HTMLElement).getByTestId("schedule-summary")).toHaveTextContent("ถึงกำหนดวันนี้");
        expect(within(section as HTMLElement).getByTestId("schedule-summary")).toHaveTextContent("รอชำระ");
        expect(within(section as HTMLElement).getByTestId("schedule-summary")).toHaveTextContent("เลื่อนชำระ");
        expect(within(section as HTMLElement).getByTestId("schedule-summary")).toHaveTextContent("2 ครั้ง");
        expect(within(table).getAllByRole("row")).toHaveLength(11);
        expect(within(table).getByTestId("schedule-row-number-1")).toHaveTextContent("1");
        expect(within(table).getByText("งวด #1")).toBeInTheDocument();
        expect(within(table).getByText("2026-07-01")).toBeInTheDocument();
        expect(within(table).getAllByText("฿200.00").length).toBeGreaterThan(0);
        expect(within(table).getByText("ค้างชำระ")).toBeInTheDocument();
        expect(within(table).getByText("ชำระแล้ว")).toBeInTheDocument();
        expect(within(table).getByTestId("schedule-status-paid")).toHaveClass("text-emerald-700");
        expect(within(table).getByTestId("schedule-status-icon-paid")).toBeInTheDocument();
        expect(within(table).getAllByTestId("schedule-status-due")[0]).toHaveClass("text-amber-700");
        expect(within(table).getAllByTestId("schedule-status-icon-due")[0]).toBeInTheDocument();
        expect(within(table).getByTestId("schedule-status-overdue")).toHaveClass("bg-destructive");
        expect(within(table).getByText("งวด #9")).toBeInTheDocument();
        expect(within(table).queryByText("งวด #11")).not.toBeInTheDocument();

        await userEvent.click(within(section as HTMLElement).getByRole("button", { name: "ถัดไป" }));
        expect(within(table).getByText("งวด #11")).toBeInTheDocument();
        expect(within(table).getByTestId("schedule-row-number-11")).toHaveTextContent("11");
        expect(within(table).getAllByRole("row")).toHaveLength(11);

        await userEvent.selectOptions(within(section as HTMLElement).getByLabelText("รายการต่อหน้า"), "all");
        expect(within(table).getByText("งวด #25")).toBeInTheDocument();
        expect(within(table).getAllByRole("row")).toHaveLength(26);
    });

    it("shows a distinct icon for each daily repayment term", async () => {
        renderLoanDetail({
            ...loan,
            repaymentType: "daily",
            dailyLoanCalculation: {
                durationValue: 15,
                durationUnit: "days",
                installmentAmount: "200.00",
                totalInstallments: 15,
                totalInterest: "0.00",
                dailyInterest: "0.00",
                flatDailyRatePercent: "0.0000",
            },
        });

        const section = (await screen.findByRole("heading", { name: "เงื่อนไขการผ่อนรายวัน" })).closest("div.rounded-lg");
        expect(section).not.toBeNull();
        expect(section?.querySelector("svg.lucide-calendar-days")).toBeInTheDocument();
        expect(section?.querySelector("svg.lucide-wallet")).toBeInTheDocument();
        expect(section?.querySelector("svg.lucide-list-ordered")).toBeInTheDocument();
        expect(section?.querySelector("svg.lucide-coins")).toBeInTheDocument();
        expect(section?.querySelector("svg.lucide-circle-dollar-sign")).toBeInTheDocument();
        expect(section?.querySelector("svg.lucide-percent")).toBeInTheDocument();
    });

    it("shows a deferral error inside the confirmation dialog when the request fails", async () => {
        vi.mocked(api.post).mockRejectedValueOnce({ response: { data: { message: "งวดนี้ไม่สามารถเลื่อนได้" } } });

        renderLoanDetail();
        await userEvent.click(await screen.findByRole("tab", { name: "ตารางผ่อน" }));

        const section = (await screen.findByRole("heading", { name: "ตารางผ่อน" })).closest("div.rounded-lg");
        expect(section).not.toBeNull();
        await userEvent.click(within(section as HTMLElement).getAllByRole("button", { name: "เลื่อนชำระ" })[0]);
        await userEvent.type(screen.getByLabelText("เหตุผล"), "ป่วย");
        await userEvent.click(screen.getByRole("button", { name: "ยืนยันเลื่อนชำระ" }));

        expect(await screen.findByRole("alert")).toHaveTextContent("งวดนี้ไม่สามารถเลื่อนได้");
        expect(screen.getByRole("dialog")).toHaveTextContent("งวดนี้ไม่สามารถเลื่อนได้");
    });

    it("opens the deferral reason from an info action on a deferred installment", async () => {
        renderLoanDetail();
        await userEvent.click(await screen.findByRole("tab", { name: "ตารางผ่อน" }));

        const section = (await screen.findByRole("heading", { name: "ตารางผ่อน" })).closest("div.rounded-lg");
        expect(section).not.toBeNull();
        await userEvent.click(within(section as HTMLElement).getByRole("button", { name: "ดูเหตุผลการเลื่อนชำระ งวดที่ 3" }));

        expect(screen.getByRole("dialog")).toHaveTextContent("ลูกหนี้ป่วย");
    });
});
