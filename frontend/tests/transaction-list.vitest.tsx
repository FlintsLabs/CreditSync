import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../src/lib/api";
import TransactionList from "../src/pages/dashboard/transactions/TransactionList";

vi.mock("../src/lib/api", () => ({ api: { get: vi.fn() } }));

describe("TransactionList", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(api.get).mockResolvedValue({ data: [
            { id: "positive", date: "2026-08-12", borrowerName: "Positive borrower", amount: "60.00", slipUrl: "https://signed.example/legacy-slip.jpg" },
            { id: "negative", date: "2026-08-12", borrowerName: "Negative borrower", amount: "-60.00" },
            { id: "zero", date: "2026-08-12", borrowerName: "Zero borrower", amount: "0.00" },
        ] });
    });

    test("uses semantic colors for positive, negative, and zero transaction totals", async () => {
        render(<MemoryRouter><TransactionList /></MemoryRouter>);

        const positive = await screen.findByTestId("transaction-total-positive");
        const negative = screen.getByTestId("transaction-total-negative");
        const zero = screen.getByTestId("transaction-total-zero");

        expect(positive).toHaveClass("text-green-600");
        expect(negative).toHaveClass("text-red-600");
        expect(negative).toHaveTextContent("-");
        expect(zero).not.toHaveClass("text-green-600");
        expect(zero).not.toHaveClass("text-red-600");
    });

    test("previews a legacy slip only after its compact trigger is clicked", async () => {
        const user = userEvent.setup();
        render(<MemoryRouter><TransactionList /></MemoryRouter>);
        const triggers = await screen.findAllByRole("button", { name: /preview slip/i });
        expect(triggers).toHaveLength(1);
        await user.click(triggers[0]!);
        expect(await screen.findByRole("img", { name: /preview slip/i })).toHaveAttribute("src", "https://signed.example/legacy-slip.jpg");
    });
});
