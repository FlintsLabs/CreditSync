/* eslint-disable react-refresh/only-export-components */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../src/lib/api";
import { LoanRepaymentHistory } from "../src/pages/dashboard/loans/LoanRepaymentHistory";

vi.mock("../src/lib/api", () => ({ api: { get: vi.fn(), post: vi.fn() } }));

const LOAN_ID = "019c3a5a-94ce-7f2c-8b08-f56852dca7a5";

function LocationDisplay() {
    const location = useLocation();
    return <output>{`${location.pathname}${location.search}`}</output>;
}

describe("LoanRepaymentHistory", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(api.get).mockResolvedValue({ data: [{
            publicId: "019c3a5a-94ce-7f2c-8b08-f56852dca7a6",
            status: "posted",
            amount: "125.00",
            receivedAt: "2026-08-10T10:25:00.000Z",
            bankReference: "TRANSFER-001",
            latestAllocation: { amount: "125.00", proposalPublicId: null },
            postedComponents: { principal: "100.00", interest: "25.00", fee: "0.00", penalty: "0.00" },
        }] });
        Object.defineProperty(window, "matchMedia", {
            configurable: true,
            value: vi.fn().mockReturnValue({ matches: false }),
        });
    });

    test("shows posted repayment details and a quick-capture action", async () => {
        render(
            <MemoryRouter>
                <LoanRepaymentHistory loanPublicId={LOAN_ID} borrowerName="Borrower A" />
            </MemoryRouter>
        );

        expect(await screen.findByText("Repayments received")).toBeInTheDocument();
        expect(screen.getAllByText("Posted")).not.toHaveLength(0);
        expect(screen.getByText("TRANSFER-001")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Record repayment" })).toBeInTheDocument();
    });

    test("opens the quick-capture dialog on desktop and navigates to the full form on mobile", async () => {
        const user = userEvent.setup();
        const { rerender } = render(
            <MemoryRouter initialEntries={["/loans/example"]}>
                <LoanRepaymentHistory loanPublicId={LOAN_ID} borrowerName="Borrower A" />
                <LocationDisplay />
            </MemoryRouter>
        );

        await screen.findByText("Repayments received");
        await user.click(screen.getByRole("button", { name: "Record repayment" }));
        expect(screen.getByText(`/transactions/new?loanId=${LOAN_ID}`)).toBeInTheDocument();

        Object.defineProperty(window, "matchMedia", {
            configurable: true,
            value: vi.fn().mockReturnValue({ matches: true }),
        });
        rerender(
            <MemoryRouter initialEntries={["/loans/example"]}>
                <LoanRepaymentHistory loanPublicId={LOAN_ID} borrowerName="Borrower A" />
            </MemoryRouter>
        );
        await user.click(screen.getByRole("button", { name: "Record repayment" }));
        expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
});
