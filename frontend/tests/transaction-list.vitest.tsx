import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../src/lib/api";
import TransactionList from "../src/pages/dashboard/transactions/TransactionList";

vi.mock("../src/lib/api", () => ({ api: { get: vi.fn() } }));

describe("TransactionList", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(api.get).mockResolvedValue({ data: [
            { id: "positive", date: "2026-08-12", borrowerName: "Positive borrower", amount: "60.00" },
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
});
