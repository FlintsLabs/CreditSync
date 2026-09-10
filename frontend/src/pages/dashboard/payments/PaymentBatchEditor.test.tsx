import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import i18n from "../../../lib/i18n";
import { PaymentBatchEditor } from "./PaymentBatchEditor";

const apiMock = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("../../../lib/api", () => ({ api: apiMock }));

const workspace = { batchPublicId: "00000000-0000-4000-8000-000000000001", batch: { publicId: "00000000-0000-4000-8000-000000000001", version: 2, status: "needs_review", latestPreview: null }, items: [{ publicId: "00000000-0000-4000-8000-000000000002", clientItemKey: "client-1", revision: 1, paymentIntakePublicId: null, batchItemPublicId: null, amount: null, receivedAt: null, payerName: "Nok", evidenceStatus: "ready" }] };

function renderEditor() { return render(<I18nextProvider i18n={i18n}><PaymentBatchEditor onPreview={() => undefined} onExecute={() => undefined} /></I18nextProvider>); }

beforeEach(() => { localStorage.clear(); apiMock.get.mockReset(); apiMock.post.mockReset(); });

test("renders the localized atomic batch editor", () => {
    renderEditor();
    expect(screen.getByTestId("payment-batch-editor")).toBeTruthy();
    expect(screen.getByRole("heading", { name: /atomic payment batch/i })).toBeTruthy();
});

test("starts with named borrower review controls instead of manual UUID entry", () => {
    renderEditor();
    expect(screen.queryByPlaceholderText(/borrower uuid|resolved borrower uuid/i)).toBeNull();
    expect(screen.getByRole("button", { name: "Upload and review" })).toBeTruthy();
    expect(screen.getByText(/draft and review changes create no financial records/i)).toBeTruthy();
});

test("captures evidence before metadata review and does not invent amount or time", async () => {
    apiMock.post.mockImplementationOnce((_path: string, body: { items: Array<{ clientItemKey: string }> }) => Promise.resolve({ data: { batchPublicId: workspace.batchPublicId, items: [{ publicId: workspace.items[0].publicId, clientItemKey: body.items[0].clientItemKey, status: "staged" }] } }));
    apiMock.post.mockResolvedValueOnce({ data: { evidencePublicId: "00000000-0000-4000-8000-000000000003", status: "ready" } });
    apiMock.get.mockResolvedValue({ data: workspace });
    renderEditor();
    fireEvent.change(screen.getByLabelText("Choose payment slips"), { target: { files: [new File(["synthetic"], "slip.png", { type: "image/png" })] } });
    fireEvent.click(screen.getByRole("button", { name: "Upload and review" }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith("/payment-batches/stage", expect.objectContaining({ items: [expect.objectContaining({ clientItemKey: expect.any(String) })] })));
    expect(apiMock.post.mock.calls.some(([path]) => String(path).includes("/review"))).toBe(false);
});

test("requires explicit contract selection after named borrower selection", async () => {
    let stagedClientKey = "";
    apiMock.post.mockImplementationOnce((_path: string, body: { items: Array<{ clientItemKey: string }> }) => { stagedClientKey = body.items[0].clientItemKey; return Promise.resolve({ data: { batchPublicId: workspace.batchPublicId, items: [{ publicId: workspace.items[0].publicId, clientItemKey: stagedClientKey, status: "staged" }] } }); });
    apiMock.post.mockResolvedValueOnce({ data: { evidencePublicId: "00000000-0000-4000-8000-000000000003", status: "ready" } });
    apiMock.post.mockResolvedValueOnce({ data: { paymentIntakePublicId: "00000000-0000-4000-8000-000000000004", batchItemPublicId: "00000000-0000-4000-8000-000000000005" } });
    apiMock.get.mockImplementation((path: string) => path.includes("/candidates") ? Promise.resolve({ data: { stagingItemPublicId: workspace.items[0].publicId, stagingRevision: 2, batchRevision: 3, inputFingerprint: "v1:test", borrowerResolution: "unique", borrowerCandidates: [{ publicId: "00000000-0000-4000-8000-000000000006", name: "Nok", matchType: "canonical" }], contractCandidates: [{ borrowerPublicId: "00000000-0000-4000-8000-000000000006", borrowerName: "Nok", loanPublicId: "00000000-0000-4000-8000-000000000007", repaymentType: "scheduled", status: "active", eligible: true, eligibilityCode: null, startDate: "2026-09-01", principalAmount: "120.00", outstandingPrincipal: "120.00", dueComponents: { principal: "75.00", interest: "0.00", fee: "0.00", penalty: "0.00" }, proposalComponents: null, schedules: [{ publicId: "00000000-0000-4000-8000-000000000008", dueDate: "2026-09-10", status: "open", remainingDue: "75.00", components: { principal: "75.00", interest: "0.00", fee: "0.00", penalty: "0.00" } }] }, { borrowerPublicId: "00000000-0000-4000-8000-000000000006", borrowerName: "Nok", loanPublicId: "00000000-0000-4000-8000-000000000009", repaymentType: "floating", status: "active", eligible: true, eligibilityCode: null, startDate: "2026-09-01", principalAmount: "45.00", outstandingPrincipal: "45.00", dueComponents: { principal: "45.00", interest: "0.00", fee: "0.00", penalty: "0.00" }, proposalComponents: null, schedules: [] }], candidateLimitReached: false, reviewRequired: true } }) : Promise.resolve({ data: { ...workspace, items: [{ ...workspace.items[0], clientItemKey: stagedClientKey }] } }));
    renderEditor();
    const file = new File(["synthetic"], "slip.png", { type: "image/png" }); fireEvent.change(screen.getByLabelText("Choose payment slips"), { target: { files: [file] } });
    fireEvent.change(screen.getAllByRole("textbox")[0], { target: { value: "Nok" } }); fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "120.00" } }); fireEvent.change(screen.getByLabelText("Transfer date and time"), { target: { value: "2026-09-10T00:30" } }); fireEvent.change(screen.getByLabelText("Target due date"), { target: { value: "2026-09-10" } });
    fireEvent.click(screen.getByRole("button", { name: "Upload and review" })); await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith("/payment-batches/stage", expect.anything()));
    fireEvent.click(screen.getByRole("button", { name: /all slips uploaded and reviewed/i })); await waitFor(() => expect(screen.getByText(/candidate data ready|human review required/i)).toBeTruthy());
    fireEvent.change(screen.getByRole("combobox", { name: "Borrower candidate" }), { target: { value: "00000000-0000-4000-8000-000000000006" } });
    expect(screen.getByRole("button", { name: "Preview complete batch" }).hasAttribute("disabled")).toBe(true);
});
