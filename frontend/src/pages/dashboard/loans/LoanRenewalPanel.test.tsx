import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../../../lib/api";
import appI18n from "../../../lib/i18n";
import { LoanRenewalPanel } from "./LoanRenewalPanel";

vi.mock("../../../lib/api", () => ({ api: { get: vi.fn(), post: vi.fn() } }));

const composition = {
    settlementPolicy: "full_contract_interest", contractStartDate: "2026-08-01", contractDueDate: "2026-08-24", renewalDate: "2026-08-10",
    requestedPrincipal: "2000.00", originalPrincipal: "2000.00", totalScheduledAmount: "2400.00", contractualInterest: "400.00",
    totalPaid: "1000.00", receivedPrincipal: "833.33", receivedInterest: "166.67", remainingContractInterest: "233.33", accruedDueInterest: "0.00",
    dueFees: "0.00", duePenalties: "0.00", recoveredBeforeAdjustments: "600.00", manualCharges: "25.00", manualWaivers: "0.00",
    settlementAmount: "258.33", cashDirection: "payout", cashAmount: "908.34",
    payments: [{ transactionPublicId: "019ff2b2-15e2-7df7-a594-eb836ff388f0", paidAt: "2026-08-10T09:00:00.000Z", amount: "1000.00", principal: "833.33", interest: "166.67", fee: "0.00", penalty: "0.00" }],
    adjustments: [{ lineNo: 1, kind: "fee", amount: "25.00", reason: "manual review" }],
} as const;

describe("LoanRenewalPanel manual renewal", () => {
    beforeEach(async () => { vi.clearAllMocks(); await appI18n.changeLanguage("en"); (api.get as ReturnType<typeof vi.fn>).mockResolvedValue({ data: [] }); });

    test("sends explicit policy and manual lines, renders backend values, and edit discards approval", async () => {
        (api.post as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => url === "/loan-renewals/preview"
            ? { data: { publicId: "01a01eaf-fdec-79a1-9e0c-fa66a5efa4cc", status: "preview", previewHash: "v1:hash", principalPaid: "833.33", outstandingPrincipal: "1166.67", dueInterest: "233.33", dueFees: "0.00", duePenalties: "0.00", dueCharges: "258.33", settlementAmount: "258.33", waivedCharges: "0.00", requestedPrincipal: "2000.00", cashDirection: "payout", cashAmount: "908.34", expiresAt: "2099-08-10T10:00:00.000Z", settlementPolicy: "full_contract_interest", composition } }
            : { data: { schedule: [] } });
        render(<LoanRenewalPanel loan={{ publicId: "019ff2b2-15e2-7df7-a594-eb836ff388f0", principalAmount: "2000.00", interestRate: "20.00", repaymentType: "daily", termMonths: null, totalInstallments: 24, installmentAmount: "100.00", status: "active" }} />);
        fireEvent.click(screen.getByRole("button", { name: /add adjustment/i }));
        fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: "25" } });
        fireEvent.change(screen.getByLabelText(/required reason/i), { target: { value: "manual review" } });
        fireEvent.click(screen.getByRole("button", { name: /preview renewal/i }));
        await screen.findByText(/full old-contract interest/i);
        expect((api.post as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]).toEqual({ oldLoanPublicId: "019ff2b2-15e2-7df7-a594-eb836ff388f0", requestedPrincipal: "2000.00", settlementPolicy: "full_contract_interest", adjustments: [{ kind: "fee", amount: "25.00", reason: "manual review" }] });
        expect(screen.getByText(/manual review/)).not.toBeNull();
        expect(screen.getAllByText(/908\.34/).length).toBeGreaterThan(0);
        fireEvent.click(screen.getByRole("button", { name: /edit and re-preview/i }));
        await waitFor(() => expect(screen.queryByText(/full old-contract interest/i)).toBeNull());
        expect(screen.getByRole("button", { name: /preview renewal/i })).not.toBeNull();
    });
});
