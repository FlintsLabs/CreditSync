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
            { id: "daily", publicId: "daily", borrowerName: "Daily", principal: "5000.00", outstandingPrincipal: "3750.00", status: "active", repaymentType: "daily", installmentAmount: "250.00", totalInstallments: 12, startDate: "2026-08-01", createdAt: "2026-08-10T07:30:00.000Z" },
            { id: "floating", publicId: "floating", borrowerName: "Floating", principal: "900.00", outstandingPrincipal: "900.00", status: "draft", repaymentType: "floating", installmentAmount: null, totalInstallments: null, startDate: null, createdAt: "2026-08-10T07:30:00.000Z" },
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
});
