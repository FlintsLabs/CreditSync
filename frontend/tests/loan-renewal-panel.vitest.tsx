import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LoanRenewalPanel } from "../src/pages/dashboard/loans/LoanRenewalPanel";
import { api } from "../src/lib/api";

vi.mock("../src/lib/api", () => ({ api: { get: vi.fn(), post: vi.fn() } }));

const renewal = {
    publicId: "11111111-1111-4111-8111-111111111111",
    status: "preview",
    previewHash: `v1:${"a".repeat(64)}`,
    principalPaid: "1.00",
    outstandingPrincipal: "9007199254740993.01",
    dueInterest: "2.01",
    dueFees: "3.02",
    duePenalties: "4.03",
    dueCharges: "9.06",
    settlementAmount: "9.06",
    waivedCharges: "0.00",
    requestedPrincipal: "9007199254741002.07",
    cashDirection: "payout",
    cashAmount: "9.00",
    renewalDate: "2026-08-10",
    paymentStartDate: "2026-08-11",
    expiresAt: "2026-08-10T12:00:00.000Z",
    composition: {
        settlementPolicy: "full_contract_interest",
        contractStartDate: "2026-08-01",
        contractDueDate: "2026-08-24",
        renewalDate: "2026-08-10",
        requestedPrincipal: "9007199254741002.07",
        originalPrincipal: "100.00",
        totalScheduledAmount: "100.00",
        contractualInterest: "10.00",
        totalPaid: "1.00",
        receivedPrincipal: "1.00",
        receivedInterest: "0.00",
        remainingContractInterest: "9.00",
        accruedDueInterest: "2.01",
        dueFees: "3.02",
        duePenalties: "4.03",
        recoveredBeforeAdjustments: "1.00",
        manualCharges: "0.00",
        manualWaivers: "0.00",
        settlementAmount: "9.06",
        cashDirection: "payout",
        cashAmount: "9.00",
        payments: [],
        adjustments: [],
    },
};

const loan = {
    publicId: "22222222-2222-4222-8222-222222222222",
    principalAmount: "100.00",
    interestRate: "15.00",
    repaymentType: "daily",
    termMonths: 12,
    totalInstallments: 360,
    installmentAmount: "3.20",
    status: "active",
};

describe("LoanRenewalPanel", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(api.get).mockImplementation(async (url) => ({ data: String(url).includes("/summary") ? null : [] }));
    });

    it("shows every charge component exactly and reuses the execution key for a retry", async () => {
        const executeCalls: Array<{ headers?: Record<string, string> }> = [];
        vi.mocked(api.post).mockImplementation(async (url, _body, config) => {
            if (url === "/loan-renewals/preview") return { data: renewal };
            if (url === "/loans/preview") return { data: { schedule: [] } };
            if (url.includes("/execute")) {
                executeCalls.push(config ?? {});
                throw { response: { data: { code: "STALE_RENEWAL_PREVIEW" } } };
            }
            throw new Error(`Unexpected POST ${url}`);
        });

        const user = userEvent.setup();
        render(<LoanRenewalPanel loan={loan} />);
        await user.click(screen.getByRole("button", { name: /preview renewal/i }));

        expect(await screen.findByText("Accrued interest due")).toBeInTheDocument();
        expect(screen.getByText("Fees due")).toBeInTheDocument();
        expect(screen.getByText("Penalties due")).toBeInTheDocument();
        expect(screen.getByText("Renewal effective date")).toBeInTheDocument();
        expect(screen.getByText("First payment date")).toBeInTheDocument();

        await user.type(screen.getByLabelText("Execution reason"), "Renew agreement");
        await user.click(screen.getByRole("checkbox"));
        await user.click(screen.getByRole("button", { name: /confirm renewal/i }));
        await screen.findByRole("alert");
        await user.click(screen.getByRole("button", { name: /confirm renewal/i }));
        await waitFor(() => expect(executeCalls).toHaveLength(2));
        expect(executeCalls[0]?.headers?.["Idempotency-Key"]).toBe(executeCalls[1]?.headers?.["Idempotency-Key"]);
    });

    it("reuses a reversal key until the reversal reason changes", async () => {
        const reverseCalls: Array<{ headers?: Record<string, string> }> = [];
        vi.mocked(api.post).mockImplementation(async (url, _body, config) => {
            if (url === "/loan-renewals/preview") return { data: renewal };
            if (url === "/loans/preview") return { data: { schedule: [] } };
            if (url.includes("/execute")) return { data: { ...renewal, status: "executed", newLoanPublicId: loan.publicId } };
            if (url.includes("/reverse")) {
                reverseCalls.push(config ?? {});
                throw { response: { data: { code: "REVERSAL_NOT_LATEST" } } };
            }
            throw new Error(`Unexpected POST ${url}`);
        });

        const user = userEvent.setup();
        render(<LoanRenewalPanel loan={loan} />);
        await user.click(screen.getByRole("button", { name: /preview renewal/i }));
        await user.type(await screen.findByLabelText("Execution reason"), "Renew agreement");
        await user.click(screen.getByRole("checkbox"));
        await user.click(screen.getByRole("button", { name: /confirm renewal/i }));
        const reason = await screen.findByLabelText("Reversal reason");
        await user.type(reason, "Wrong agreement");
        await user.click(screen.getByRole("button", { name: /reverse renewal/i }));
        await screen.findByRole("alert");
        await user.click(screen.getByRole("button", { name: /reverse renewal/i }));
        await waitFor(() => expect(reverseCalls).toHaveLength(2));
        expect(reverseCalls[0]?.headers?.["Idempotency-Key"]).toBe(reverseCalls[1]?.headers?.["Idempotency-Key"]);

        fireEvent.change(reason, { target: { value: "Different reason" } });
        await user.click(screen.getByRole("button", { name: /reverse renewal/i }));
        await waitFor(() => expect(reverseCalls).toHaveLength(3));
        expect(reverseCalls[2]?.headers?.["Idempotency-Key"]).not.toBe(reverseCalls[1]?.headers?.["Idempotency-Key"]);
    });
});
