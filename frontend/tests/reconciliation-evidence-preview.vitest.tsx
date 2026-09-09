import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../src/lib/api";
import ReconciliationPage from "../src/pages/dashboard/reconciliation/ReconciliationPage";

vi.mock("../src/lib/api", () => ({ api: { get: vi.fn(), post: vi.fn() } }));

describe("Reconciliation evidence previews", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(api.get).mockResolvedValue({ data: {
            pendingUploads: [{ id: 1, source: "line", senderId: "sender", status: "pending", createdAt: "2026-08-12T00:00:00Z", fileUrl: "https://signed.example/upload.png" }],
            unreconciledBorrowerTransactions: [{ id: 2, loanId: 3, borrowerName: "Borrower", amount: "60.00", transactionDate: "2026-08-12", slipUrl: "https://signed.example/slip.png" }],
            unreconciledBankRepayments: [],
        } });
    });

    test("offers compact previews for uploads and borrower slips", async () => {
        const user = userEvent.setup();
        render(<ReconciliationPage />);
        const triggers = await screen.findAllByRole("button", { name: /preview/i });
        expect(triggers).toHaveLength(2);
        await user.click(triggers[1]!);
        expect(await screen.findByRole("img", { name: /preview slip/i })).toHaveAttribute("src", "https://signed.example/slip.png");
    });
});
