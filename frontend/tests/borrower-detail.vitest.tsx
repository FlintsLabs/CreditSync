import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import BorrowerDetail from "../src/pages/dashboard/borrowers/BorrowerDetail";
import { api } from "../src/lib/api";

vi.mock("../src/lib/api", () => ({ api: { get: vi.fn(), post: vi.fn() } }));

const portfolio = {
    borrower: { publicId: "11111111-1111-4111-8111-111111111111", name: "Exact Borrower", idCardImageUrl: "https://signed.example/id-card.jpg" },
    aliases: [{
        publicId: "22222222-2222-4222-8222-222222222222",
        alias: "Account Name",
        normalizedAlias: "account name",
        source: "manual",
        status: "pending",
        createdAt: "2026-08-10T10:00:00.000Z",
        updatedAt: "2026-08-10T10:00:00.000Z",
    }],
    loans: [{
        publicId: "33333333-3333-4333-8333-333333333333",
        principal: "9007199254740993.01",
        repaymentType: "daily",
        status: "active",
        startDate: "2026-08-10",
    }],
};

function renderDetail() {
    return render(<MemoryRouter initialEntries={["/borrowers/11111111-1111-4111-8111-111111111111"]}>
        <Routes><Route path="/borrowers/:id" element={<BorrowerDetail />} /></Routes>
    </MemoryRouter>);
}

describe("BorrowerDetail", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(api.get).mockImplementation(async (url) => {
            if (url.includes("/portfolio")) return { data: portfolio };
            throw { response: { status: 403 } };
        });
    });

    it("formats exact loan money and distinguishes a forbidden audit trail", async () => {
        const user = userEvent.setup();
        renderDetail();
        expect(await screen.findByText(/9,007,199,254,740,993\.01/)).toBeInTheDocument();
        await user.click(screen.getByRole("tab", { name: /revision history/i }));
        expect(await screen.findByText(/unavailable for this role/i)).toBeInTheDocument();
    });

    it("uses the public alias endpoint and refreshes the portfolio", async () => {
        vi.mocked(api.post).mockResolvedValue({ data: { ...portfolio.aliases[0], status: "confirmed" } });
        const user = userEvent.setup();
        renderDetail();
        await screen.findByText("Exact Borrower");
        await user.click(screen.getByRole("tab", { name: /aliases/i }));
        await user.click(await screen.findByRole("button", { name: /confirm/i }));
        await waitFor(() => expect(api.post).toHaveBeenCalledWith(
            "/borrowers/aliases/22222222-2222-4222-8222-222222222222/confirm",
        ));
    });

    it("uses a compact responsive avatar in the borrower header", async () => {
        renderDetail();

        const avatar = await screen.findByTestId("borrower-detail-avatar");
        expect(avatar).toHaveClass("h-[72px]", "w-[72px]", "md:h-20", "md:w-20");
    });

    it("previews an available ID-card image from borrower detail", async () => {
        const user = userEvent.setup();
        renderDetail();
        await user.click(await screen.findByRole("button", { name: /preview id card/i }));
        expect(await screen.findByRole("img", { name: /preview id card/i })).toHaveAttribute("src", "https://signed.example/id-card.jpg");
    });
});
