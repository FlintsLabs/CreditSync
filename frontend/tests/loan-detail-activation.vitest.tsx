import { render, screen, waitFor } from "@testing-library/react";
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

const LOAN_ID = "019ff023-fd64-7d41-9aae-723d2a458a8a";
const BORROWER_ID = "019fea17-6068-7ccb-b267-9f39880bb762";
const draftLoan = {
    id: LOAN_ID,
    publicId: LOAN_ID,
    borrowerPublicId: BORROWER_ID,
    principalAmount: "4000.00",
    interestRate: "0.00",
    repaymentType: "floating",
    termMonths: null,
    installmentAmount: null,
    totalInstallments: null,
    startDate: "2026-08-06",
    nextDueDate: null,
    outstandingPrincipal: "0.00",
    outstandingInterest: "0.00",
    outstandingFees: "0.00",
    status: "draft",
};

function renderLoanDetail(loan = draftLoan) {
    vi.mocked(api.get).mockImplementation(async (url) => {
        if (url === `/loans/${LOAN_ID}`) return { data: loan };
        if (url === `/borrowers/${BORROWER_ID}`) return { data: { id: BORROWER_ID, publicId: BORROWER_ID, name: "พี่ฟ้า" } };
        if (url.endsWith("/schedule") || url.endsWith("/funding-allocations")) return { data: [] };
        if (url.endsWith("/allocation-state")) return { data: { principalAmount: "4000.00", netAllocatedPrincipal: "0.00", remainingGap: "4000.00", overfundedAmount: "0.00", state: "unfunded" } };
        throw new Error(`Unexpected GET ${url}`);
    });
    return render(
        <MemoryRouter initialEntries={[`/loans/${LOAN_ID}`]}>
            <Routes><Route path="/loans/:id" element={<LoanDetail />} /></Routes>
        </MemoryRouter>,
    );
}

describe("Loan Detail draft activation", () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        await appI18n.changeLanguage("th");
    });

    it("requires confirmation before activating an existing loan draft", async () => {
        vi.mocked(api.post).mockResolvedValueOnce({ data: { ...draftLoan, status: "active", outstandingPrincipal: "4000.00" } });
        const user = userEvent.setup();
        renderLoanDetail();

        await user.click(await screen.findByRole("button", { name: "เปิดใช้งานสัญญา" }));
        expect(api.post).not.toHaveBeenCalled();
        expect(screen.getByRole("dialog")).toHaveTextContent(/4,000\.00/);

        await user.click(screen.getByRole("button", { name: "ยืนยันเปิดใช้งาน" }));
        await waitFor(() => expect(api.post).toHaveBeenCalledWith(
            `/loans/${LOAN_ID}/activate`,
            undefined,
            { headers: { "Idempotency-Key": expect.any(String) } },
        ));
        await waitFor(() => expect(screen.queryByRole("button", { name: "เปิดใช้งานสัญญา" })).not.toBeInTheDocument());
        expect(screen.getByText("ใช้งานอยู่")).toBeInTheDocument();
    });

    it("does not offer activation for an active loan", async () => {
        renderLoanDetail({ ...draftLoan, status: "active", outstandingPrincipal: "4000.00" });

        expect(await screen.findByText("ใช้งานอยู่")).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "เปิดใช้งานสัญญา" })).not.toBeInTheDocument();
    });

    // Break caught: the Thai detail page leaks the raw English paid lifecycle value.
    it("localizes a paid loan status in Thai", async () => {
        renderLoanDetail({ ...draftLoan, status: "paid", outstandingPrincipal: "0.00" });

        expect(await screen.findByText("ชำระครบ")).toBeInTheDocument();
        expect(screen.queryByText(/^paid$/i)).not.toBeInTheDocument();
    });

    it("keeps the draft available when activation fails", async () => {
        const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
        vi.mocked(api.post)
            .mockRejectedValueOnce(new Error("activation failed"))
            .mockResolvedValueOnce({ data: { ...draftLoan, status: "active", outstandingPrincipal: "4000.00" } });
        const user = userEvent.setup();
        renderLoanDetail();

        await user.click(await screen.findByRole("button", { name: "เปิดใช้งานสัญญา" }));
        await user.click(screen.getByRole("button", { name: "ยืนยันเปิดใช้งาน" }));

        expect(await screen.findByText("เปิดใช้งานสัญญาไม่สำเร็จ ร่างสัญญายังไม่ถูกเปลี่ยนแปลง")).toBeInTheDocument();
        expect(screen.getByText("ร่าง")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "ยืนยันเปิดใช้งาน" })).toBeEnabled();
        expect(consoleError).toHaveBeenCalledWith("Failed to activate loan draft", expect.any(Error));
        const firstKey = (vi.mocked(api.post).mock.calls[0]?.[2] as { headers?: { "Idempotency-Key"?: string } })?.headers?.["Idempotency-Key"];
        await user.click(screen.getByRole("button", { name: "ยืนยันเปิดใช้งาน" }));
        await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
        const retryKey = (vi.mocked(api.post).mock.calls[1]?.[2] as { headers?: { "Idempotency-Key"?: string } })?.headers?.["Idempotency-Key"];
        expect(firstKey).toEqual(expect.any(String));
        expect(retryKey).toBe(firstKey);
        consoleError.mockRestore();
    });
});
