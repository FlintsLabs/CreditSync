import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import LoanWizard from "../src/pages/dashboard/loans/LoanWizard";
import { api } from "../src/lib/api";

vi.mock("../src/lib/api", () => ({ api: { get: vi.fn(), post: vi.fn() } }));

describe("LoanWizard", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        localStorage.clear();
        vi.mocked(api.get).mockResolvedValue({ data: [{
            id: "legacy-1",
            publicId: "11111111-1111-4111-8111-111111111111",
            name: "Exact Borrower",
        }] });
    });

    it("persists exactly the fixed daily terms that were previewed", async () => {
        const posted: Array<{ url: string; body: Record<string, unknown> }> = [];
        vi.mocked(api.post).mockImplementation(async (url, body) => {
            posted.push({ url, body: body as Record<string, unknown> });
            if (url === "/loans/preview") return { data: { schedule: [{
                installmentNo: 1,
                dueDate: "2026-08-11",
                amount: "99.99",
                principalComponent: "90.00",
                interestComponent: "9.99",
                remainingPrincipal: "910.00",
            }] } };
            if (url === "/loans") return { data: { publicId: "22222222-2222-4222-8222-222222222222" } };
            throw new Error(`Unexpected POST ${url}`);
        });

        const user = userEvent.setup();
        render(<LoanWizard />);
        const firstStepSelects = await screen.findAllByRole("combobox");
        await user.selectOptions(firstStepSelects[0]!, "11111111-1111-4111-8111-111111111111");
        await user.click(screen.getByRole("button", { name: /next/i }));

        const numberInputs = screen.getAllByRole("spinbutton");
        await user.type(numberInputs[0]!, "1000");
        await user.selectOptions(screen.getByRole("combobox"), "daily");
        const dailyInputs = screen.getAllByRole("spinbutton");
        await user.type(dailyInputs[3]!, "360");
        await user.type(dailyInputs[4]!, "3.20");
        await user.click(screen.getByRole("button", { name: /next/i }));
        await screen.findByText(/installment schedule preview/i);
        await user.click(screen.getByRole("button", { name: /save draft/i }));
        await waitFor(() => expect(posted.filter((call) => call.url === "/loans")).toHaveLength(1));

        const preview = posted.find((call) => call.url === "/loans/preview")!.body;
        const draft = posted.find((call) => call.url === "/loans")!.body;
        expect(draft).toMatchObject({
            borrowerPublicId: "11111111-1111-4111-8111-111111111111",
            principal: "1000.00",
            interestRate: "15.00",
            termMonths: 12,
            repaymentType: "daily",
            totalInstallments: 360,
            installmentAmount: "3.20",
        });
        for (const field of ["principal", "interestRate", "termMonths", "repaymentType", "startDate", "totalInstallments", "installmentAmount"]) {
            expect(draft[field]).toEqual(preview[field]);
        }
    });
});
