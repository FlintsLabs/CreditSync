import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LoanPaymentHistoryTab } from "../src/pages/dashboard/loans/LoanPaymentHistoryTab";
import { api } from "../src/lib/api";
import i18n from "../src/lib/i18n";

vi.mock("../src/lib/api", () => ({ api: { get: vi.fn(), post: vi.fn() } }));

describe("LoanPaymentHistoryTab", () => {
    beforeEach(async () => { vi.clearAllMocks(); await i18n.changeLanguage("en"); });

    it("renders direct, one-agent, split, and unattributed posted payments with authoritative commissions", async () => {
        const payments = ["direct", "one", "split", "none"].map((id) => ({ publicId: id, loanPublicId: "loan-1", amount: "100.00", interestComponent: "20.00", date: "2026-08-16T00:00:00.000Z", type: "repayment" }));
        vi.mocked(api.get).mockImplementation(async (url) => {
            if (url === "/transactions") return { data: payments };
            if (url === "/intermediaries?status=all") return { data: [{ publicId: "a", name: "Agent A" }, { publicId: "b", name: "Agent B" }] };
            if (url === "/loans/loan-1/commissions?paymentPublicIds=direct%2Cone%2Csplit%2Cnone") return { data: { totalCommission: "12.34", participants: [] } };
            if (url.startsWith("/loans/loan-1/commissions?paymentPublicIds=")) return { data: { totalCommission: "3.00", participants: [] } };
            if (url === "/payments/direct/intermediary-attributions") return { data: [{ publicId: "ad", sourceKind: "direct", intermediaryPublicId: null, amount: "100.00" }] };
            if (url === "/payments/one/intermediary-attributions") return { data: [{ publicId: "ao", sourceKind: "intermediary", intermediaryPublicId: "a", amount: "100.00" }] };
            if (url === "/payments/split/intermediary-attributions") return { data: [{ publicId: "as1", sourceKind: "intermediary", intermediaryPublicId: "a", amount: "60.00" }, { publicId: "as2", sourceKind: "intermediary", intermediaryPublicId: "b", amount: "40.00" }] };
            if (url === "/payments/none/intermediary-attributions") return { data: [] };
            throw new Error(`Unexpected GET ${url}`);
        });
        render(<LoanPaymentHistoryTab loanPublicId="loan-1" />);

        expect(await screen.findByText("Total commission")).toBeInTheDocument();
        expect(screen.getByText(/THB\s*12\.34/)).toBeInTheDocument();
        expect(within(screen.getByTestId("payment-direct")).getByText(/Direct payment/)).toBeInTheDocument();
        expect(within(screen.getByTestId("payment-one")).getByText(/Agent A.*THB\s*100\.00/)).toBeInTheDocument();
        expect(within(screen.getByTestId("payment-split")).getByText(/Agent B.*THB\s*40\.00/)).toBeInTheDocument();
        expect(within(screen.getByTestId("payment-none")).getByText("Unattributed")).toBeInTheDocument();
    });

    it("localizes direct and unattributed payment states in Thai", async () => {
        await i18n.changeLanguage("th");
        vi.mocked(api.get).mockImplementation(async (url) => {
            if (url === "/transactions") return { data: [
                { publicId: "direct", loanPublicId: "loan-1", amount: "50.00", interestComponent: "5.00", date: "2026-08-16T00:00:00.000Z", type: "repayment" },
                { publicId: "none", loanPublicId: "loan-1", amount: "50.00", interestComponent: "5.00", date: "2026-08-16T00:00:00.000Z", type: "repayment" },
            ] };
            if (url === "/intermediaries?status=all") return { data: [] };
            if (url === "/payments/direct/intermediary-attributions") return { data: [{ publicId: "ad", sourceKind: "direct", intermediaryPublicId: null, amount: "50.00" }] };
            if (url === "/payments/none/intermediary-attributions") return { data: [] };
            if (url.startsWith("/loans/loan-1/commissions?")) return { data: { totalCommission: "1.00", participants: [] } };
            throw new Error(`Unexpected GET ${url}`);
        });
        render(<LoanPaymentHistoryTab loanPublicId="loan-1" />);
        expect(await screen.findByText("ค่าคอมมิชชันรวม")).toBeInTheDocument();
        expect(within(screen.getByTestId("payment-direct")).getByText("ชำระโดยตรง")).toBeInTheDocument();
        expect(within(screen.getByTestId("payment-none")).getByText("ยังไม่ระบุแหล่งที่มา")).toBeInTheDocument();
    });

    it("paginates posted payments so rows after the first page remain accessible", async () => {
        const payments = Array.from({ length: 25 }, (_, index) => ({
            publicId: `payment-${index + 1}`, loanPublicId: "loan-1", amount: "100.00", interestComponent: "20.00",
            date: "2026-08-16T00:00:00.000Z", type: "repayment",
        }));
        vi.mocked(api.get).mockImplementation(async (url) => {
            if (url === "/transactions") return { data: payments };
            if (url === "/intermediaries?status=all") return { data: [] };
            if (url.startsWith("/payments/") && url.endsWith("/intermediary-attributions")) return { data: [] };
            if (url.startsWith("/loans/loan-1/commissions?")) return { data: { totalCommission: "0.00", participants: [] } };
            throw new Error(`Unexpected GET ${url}`);
        });
        render(<LoanPaymentHistoryTab loanPublicId="loan-1" />);

        const table = await screen.findByRole("table");
        expect(within(table).getByTestId("payment-payment-1")).toBeInTheDocument();
        expect(within(table).getByTestId("payment-payment-10")).toBeInTheDocument();
        expect(within(table).queryByTestId("payment-payment-11")).not.toBeInTheDocument();
        await userEvent.click(screen.getByRole("button", { name: "Next" }));
        expect(within(table).getByTestId("payment-payment-11")).toBeInTheDocument();
        await userEvent.selectOptions(screen.getByLabelText("Rows per page"), "all");
        expect(within(table).getByTestId("payment-payment-25")).toBeInTheDocument();
    });

    it("reuses an attribution idempotency key for unchanged retries and replaces it after a payload change", async () => {
        vi.mocked(api.get).mockImplementation(async (url) => {
            if (url === "/transactions") return { data: [{ publicId: "payment-a", loanPublicId: "loan-1", amount: "100.00", interestComponent: "20.00", date: "2026-08-16T00:00:00.000Z", type: "repayment" }] };
            if (url === "/intermediaries?status=all") return { data: [] };
            if (url === "/payments/payment-a/intermediary-attributions") return { data: [] };
            if (url.startsWith("/loans/loan-1/commissions?")) return { data: { totalCommission: "0.00", participants: [] } };
            throw new Error(`Unexpected GET ${url}`);
        });
        vi.mocked(api.post).mockRejectedValueOnce(new Error("lost response")).mockRejectedValueOnce(new Error("lost response again")).mockResolvedValue({ data: {} });
        render(<LoanPaymentHistoryTab loanPublicId="loan-1" />);
        await screen.findByTestId("payment-payment-a");
        await userEvent.click(screen.getByRole("button", { name: "Attribute" }));
        await userEvent.click(screen.getByLabelText("I confirm this payment source attribution"));

        await userEvent.click(screen.getByRole("button", { name: "Save" }));
        await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
        await userEvent.click(screen.getByRole("button", { name: "Save" }));
        await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
        const firstKey = vi.mocked(api.post).mock.calls[0]?.[2]?.headers?.["Idempotency-Key"];
        expect(vi.mocked(api.post).mock.calls[1]?.[2]?.headers?.["Idempotency-Key"]).toBe(firstKey);

        await userEvent.clear(screen.getByLabelText("Amount"));
        await userEvent.type(screen.getByLabelText("Amount"), "90.00");
        await userEvent.click(screen.getByLabelText("I confirm this payment source attribution"));
        await userEvent.click(screen.getByRole("button", { name: "Save" }));
        await waitFor(() => expect(api.post).toHaveBeenCalledTimes(3));
        expect(vi.mocked(api.post).mock.calls[2]?.[2]?.headers?.["Idempotency-Key"]).not.toBe(firstKey);
    });
});
