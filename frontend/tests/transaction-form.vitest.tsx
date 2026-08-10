import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../src/lib/api";
import TransactionForm from "../src/pages/dashboard/transactions/TransactionForm";

vi.mock("../src/lib/api", () => ({ api: { get: vi.fn(), post: vi.fn() } }));

const BORROWER_A = "019c3a5a-94ce-7f2c-8b08-f56852dca7a3";
const BORROWER_B = "019c3a5a-94ce-7f2c-8b08-f56852dca7a4";
const LOAN_A = "019c3a5a-94ce-7f2c-8b08-f56852dca7a5";
const LOAN_B = "019c3a5a-94ce-7f2c-8b08-f56852dca7a6";

describe("TransactionForm", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(api.get).mockImplementation(async (url) => {
            if (url === "/borrowers") return { data: [
                { publicId: BORROWER_A, name: "Borrower A" },
                { publicId: BORROWER_B, name: "Borrower B" },
            ] };
            if (url === "/loans") return { data: [
                { publicId: LOAN_A, borrowerPublicId: BORROWER_A, borrowerName: "Borrower A", principal: "100.00", status: "active" },
                { publicId: LOAN_B, borrowerPublicId: BORROWER_B, borrowerName: "Borrower B", principal: "200.00", status: "active" },
            ] };
            if (url === `/loans/${LOAN_A}/schedule`) return { data: [] };
            throw new Error(`Unexpected GET ${url}`);
        });
    });

    test("filters active loan choices after selecting a borrower", async () => {
        const user = userEvent.setup();
        render(<MemoryRouter><TransactionForm /></MemoryRouter>);

        const borrowerSelect = await screen.findByLabelText("Borrower");
        const loanSelect = screen.getByLabelText("Select Loan Agreement");
        expect(loanSelect).toBeDisabled();
        await user.selectOptions(borrowerSelect, BORROWER_A);

        expect(within(loanSelect).getByRole("option", { name: /borrower a/i })).toBeInTheDocument();
        expect(within(loanSelect).queryByRole("option", { name: /borrower b/i })).not.toBeInTheDocument();
    });
});
