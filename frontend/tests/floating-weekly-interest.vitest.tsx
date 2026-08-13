import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import LoanWizard from "../src/pages/dashboard/loans/LoanWizard";
import { api } from "../src/lib/api";
import appI18n from "../src/lib/i18n";
import { FloatingInterestRateCard } from "../src/pages/dashboard/loans/FloatingInterestRateCard";

vi.mock("../src/lib/api", () => ({ api: { get: vi.fn(), post: vi.fn() } }));
vi.mock("../src/lib/session", () => ({ getStoredUser: () => null, isTenantAdminUser: () => false }));

const BORROWER_ID = "019ff023-fd64-7d41-9aae-723d2a458a8a";
const LOAN_ID = "019fea17-6068-7ccb-b267-9f39880bb762";

describe("weekly floating-loan origination", () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        localStorage.clear();
        await appI18n.changeLanguage("en");
        vi.mocked(api.get).mockResolvedValue({ data: [{ id: BORROWER_ID, publicId: BORROWER_ID, name: "Weekly Borrower" }] });
    });

    // Break caught: the browser sends the legacy daily policy or derives the approved payout instead of rendering backend strings.
    it("previews and persists the selected weekly 12% one-period advance policy", async () => {
        const posts: Array<{ url: string; body: unknown; config: unknown }> = [];
        vi.mocked(api.post).mockImplementation(async (url, body, config) => {
            posts.push({ url, body, config });
            if (url === "/loans/preview") return { data: {
                terms: { principal: "5000.00", interestRate: "0.00", repaymentType: "floating", termMonths: 12, startDate: "2026-08-14" },
                schedule: [],
                floatingInterestPolicy: { periodUnit: "week", periodLength: 1, rateMode: "percent", rate: "12.0000", advanceInterestPeriods: 1, advanceInterestRefundPolicy: "non_refundable" },
                fullPeriodInterest: "600.00",
                advanceInterest: "600.00",
                netBorrowerPayout: "4400.00",
                firstPeriodStartDate: "2026-08-14",
                firstPeriodDueDate: "2026-08-21",
                periodDays: 7,
            } };
            if (url === "/loans") return { data: { publicId: LOAN_ID } };
            if (url === `/loans/${LOAN_ID}/activate`) return { data: { publicId: LOAN_ID, status: "active" } };
            throw new Error(`Unexpected POST ${url}`);
        });

        const user = userEvent.setup();
        render(<LoanWizard />);
        await user.selectOptions((await screen.findAllByRole("combobox"))[0]!, BORROWER_ID);
        await user.click(screen.getByRole("button", { name: "Next" }));
        await user.click(screen.getByRole("radio", { name: "Floating (No fixed schedule)" }));
        await user.type(screen.getByLabelText("Principal Amount (฿)"), "5000");
        await user.click(screen.getByRole("radio", { name: "Weekly" }));
        await user.click(screen.getByRole("radio", { name: "Percent per period" }));
        await user.clear(screen.getByLabelText("Contract rate"));
        await user.type(screen.getByLabelText("Contract rate"), "12");
        await user.click(screen.getByRole("radio", { name: "Deduct one period in advance" }));
        await user.click(screen.getByRole("button", { name: "Next" }));

        const summary = await screen.findByRole("region", { name: "Floating interest summary" });
        expect(within(summary).getByText("Weekly")).toBeInTheDocument();
        expect(within(summary).getByText("12.0000% per week")).toBeInTheDocument();
        expect(within(summary).getAllByText(/600\.00$/)).toHaveLength(2);
        expect(within(summary).getByText(/4,400\.00$/)).toBeInTheDocument();
        expect(within(summary).getByText(/advance interest is non-refundable/i)).toBeInTheDocument();

        const previewBody = posts.find((call) => call.url === "/loans/preview")?.body;
        expect(previewBody).toMatchObject({
            principal: "5000.00",
            repaymentType: "floating",
            floatingInterestPolicy: {
                periodUnit: "week",
                periodLength: 1,
                rateMode: "percent",
                rate: "12",
                advanceInterestPeriods: 1,
                advanceInterestRefundPolicy: "non_refundable",
            },
        });

        await user.click(screen.getByRole("button", { name: "Save draft" }));
        await screen.findByText("Loan draft saved");
        expect(posts.find((call) => call.url === "/loans")?.body).toMatchObject({
            borrowerPublicId: BORROWER_ID,
            floatingInterestPolicy: (previewBody as { floatingInterestPolicy: unknown }).floatingInterestPolicy,
        });

        await user.click(screen.getByRole("button", { name: "Activate loan" }));
        await waitFor(() => expect(api.post).toHaveBeenCalledWith(
            `/loans/${LOAN_ID}/activate`,
            undefined,
            { headers: { "Idempotency-Key": expect.any(String) } },
        ));
    });

    // Break caught: weekly floating controls fall back to English while the active application language is Thai.
    it("localizes weekly policy controls in Thai", async () => {
        await appI18n.changeLanguage("th");
        const user = userEvent.setup();
        render(<LoanWizard />);
        await user.selectOptions((await screen.findAllByRole("combobox"))[0]!, BORROWER_ID);
        await user.click(screen.getByRole("button", { name: "ถัดไป" }));
        await user.click(screen.getByRole("radio", { name: "ลอยตัว (ไม่มีตารางตายตัว)" }));

        expect(screen.getByRole("radio", { name: "รายสัปดาห์" })).toBeInTheDocument();
        expect(screen.getByRole("radio", { name: "เปอร์เซ็นต์ต่อรอบ" })).toBeInTheDocument();
        expect(screen.getByRole("radio", { name: "หักล่วงหน้าหนึ่งรอบ" })).toBeInTheDocument();
        expect(screen.getByText(/ไม่คืนดอกเบี้ยที่หักล่วงหน้า/)).toBeInTheDocument();
    });
});

describe("weekly floating-loan rate timeline", () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        await appI18n.changeLanguage("en");
    });

    // Break caught: a weekly contractual rate is mislabeled as daily and the legacy daily-only projection is presented as authoritative.
    it("labels timeline rates by the locked weekly policy and hides the legacy daily projection", async () => {
        vi.mocked(api.get).mockResolvedValue({ data: {
            loanPublicId: LOAN_ID,
            asOfDate: "2026-08-17",
            earliestEditableDate: "2026-08-18",
            timelineVersion: "c".repeat(64),
            currentPeriod: { publicId: LOAN_ID, effectiveDate: "2026-08-14", expiryDate: null, rateType: "percent", rate: "12.0000" },
            dailyInterestAtCurrentPrincipal: "600.00",
            nextChange: null,
            timeline: [{ publicId: LOAN_ID, effectiveDate: "2026-08-14", expiryDate: null, rateType: "percent", rate: "12.0000" }],
        } });

        render(<FloatingInterestRateCard loanPublicId={LOAN_ID} periodUnit="week" />);

        expect(await screen.findAllByText("12.0000 % per week")).toHaveLength(2);
        expect(screen.queryByText(/600\.00/)).not.toBeInTheDocument();
    });
});
