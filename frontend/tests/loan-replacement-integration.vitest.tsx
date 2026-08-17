/* eslint-disable react-refresh/only-export-components */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AxiosResponse, InternalAxiosRequestConfig } from "axios";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import appI18n from "../src/lib/i18n";
import { api } from "../src/lib/api";
import {
    getLoanQueryRevision,
    loanDetailQueryKey,
    loanListQueryKey,
    resetLoanQueryInvalidationForTests,
} from "../src/lib/loan-query-invalidation";
import LoanDetail from "../src/pages/dashboard/loans/LoanDetail";
import LoanList from "../src/pages/dashboard/loans/LoanList";

vi.mock("../src/pages/dashboard/loans/LoanRenewalPanel", () => ({ LoanRenewalPanel: () => null }));
vi.mock("../src/pages/dashboard/loans/LoanDisbursements", () => ({ LoanDisbursements: () => null }));
vi.mock("../src/pages/dashboard/loans/FloatingInterestRateCard", () => ({ FloatingInterestRateCard: () => null }));
vi.mock("../src/pages/dashboard/loans/IntermediatedDisbursementPanel", () => ({ IntermediatedDisbursementPanel: () => null }));
vi.mock("../src/pages/dashboard/loans/LoanRestructurePanel", () => ({ LoanRestructurePanel: () => null }));

const OLD_LOAN_ID = "019ff023-fd64-7d41-9aae-723d2a458a8a";
const DRAFT_LOAN_ID = "019ff023-fd64-7d41-9aae-723d2a458a8b";
const REPLACEMENT_ID = "019ff023-fd64-7d41-9aae-723d2a458a8c";
const BORROWER_ID = "019fea17-6068-7ccb-b267-9f39880bb762";

type Phase = "initial" | "executed" | "reversed";

function lineage(phase: Exclude<Phase, "initial">, direction: "old" | "replacement") {
    return {
        replacementPublicId: REPLACEMENT_ID,
        status: phase,
        replacedFromPublicId: direction === "replacement" ? OLD_LOAN_ID : null,
        replacedToPublicId: direction === "old" ? DRAFT_LOAN_ID : null,
    };
}

function detail(publicId: string, phase: Phase) {
    const old = publicId === OLD_LOAN_ID;
    const status = phase === "initial"
        ? (old ? "active" : "draft")
        : phase === "executed"
            ? (old ? "replaced" : "active")
            : (old ? "active" : "cancelled");
    return {
        id: publicId,
        publicId,
        borrowerPublicId: BORROWER_ID,
        principalAmount: "36000.00",
        interestRate: "0.00",
        repaymentType: "daily",
        termMonths: 7,
        installmentAmount: "300.00",
        totalInstallments: 200,
        startDate: old ? "2026-07-12" : "2026-07-11",
        nextDueDate: status === "active" ? "2026-07-12" : null,
        outstandingPrincipal: status === "active" ? "36000.00" : "0.00",
        outstandingInterest: status === "active" && old ? "4200.00" : "0.00",
        outstandingFees: "0.00",
        status,
        replacementLineage: phase === "initial" ? null : lineage(phase, old ? "old" : "replacement"),
    };
}

function listRow(publicId: string, phase: Phase) {
    const loan = detail(publicId, phase);
    return {
        id: publicId,
        publicId,
        borrowerName: publicId === OLD_LOAN_ID ? "Source Borrower" : "Replacement Borrower",
        principal: loan.principalAmount,
        outstandingPrincipal: loan.outstandingPrincipal,
        interestReceived: "0.00",
        paidToDate: "0.00",
        status: loan.status,
        createdAt: publicId === OLD_LOAN_ID ? "2026-07-12T00:00:00.000Z" : "2026-07-11T00:00:00.000Z",
        repaymentType: loan.repaymentType,
        installmentAmount: loan.installmentAmount,
        totalInstallments: loan.totalInstallments,
        startDate: loan.startDate,
        paymentHealth: { status: "current", dueTodayAmount: "0.00", overdueAmount: "0.00", overdueItemCount: 0, maxOverdueDays: 0 },
    };
}

const preview = {
    schemaVersion: 1,
    publicId: REPLACEMENT_ID,
    previewHash: `v1:${"a".repeat(64)}`,
    oldBalanceVersion: `v1:${"b".repeat(64)}`,
    replacementDraftVersion: `v1:${"c".repeat(64)}`,
    expiresAt: "2099-07-11T09:00:00.000Z",
    asOfDate: "2026-07-11",
    reason: "Correct duplicated agreement",
    oldLoan: {
        loanPublicId: OLD_LOAN_ID, statusBefore: "active", statusAfter: "replaced", principal: "36000.00",
        collectibleBefore: { principal: "36000.00", interest: "4200.00", fee: "0.00", penalty: "0.00", nextDueDate: "2026-07-12" },
        collectibleAfter: { principal: "0.00", interest: "0.00", fee: "0.00", penalty: "0.00", nextDueDate: null },
    },
    cash: { direction: "none", amount: "0.00" },
    correction: { principal: "36000.00", interest: "4200.00", fee: "0.00", penalty: "0.00" },
    replacement: {
        loanPublicId: DRAFT_LOAN_ID, statusBefore: "draft", statusAfter: "active", principal: "36000.00", interestRate: "0.00",
        repaymentType: "daily", termMonths: 7, totalInstallments: 200, installmentAmount: "300.00",
        startDate: "2026-07-11", firstDueDate: "2026-07-12", lastDueDate: "2027-01-27", totalRepayment: "60000.00",
        fundingSourceKind: "drawdown", fundingSourcePublicId: "019ff023-fd64-7d41-9aae-723d2a458a8d", fundingSourceName: "TTB",
    },
    warnings: [{
        code: "OUTSTANDING_INTEREST_CORRECTED_TO_ZERO",
        details: { amount: "4200.00", correctedAmount: "0.00", collected: false, carriedForward: false },
    }],
};

function response(config: InternalAxiosRequestConfig, data: unknown, status = 200): AxiosResponse {
    return { data, status, statusText: status === 200 ? "OK" : "Error", headers: {}, config };
}

function AppRoutes() {
    const navigate = useNavigate();
    return <>
        <button type="button" onClick={() => navigate("/loans")}>All loans</button>
        <Routes>
            <Route path="/loans" element={<LoanList />} />
            <Route path="/loans/:id" element={<LoanDetail />} />
        </Routes>
    </>;
}

describe("loan replacement query integration", () => {
    const originalAdapter = api.defaults.adapter;
    let phase: Phase;
    let requests: Array<{ method: string; url: string; idempotencyKey: unknown }>;

    beforeEach(async () => {
        phase = "initial";
        requests = [];
        resetLoanQueryInvalidationForTests();
        localStorage.setItem("user", JSON.stringify({ id: 1, role: "owner" }));
        await appI18n.changeLanguage("en");
        api.defaults.adapter = async (config) => {
            const url = String(config.url);
            const method = String(config.method ?? "get").toLowerCase();
            requests.push({ method, url, idempotencyKey: config.headers?.["Idempotency-Key"] });
            if (method === "get" && url === "/loans") return response(config, [listRow(OLD_LOAN_ID, phase), listRow(DRAFT_LOAN_ID, phase)]);
            if (method === "get" && (url === `/loans/${OLD_LOAN_ID}` || url === `/loans/${DRAFT_LOAN_ID}`)) return response(config, detail(url.slice("/loans/".length), phase));
            if (method === "get" && url === `/borrowers/${BORROWER_ID}`) return response(config, { id: BORROWER_ID, publicId: BORROWER_ID, name: "Exact Borrower" });
            if (method === "get" && url.endsWith("/funding-allocations")) return response(config, []);
            if (method === "get" && url.endsWith("/allocation-state")) return response(config, { principalAmount: "36000.00", netAllocatedPrincipal: "36000.00", remainingGap: "0.00", overfundedAmount: "0.00", state: "fully_funded" });
            if (method === "get" && url.endsWith("/profitability")) return response(config, { borrowerRevenueCollected: "0.00", fundCostPaid: "0.00", realizedSpread: "0.00", unrealizedSpread: "0.00", fundedPrincipal: "36000.00", unallocatedPrincipalGap: "0.00", estimatedOutstandingFundingCost: "0.00", fundingShare: 1, fundingComposition: [] });
            if (method === "post" && url === "/loans/replacements/preview") return response(config, preview);
            if (method === "post" && url === `/loans/replacements/${REPLACEMENT_ID}/execute`) {
                phase = "executed";
                return response(config, { replacementPublicId: REPLACEMENT_ID, oldLoanPublicId: OLD_LOAN_ID, replacementLoanPublicId: DRAFT_LOAN_ID, status: "executed" });
            }
            if (method === "post" && url === `/loans/replacements/${REPLACEMENT_ID}/reverse`) {
                phase = "reversed";
                return response(config, { replacementPublicId: REPLACEMENT_ID, oldLoanPublicId: OLD_LOAN_ID, replacementLoanPublicId: DRAFT_LOAN_ID, status: "reversed" });
            }
            throw new Error(`Unexpected ${method.toUpperCase()} ${url}`);
        };
    });

    afterEach(() => {
        api.defaults.adapter = originalAdapter;
        localStorage.clear();
        vi.restoreAllMocks();
    });

    test("invalidates both details and lists, then preserves lineage-hydrated reversal across refetch and navigation", async () => {
        const user = userEvent.setup();
        render(<MemoryRouter initialEntries={[`/loans/${OLD_LOAN_ID}`]}><AppRoutes /></MemoryRouter>);

        expect(await screen.findByText(OLD_LOAN_ID)).toBeInTheDocument();
        await user.type(screen.getByLabelText(/replacement draft/i), DRAFT_LOAN_ID);
        await user.type(screen.getByLabelText(/^reason$/i), preview.reason);
        await user.click(screen.getByRole("button", { name: /preview replacement/i }));
        await user.click(await screen.findByLabelText(/confirm this exact replacement preview/i));
        await user.click(screen.getByRole("button", { name: /execute replacement/i }));

        await waitFor(() => expect(requests.filter((entry) => entry.url === `/loans/${OLD_LOAN_ID}`)).toHaveLength(2));
        expect(screen.getByText("Closed — Replaced")).toBeInTheDocument();
        expect(getLoanQueryRevision(loanListQueryKey)).toBe(1);
        expect(getLoanQueryRevision(loanDetailQueryKey(OLD_LOAN_ID))).toBe(1);
        expect(getLoanQueryRevision(loanDetailQueryKey(DRAFT_LOAN_ID))).toBe(1);

        await user.click(screen.getByRole("button", { name: "All loans" }));
        expect(await screen.findByText("Replacement Borrower")).toBeInTheDocument();
        expect(screen.queryByText("Source Borrower")).not.toBeInTheDocument();
        await user.click(screen.getByRole("tab", { name: "Done" }));
        const replacedCard = (await screen.findByText("Source Borrower")).closest("a")!;
        expect(within(replacedCard).getByText("Closed — Replaced")).toBeInTheDocument();
        expect(within(replacedCard).queryByText("PAID")).not.toBeInTheDocument();

        await user.click(replacedCard);
        expect(await screen.findByRole("button", { name: /reverse replacement/i })).toBeDisabled();
        await user.click(screen.getByRole("link", { name: /view replacement loan/i }));
        expect(await screen.findByText(DRAFT_LOAN_ID)).toBeInTheDocument();
        const reverse = screen.getByRole("button", { name: /reverse replacement/i });
        await user.type(screen.getByLabelText(/reversal reason/i), "Restore the authoritative agreement");
        await user.click(screen.getByLabelText(/confirm this compensating replacement reversal/i));
        await user.click(reverse);

        await waitFor(() => expect(requests.some((entry) => entry.method === "post" && entry.url.endsWith("/reverse") && typeof entry.idempotencyKey === "string")).toBe(true));
        await waitFor(() => expect(requests.filter((entry) => entry.url === `/loans/${DRAFT_LOAN_ID}`)).toHaveLength(2));
        expect(getLoanQueryRevision(loanListQueryKey)).toBe(2);
        expect(getLoanQueryRevision(loanDetailQueryKey(OLD_LOAN_ID))).toBe(2);
        expect(getLoanQueryRevision(loanDetailQueryKey(DRAFT_LOAN_ID))).toBe(2);
    }, 15_000);
});
