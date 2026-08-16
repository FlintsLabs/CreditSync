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
const schedule = Array.from({ length: 9 }, (_, index) => ({
    id: `schedule-${index + 1}`,
    publicId: `schedule-public-${index + 1}`,
    installmentNo: index + 1,
    dueDate: `2026-07-${String(index + 1).padStart(2, "0")}`,
    scheduledTotal: "200.00",
    remainingDue: index === 1 ? "0.00" : "200.00",
    status: index === 0 ? "overdue" : index === 1 ? "paid" : "scheduled",
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

function renderLoanDetail() {
    vi.mocked(api.get).mockImplementation(async (url) => {
        if (url === `/loans/${LOAN_ID}`) return { data: loan };
        if (url === `/borrowers/${BORROWER_ID}`) return { data: { id: BORROWER_ID, publicId: BORROWER_ID, name: "พี่ฟ้า" } };
        if (url.endsWith("/schedule")) return { data: schedule };
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

    it("renders a localized compact semantic table with the first eight rows", async () => {
        renderLoanDetail();
        await userEvent.click(await screen.findByRole("tab", { name: "ตารางผ่อน" }));

        const section = (await screen.findByRole("heading", { name: "ตารางผ่อน" })).closest("div.rounded-lg");
        expect(section).not.toBeNull();

        const table = within(section as HTMLElement).getByRole("table");
        expect(within(table).getByRole("columnheader", { name: "งวด" })).toBeInTheDocument();
        expect(within(table).getByRole("columnheader", { name: "วันครบกำหนด" })).toBeInTheDocument();
        expect(within(table).getByRole("columnheader", { name: "ยอดคงค้าง" })).toBeInTheDocument();
        expect(within(table).getByRole("columnheader", { name: "สถานะ" })).toBeInTheDocument();
        expect(within(table).queryByRole("columnheader", { name: "ค่าคอมมิชชันที่เกิดขึ้น" })).not.toBeInTheDocument();
        expect(within(section as HTMLElement).getByText("ค่าคอมมิชชันจากดอกเบี้ยที่เก็บได้")).toBeInTheDocument();
        expect(within(table).getAllByRole("row")).toHaveLength(9);
        expect(within(table).getByText("งวด #1")).toBeInTheDocument();
        expect(within(table).getByText("2026-07-01")).toBeInTheDocument();
        expect(within(table).getAllByText("฿200.00").length).toBeGreaterThan(0);
        expect(within(table).getByText("ค้างชำระ")).toBeInTheDocument();
        expect(within(table).getByText("ชำระแล้ว")).toBeInTheDocument();
        expect(within(table).queryByText("งวด #9")).not.toBeInTheDocument();
    });
});
