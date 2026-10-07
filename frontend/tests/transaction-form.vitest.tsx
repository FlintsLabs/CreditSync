import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../src/lib/api";
import TransactionForm from "../src/pages/dashboard/transactions/TransactionForm";
import i18n from "../src/lib/i18n";

vi.mock("../src/lib/api", () => ({ api: { get: vi.fn(), post: vi.fn() } }));

const BORROWER_A = "019c3a5a-94ce-7f2c-8b08-f56852dca7a3";
const BORROWER_B = "019c3a5a-94ce-7f2c-8b08-f56852dca7a4";
const LOAN_A = "019c3a5a-94ce-7f2c-8b08-f56852dca7a5";
const LOAN_B = "019c3a5a-94ce-7f2c-8b08-f56852dca7a6";
const SCHEDULE_A = "019c3a5a-94ce-7f2c-8b08-f56852dca7a7";
const SCHEDULE_B = "019c3a5a-94ce-7f2c-8b08-f56852dca7a8";
const INTAKE = "019c3a5a-94ce-7f2c-8b08-f56852dca7a9";

// This test-only probe renders router state alongside the form.
// eslint-disable-next-line react-refresh/only-export-components
function LocationProbe() { return <output data-testid="location">{useLocation().pathname + useLocation().search}</output>; }
function renderAt(path: string) { return render(<MemoryRouter initialEntries={[path]}><TransactionForm /><LocationProbe /></MemoryRouter>); }

describe("TransactionForm", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        void i18n.changeLanguage("en");
        vi.mocked(api.get).mockImplementation(async (url) => {
            if (url === "/borrowers") return { data: [
                { publicId: BORROWER_A, name: "Borrower A" },
                { publicId: BORROWER_B, name: "Borrower B" },
            ] };
            if (url === "/loans") return { data: [
                { publicId: LOAN_A, borrowerPublicId: BORROWER_A, borrowerName: "Borrower A", principal: "100.00", status: "active" },
                { publicId: LOAN_B, borrowerPublicId: BORROWER_B, borrowerName: "Borrower B", principal: "200.00", repaymentType: "monthly", status: "active" },
            ] };
            if (url === `/loans/${LOAN_A}/schedule`) return { data: [{ id: SCHEDULE_A, publicId: SCHEDULE_A, installmentNo: 1, dueDate: "2026-10-07", remainingDue: "100.00", totalDueNow: "100.00", status: "pending" }] };
            if (url === `/loans/${LOAN_B}/schedule`) return { data: [{ id: SCHEDULE_B, publicId: SCHEDULE_B, installmentNo: 1, dueDate: "2026-10-07", remainingDue: "200.00", totalDueNow: "200.00", status: "pending" }] };
            throw new Error(`Unexpected GET ${url}`);
        });
    });

    test("filters active loan choices after selecting a borrower", async () => {
        const user = userEvent.setup();
        render(<MemoryRouter><TransactionForm /></MemoryRouter>);

        const borrowerSelect = await screen.findByLabelText("Borrower");
        const loanSelect = screen.getByLabelText("Select Loan Agreement");
        expect(loanSelect).toBeDisabled();
        await user.selectOptions(borrowerSelect, BORROWER_A);

        expect(within(loanSelect).getByRole("option", { name: /borrower a/i })).toBeInTheDocument();
        expect(within(loanSelect).queryByRole("option", { name: /borrower b/i })).not.toBeInTheDocument();
    });

    test("keeps independently editable allocation rows and derives the exact receipt total", async () => {
        const user = userEvent.setup();
        render(<MemoryRouter><TransactionForm /></MemoryRouter>);
        await screen.findByLabelText("Borrower");
        expect(screen.getByLabelText("Allocation amount 1")).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: /add contract/i }));
        expect(screen.getByLabelText("Borrower 2")).toBeInTheDocument();
        expect(screen.getByLabelText("Allocation amount 1")).toHaveValue("");
        expect(screen.getByLabelText("Allocation amount 2")).toHaveValue("");
        expect(screen.getByText((_, element) => element?.tagName === "P" && /0[,.]00/.test(element.textContent ?? ""))).toBeInTheDocument();
    });

    test("preselects the originating agreement and defaults payer independently", async () => {
        renderAt(`/transactions/new?loanId=${LOAN_A}`);
        await waitFor(() => expect(screen.getByLabelText("Borrower")).toHaveValue(BORROWER_A));
        expect(screen.getByLabelText("Select Loan Agreement")).toHaveValue(LOAN_A);
        expect(await screen.findByLabelText("Payer name")).toHaveValue("Borrower A");
        expect(await screen.findByLabelText("Installment")).toHaveValue(SCHEDULE_A);
    });

    test("submits two exact allocations as one review-first intake", async () => {
        const user = userEvent.setup();
        vi.mocked(api.post).mockImplementation(async (url) => ({ data: url === "/payment-intakes" ? { publicId: INTAKE, duplicate: false } : {} }));
        renderAt("/transactions/new");
        const firstBorrower = await screen.findByLabelText("Borrower");
        await user.selectOptions(firstBorrower, BORROWER_A);
        await waitFor(() => expect(screen.getByLabelText("Allocation amount 1")).toHaveValue("100.00"));
        await user.click(screen.getByRole("button", { name: "Add contract" }));
        await user.selectOptions(screen.getByLabelText("Borrower 2"), BORROWER_B);
        await waitFor(() => expect(screen.getByLabelText("Allocation amount 2")).toHaveValue("200.00"));
        await user.click(screen.getByRole("button", { name: "Review payment" }));
        await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(`/payments?intake=${INTAKE}`));
        const create = vi.mocked(api.post).mock.calls.find(([url]) => url === "/payment-intakes");
        const preview = vi.mocked(api.post).mock.calls.find(([url]) => String(url).endsWith("/match-preview"));
        expect(create?.[1]).toMatchObject({ amount: "300.00", payerName: null });
        expect(preview?.[1]).toEqual({ allocations: [
            { borrowerPublicId: BORROWER_A, loanPublicId: LOAN_A, schedulePublicId: SCHEDULE_A, amount: "100.00" },
            { borrowerPublicId: BORROWER_B, loanPublicId: LOAN_B, schedulePublicId: SCHEDULE_B, amount: "200.00" },
        ] });
        expect(vi.mocked(api.post).mock.calls.some(([url]) => String(url).endsWith("/post"))).toBe(false);
    });

    test("changes a row's borrower and contract independently, then removes only that row", async () => {
        const user = userEvent.setup();
        renderAt("/transactions/new");
        await user.selectOptions(await screen.findByLabelText("Borrower"), BORROWER_A);
        await waitFor(() => expect(screen.getByLabelText("Allocation amount 1")).toHaveValue("100.00"));
        await user.click(screen.getByRole("button", { name: "Add contract" }));
        await user.selectOptions(screen.getByLabelText("Borrower 2"), BORROWER_A);
        const secondLoan = () => screen.getAllByLabelText("Select Loan Agreement")[1]!;
        expect(secondLoan()).toHaveValue(LOAN_A);
        await user.selectOptions(screen.getByLabelText("Borrower 2"), BORROWER_B);
        await waitFor(() => expect(secondLoan()).toHaveValue(LOAN_B));
        await waitFor(() => expect(screen.getByLabelText("Allocation amount 2")).toHaveValue("200.00"));
        await user.click(screen.getByRole("button", { name: "Remove contract 2" }));
        expect(screen.queryByLabelText("Borrower 2")).not.toBeInTheDocument();
        expect(screen.getByLabelText("Allocation amount 1")).toHaveValue("100.00");
        expect(screen.getByRole("button", { name: "Review payment" })).toBeEnabled();
    });

    test("requires entered receipt amount to equal allocations when supporting files are attached", async () => {
        const user = userEvent.setup();
        vi.mocked(api.post).mockImplementation(async (url) => ({ data: url === "/payment-intakes" ? { publicId: INTAKE } : url.endsWith("upload-intents") ? { publicId: "evidence-1", uploadUrl: "https://signed.invalid", requiredHeaders: {} } : {} }));
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
        renderAt("/transactions/new");
        await user.selectOptions(await screen.findByLabelText("Borrower"), BORROWER_A);
        await waitFor(() => expect(screen.getByLabelText("Allocation amount 1")).toHaveValue("100.00"));
        await user.upload(screen.getByLabelText("Add supporting files"), new File(["mock-slip"], "receipt.png", { type: "image/png" }));
        const receiptAmount = await screen.findByLabelText("Slip / receipt amount (฿)");
        expect(screen.getByRole("button", { name: "Review payment" })).toBeDisabled();
        await user.type(receiptAmount, "99.00");
        expect(await screen.findByText(/Receipt amount must exactly match/i)).toBeInTheDocument();
        expect(api.post).not.toHaveBeenCalled();
        await user.clear(receiptAmount);
        await user.type(receiptAmount, "100.00");
        await user.click(screen.getByRole("button", { name: "Review payment" }));
        await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(`/payments?intake=${INTAKE}`));
        expect(api.post).toHaveBeenCalledWith("/payment-intakes", expect.objectContaining({ amount: "100.00", attachmentRequirement: { expectedCount: 1 } }), expect.any(Object));
    });

    test("formats amounts on blur and preserves row values across language changes", async () => {
        const user = userEvent.setup();
        renderAt("/transactions/new");
        await user.selectOptions(await screen.findByLabelText("Borrower"), BORROWER_A);
        const amount = await screen.findByLabelText("Allocation amount 1");
        await user.clear(amount);
        await user.type(amount, "1234.5");
        await user.tab();
        expect(amount).toHaveValue("1,234.50");
        await act(async () => { await i18n.changeLanguage("th"); });
        expect(screen.getByLabelText("ยอดจัดสรรรายการที่ 1")).toHaveValue("1,234.50");
        expect(screen.getByLabelText("ลูกหนี้")).toHaveValue(BORROWER_A);
    });

    test("uses Bangkok local receipt time and allows leaving a retained draft only after disclosure", async () => {
        const user = userEvent.setup();
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
        vi.mocked(api.post).mockImplementation(async (url) => ({ data: url === "/payment-intakes" ? { publicId: INTAKE } : url.endsWith("upload-intents") ? { publicId: "evidence-1", uploadUrl: "https://signed.invalid", requiredHeaders: {} } : {} }));
        renderAt(`/transactions/new?loanId=${LOAN_A}`);
        const localReceiptTime = await screen.findByLabelText("Received date and time (Bangkok)");
        expect((localReceiptTime as HTMLInputElement).value).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        await waitFor(() => expect(screen.getByLabelText("Allocation amount 1")).toHaveValue("100.00"));
        await user.upload(screen.getByLabelText("Add supporting files"), new File(["mock-slip"], "receipt.png", { type: "image/png" }));
        await user.type(await screen.findByLabelText("Slip / receipt amount (฿)"), "100.00");
        await user.click(screen.getByRole("button", { name: "Review payment" }));
        expect(await screen.findByText(/draft remains saved/i)).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Cancel" }));
        expect(screen.getByRole("dialog")).toBeInTheDocument();
        await user.keyboard("{Escape}");
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
        expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
        await user.click(screen.getByRole("button", { name: "Cancel" }));
        await user.click(screen.getByRole("button", { name: "Stay here" }));
        expect(screen.getByTestId("location")).toHaveTextContent("/transactions/new");
        await user.click(screen.getByRole("button", { name: "Cancel" }));
        await user.click(screen.getByRole("button", { name: "Leave form" }));
        expect(screen.getByTestId("location")).toHaveTextContent(`/loans/${LOAN_A}?tab=payments`);
    });

    test("ignores a delayed schedule response after its allocation changes contract", async () => {
        const user = userEvent.setup();
        let resolveA!: (value: { data: unknown[] }) => void;
        vi.mocked(api.get).mockImplementation((url) => {
            if (url === "/borrowers") return Promise.resolve({ data: [{ publicId: BORROWER_A, name: "Borrower A" }, { publicId: BORROWER_B, name: "Borrower B" }] });
            if (url === "/loans") return Promise.resolve({ data: [
                { publicId: LOAN_A, borrowerPublicId: BORROWER_A, borrowerName: "Borrower A", principal: "100.00", status: "active" },
                { publicId: LOAN_B, borrowerPublicId: BORROWER_B, borrowerName: "Borrower B", principal: "200.00", status: "active" },
            ] });
            if (url === `/loans/${LOAN_A}/schedule`) return new Promise((resolve) => { resolveA = resolve; });
            if (url === `/loans/${LOAN_B}/schedule`) return Promise.resolve({ data: [{ id: SCHEDULE_B, publicId: SCHEDULE_B, installmentNo: 1, dueDate: "2026-10-07", remainingDue: "200.00", totalDueNow: "200.00", status: "pending" }] });
            throw new Error(`Unexpected GET ${url}`);
        });
        renderAt("/transactions/new");
        const borrower = await screen.findByLabelText("Borrower");
        await user.selectOptions(borrower, BORROWER_A);
        await waitFor(() => expect(resolveA).toBeTypeOf("function"));
        await user.selectOptions(borrower, BORROWER_B);
        await waitFor(() => expect(screen.getByLabelText("Installment")).toHaveValue(SCHEDULE_B));
        await act(async () => { resolveA({ data: [{ id: SCHEDULE_A, publicId: SCHEDULE_A, installmentNo: 1, dueDate: "2026-10-07", remainingDue: "100.00", totalDueNow: "100.00", status: "pending" }] }); });
        expect(screen.getByLabelText("Installment")).toHaveValue(SCHEDULE_B);
        expect(within(screen.getByLabelText("Installment")).queryByRole("option", { name: new RegExp(SCHEDULE_A) })).not.toBeInTheDocument();
    });

    test("does not allow a duplicate intake target to enter retry progress", async () => {
        const user = userEvent.setup();
        vi.mocked(api.post).mockResolvedValue({ data: { publicId: INTAKE, duplicate: true, duplicateReason: "bank_reference" } });
        renderAt("/transactions/new");
        await screen.findByRole("option", { name: "Borrower A" });
        await user.selectOptions(await screen.findByLabelText("Borrower"), BORROWER_A);
        await waitFor(() => expect(screen.getByLabelText("Allocation amount 1")).toHaveValue("100.00"));
        await user.click(screen.getByRole("button", { name: "Review payment" }));
        expect(await screen.findByRole("link", { name: "Open receipt review" })).toHaveAttribute("href", `/payments?intake=${INTAKE}`);
        const reviewButton = screen.getByRole("button", { name: "Review payment" });
        expect(reviewButton).toBeDisabled();
        expect(api.post).toHaveBeenCalledTimes(1);
    });

    test("lets the operator correct duplicate local files before creating the receipt", async () => {
        const user = userEvent.setup();
        vi.mocked(api.post).mockImplementation(async (url) => ({ data: url === "/payment-intakes" ? { publicId: INTAKE } : url.endsWith("upload-intents") ? { publicId: "evidence-1", uploadUrl: "https://signed.invalid", requiredHeaders: {} } : {} }));
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
        renderAt("/transactions/new");
        await user.selectOptions(await screen.findByLabelText("Borrower"), BORROWER_A);
        await waitFor(() => expect(screen.getByLabelText("Allocation amount 1")).toHaveValue("100.00"));
        const input = screen.getByLabelText("Add supporting files");
        await user.upload(input, [new File(["same-content"], "one.png", { type: "image/png" }), new File(["same-content"], "two.png", { type: "image/png" })]);
        await user.type(await screen.findByLabelText("Slip / receipt amount (฿)"), "100.00");
        await user.click(screen.getByRole("button", { name: "Review payment" }));
        expect(await screen.findByText(/same supporting file was selected more than once/i)).toBeInTheDocument();
        expect(api.post).not.toHaveBeenCalled();
        await user.click(screen.getByRole("button", { name: "Remove two.png" }));
        await user.click(screen.getByRole("button", { name: "Review payment" }));
        await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(`/payments?intake=${INTAKE}`));
        expect(vi.mocked(api.post).mock.calls.filter(([url]) => url === "/payment-intakes")).toHaveLength(1);
    });

    test("unlocks preflight hashing errors so a local file can be corrected before create", async () => {
        const user = userEvent.setup();
        vi.mocked(api.post).mockImplementation(async (url) => ({ data: url === "/payment-intakes" ? { publicId: INTAKE } : url.endsWith("upload-intents") ? { publicId: "evidence-1", uploadUrl: "https://signed.invalid", requiredHeaders: {} } : {} }));
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
        const digest = vi.spyOn(crypto.subtle, "digest").mockRejectedValueOnce(new Error("local read failed"));
        renderAt("/transactions/new");
        await user.selectOptions(await screen.findByLabelText("Borrower"), BORROWER_A);
        await waitFor(() => expect(screen.getByLabelText("Allocation amount 1")).toHaveValue("100.00"));
        await user.upload(screen.getByLabelText("Add supporting files"), new File(["mock-slip"], "receipt.png", { type: "image/png" }));
        await user.type(await screen.findByLabelText("Slip / receipt amount (฿)"), "100.00");
        await user.click(screen.getByRole("button", { name: "Review payment" }));
        expect(await screen.findByText(/could not be checked locally/i)).toBeInTheDocument();
        expect(api.post).not.toHaveBeenCalled();
        expect(screen.getByRole("button", { name: "Review payment" })).toBeEnabled();
        await user.click(screen.getByRole("button", { name: "Review payment" }));
        await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(`/payments?intake=${INTAKE}`));
        expect(digest).toHaveBeenCalledTimes(2);
    });

    test("retries a failed evidence upload on the same intake and does not recreate it", async () => {
        const user = userEvent.setup();
        vi.mocked(api.post).mockImplementation(async (url) => ({ data: url === "/payment-intakes" ? { publicId: INTAKE } : url.endsWith("upload-intents") ? { publicId: "evidence-1", uploadUrl: "https://signed.invalid", requiredHeaders: {} } : {} }));
        let putCount = 0;
        vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => ({ ok: ++putCount > 1 })));
        renderAt("/transactions/new");
        await user.selectOptions(await screen.findByLabelText("Borrower"), BORROWER_A);
        await waitFor(() => expect(screen.getByLabelText("Allocation amount 1")).toHaveValue("100.00"));
        await user.upload(screen.getByLabelText("Add supporting files"), new File(["mock-slip"], "receipt.png", { type: "image/png" }));
        await user.type(await screen.findByLabelText("Slip / receipt amount (฿)"), "100.00");
        await user.click(screen.getByRole("button", { name: "Review payment" }));
        expect(await screen.findByText(/evidence upload failed/i)).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Retry saved receipt" })).toBeEnabled();
        await user.click(screen.getByRole("button", { name: "Retry saved receipt" }));
        await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(`/payments?intake=${INTAKE}`));
        expect(vi.mocked(api.post).mock.calls.filter(([url]) => url === "/payment-intakes")).toHaveLength(1);
        expect(putCount).toBe(2);
    });

    test("shows a fixed-schedule-free floating allocation", async () => {
        vi.mocked(api.get).mockImplementation(async (url) => {
            if (url === "/borrowers") return { data: [{ publicId: BORROWER_B, name: "Borrower B" }] };
            if (url === "/loans") return { data: [{ publicId: LOAN_B, borrowerPublicId: BORROWER_B, borrowerName: "Borrower B", principal: "200.00", repaymentType: "floating", status: "active" }] };
            throw new Error(`Unexpected GET ${url}`);
        });
        renderAt("/transactions/new");
        await userEvent.setup().selectOptions(await screen.findByLabelText("Borrower"), BORROWER_B);
        expect(await screen.findByText(/floating-interest loans have no fixed installments/i)).toBeInTheDocument();
        expect(screen.queryByLabelText("Installment")).not.toBeInTheDocument();
    });
    test("keeps the full 29-digit receipt difference including cents", async () => {
        const user = userEvent.setup();
        renderAt(`/transactions/new?loanId=${LOAN_A}`);
        await waitFor(() => expect(screen.getByLabelText("Allocation amount 1")).toHaveValue("100.00"));
        await user.upload(screen.getByLabelText("Add supporting files"), new File(["fixture"], "receipt.png", { type: "image/png" }));
        await user.type(await screen.findByLabelText("Slip / receipt amount (฿)"), "12345678901234567890123456789.12");
        expect(screen.getByText(/^Difference:/)).toHaveTextContent("12,345,678,901,234,567,890,123,456,689.12");
        expect(screen.getByRole("button", { name: "Review payment" })).toBeDisabled();
    });

    test("opens the owned saved draft after a transport error in evidence preparation", async () => {
        const user = userEvent.setup();
        vi.mocked(api.post).mockImplementation(async (url) => {
            if (url === "/payment-intakes") return { data: { publicId: INTAKE, duplicate: false } };
            throw new Error("transport broke");
        });
        renderAt(`/transactions/new?loanId=${LOAN_A}`);
        await waitFor(() => expect(screen.getByLabelText("Allocation amount 1")).toHaveValue("100.00"));
        await user.upload(screen.getByLabelText("Add supporting files"), new File(["fixture"], "receipt.png", { type: "image/png" }));
        await user.type(await screen.findByLabelText("Slip / receipt amount (฿)"), "100.00");
        await user.click(screen.getByRole("button", { name: "Review payment" }));
        expect(await screen.findByRole("link", { name: "Open saved draft" })).toHaveAttribute("href", `/payments?intake=${INTAKE}`);
        expect(screen.getByRole("alert")).not.toHaveTextContent("transport broke");
    });

    test("warns before leaving when receipt creation has an unknown outcome", async () => {
        const user = userEvent.setup();
        vi.mocked(api.post).mockRejectedValue(new Error("connection lost"));
        renderAt(`/transactions/new?loanId=${LOAN_A}`);
        await waitFor(() => expect(screen.getByLabelText("Allocation amount 1")).toHaveValue("100.00"));
        await user.click(screen.getByRole("button", { name: "Review payment" }));
        await screen.findByRole("alert");
        await user.click(screen.getByRole("button", { name: "Cancel" }));
        expect(await screen.findByRole("dialog")).toHaveTextContent(/outcome.*unknown/i);
        expect(screen.getByTestId("location")).toHaveTextContent("/transactions/new");
        await user.keyboard("{Escape}");
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    });

});
