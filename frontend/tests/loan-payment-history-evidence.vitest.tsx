import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { api, resolveFileAccess } from "../src/lib/api";
import { LoanPaymentHistoryTab } from "../src/pages/dashboard/loans/LoanPaymentHistoryTab";

vi.mock("../src/lib/api", () => ({ api: { get: vi.fn(), post: vi.fn() }, resolveFileAccess: vi.fn() }));

const loanPublicId = "11111111-1111-4111-8111-111111111111";
const primaryFile = "22222222-2222-4222-8222-222222222222";
const supplementFile = "33333333-3333-4333-8333-333333333333";

describe("loan payment history evidence", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(api.get).mockImplementation(async (url) => {
            if (url === "/transactions") return { data: [{
                publicId: "44444444-4444-4444-8444-444444444444", loanPublicId,
                amount: "100.00", interestComponent: "10.00", date: "2026-09-07T01:00:00.000Z", type: "repayment",
                evidence: [
                    { publicId: "55555555-5555-4555-8555-555555555555", filePublicId: primaryFile, mimeType: "image/png", source: "primary" },
                    { publicId: "66666666-6666-4666-8666-666666666666", filePublicId: supplementFile, mimeType: "application/pdf", source: "supplement", reason: "upload_channel_unavailable" },
                ],
            }] };
            if (url === "/intermediaries?status=all") return { data: { items: [] } };
            if (url.includes("/intermediary-attributions")) return { data: [] };
            if (url.includes("/commissions?")) return { data: { totalCommission: "0.00", participants: [] } };
            throw new Error(`Unexpected GET ${url}`);
        });
        vi.mocked(resolveFileAccess).mockResolvedValue({ url: "https://signed.example/short-lived", mimeType: "image/png" });
    });

    it("shows primary and supplemental slip buttons and resolves access only after click", async () => {
        render(<LoanPaymentHistoryTab loanPublicId={loanPublicId} />);
        const primary = await screen.findByRole("button", { name: /primary slip/i });
        expect(screen.getByRole("button", { name: /supplemental slip.*upload channel unavailable/i })).toBeInTheDocument();
        expect(resolveFileAccess).not.toHaveBeenCalled();
        await userEvent.setup().click(primary);
        await waitFor(() => expect(resolveFileAccess).toHaveBeenCalledWith(primaryFile));
    });

    it("shows an unavailable state and no evidence button when no ready evidence exists", async () => {
        vi.mocked(api.get).mockImplementation(async (url) => {
            if (url === "/transactions") return { data: [{ publicId: "44444444-4444-4444-8444-444444444444", loanPublicId, amount: "100.00", interestComponent: "10.00", date: "2026-09-07T01:00:00.000Z", type: "repayment", evidence: [] }] };
            if (url === "/intermediaries?status=all") return { data: { items: [] } };
            if (url.includes("/intermediary-attributions")) return { data: [] };
            if (url.includes("/commissions?")) return { data: { totalCommission: "0.00", participants: [] } };
            throw new Error(`Unexpected GET ${url}`);
        });
        render(<LoanPaymentHistoryTab loanPublicId={loanPublicId} />);
        expect(await screen.findByText(/evidence unavailable/i)).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: /slip/i })).not.toBeInTheDocument();
    });
});
