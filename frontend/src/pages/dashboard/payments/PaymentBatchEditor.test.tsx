import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import i18n from "../../../lib/i18n";
import { PaymentBatchEditor } from "./PaymentBatchEditor";

const apiMock = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("../../../lib/api", () => ({ api: apiMock }));

const workspace = { batchPublicId: "00000000-0000-4000-8000-000000000001", batch: { publicId: "00000000-0000-4000-8000-000000000001", version: 2, status: "needs_review", latestPreview: null }, items: [{ publicId: "00000000-0000-4000-8000-000000000002", clientItemKey: "client-1", revision: 1, paymentIntakePublicId: null, batchItemPublicId: null, amount: "120.00", receivedAt: "2026-09-09T17:30:00.000Z", payerName: "Nok", evidenceStatus: "ready" }] };

function renderEditor() { return render(<I18nextProvider i18n={i18n}><PaymentBatchEditor onPreview={() => undefined} onExecute={() => undefined} /></I18nextProvider>); }

beforeEach(() => { localStorage.clear(); apiMock.get.mockReset(); apiMock.post.mockReset(); });
afterEach(() => { vi.restoreAllMocks(); });

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
    apiMock.get.mockImplementation((path: string) => path.includes("/candidates") ? Promise.resolve({ data: { stagingItemPublicId: workspace.items[0].publicId, stagingRevision: 2, batchRevision: 3, inputFingerprint: "v1:test", borrowerResolution: "unique", borrowerCandidates: [{ publicId: "00000000-0000-4000-8000-000000000006", name: "Nok", matchType: "canonical" }], contractCandidates: [{ borrowerPublicId: "00000000-000000-4000-8000-000000000006", borrowerName: "Nok", loanPublicId: "00000000-0000-4000-8000-000000000007", repaymentType: "scheduled", status: "active", eligible: true, eligibilityCode: null, startDate: "2026-09-01", principalAmount: "120.00", outstandingPrincipal: "120.00", dueComponents: { principal: "75.00", interest: "0.00", fee: "0.00", penalty: "0.00" }, proposalComponents: null, schedules: [{ publicId: "00000000-0000-4000-8000-000000000008", dueDate: "2026-09-10", status: "open", remainingDue: "75.00", components: { principal: "75.00", interest: "0.00", fee: "0.00", penalty: "0.00" } }] }, { borrowerPublicId: "00000000-0000-4000-8000-000000000006", borrowerName: "Nok", loanPublicId: "00000000-0000-4000-8000-000000000009", repaymentType: "floating", status: "active", eligible: true, eligibilityCode: null, startDate: "2026-09-01", principalAmount: "45.00", outstandingPrincipal: "45.00", dueComponents: { principal: "45.00", interest: "0.00", fee: "0.00", penalty: "0.00" }, proposalComponents: null, schedules: [] }], candidateLimitReached: false, reviewRequired: true } }) : Promise.resolve({ data: { ...workspace, items: [{ ...workspace.items[0], clientItemKey: stagedClientKey, paymentIntakePublicId: apiMock.post.mock.calls.some(([requestPath]) => String(requestPath).includes("/review")) ? "00000000-0000-4000-8000-000000000004" : null, batchItemPublicId: apiMock.post.mock.calls.some(([requestPath]) => String(requestPath).includes("/review")) ? "00000000-0000-4000-8000-000000000005" : null }] } }));
    renderEditor();
    const file = new File(["synthetic"], "slip.png", { type: "image/png" }); fireEvent.change(screen.getByLabelText("Choose payment slips"), { target: { files: [file] } });
    fireEvent.change(screen.getAllByRole("textbox")[0], { target: { value: "Nok" } }); fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "120.00" } }); fireEvent.change(screen.getByLabelText("Transfer date and time"), { target: { value: "2026-09-10T00:30" } }); fireEvent.change(screen.getByLabelText("Target due date"), { target: { value: "2026-09-10" } });
    fireEvent.click(screen.getByRole("button", { name: "Upload and review" })); await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith("/payment-batches/stage", expect.anything()));
    fireEvent.click(screen.getByRole("button", { name: /all slips uploaded and reviewed/i })); await waitFor(() => expect(screen.getByText(/candidate data ready|human review required/i)).toBeTruthy());
    fireEvent.change(screen.getByRole("combobox", { name: "Borrower candidate" }), { target: { value: "00000000-0000-4000-8000-000000000006" } });
    expect(screen.getByRole("button", { name: "Preview complete batch" }).hasAttribute("disabled")).toBe(true);
});

test("hydrates only matching stable keys and clears unknown server membership", async () => {
    localStorage.setItem("creditsync.paymentBatch.workspace:anonymous:anonymous:batch-id", workspace.batchPublicId);
    localStorage.setItem("creditsync.paymentBatch.workspace:anonymous:draft", JSON.stringify([{ id: "known-key", amount: "999.00", targetDueDate: "2026-09-01", receivedAt: "2026-09-01T00:00", selectedBorrowerPublicId: "borrower-old", allocations: [{ loanPublicId: "loan-old", amount: "999.00" }] }]));
    apiMock.get.mockResolvedValue({ data: { ...workspace, items: [{ ...workspace.items[0], clientItemKey: "server-replacement", amount: null, receivedAt: null, evidenceStatus: null }] } });
    renderEditor();
    await waitFor(() => expect((screen.getByLabelText("Amount") as HTMLInputElement).value).toBe(""));
    expect((screen.getByLabelText("Amount") as HTMLInputElement).value).toBe("");
    expect(screen.queryByText("borrower-old")).toBeNull();
});

test("keeps a pending resumed row selectable for file reselection", async () => {
    localStorage.setItem("creditsync.paymentBatch.workspace:anonymous:anonymous:batch-id", workspace.batchPublicId);
    apiMock.get.mockResolvedValue({ data: { ...workspace, items: [{ ...workspace.items[0], clientItemKey: "pending-key", evidenceStatus: null }] } });
    renderEditor();
    await waitFor(() => expect((screen.getByLabelText("Choose payment slips") as HTMLInputElement).disabled).toBe(false));
});

test("fails closed when evidence prepare has no upload URL", async () => {
    let stagedClientKey = "";
    apiMock.post.mockImplementation((path: string, body?: { items?: Array<{ clientItemKey: string }> }) => path === "/payment-batches/stage" ? (stagedClientKey = body!.items![0].clientItemKey, Promise.resolve({ data: { batchPublicId: workspace.batchPublicId, items: [{ publicId: workspace.items[0].publicId, clientItemKey: stagedClientKey, status: "staged" }] } })) : Promise.resolve({ data: { evidencePublicId: "00000000-0000-4000-8000-000000000003", status: "pending" } }));
    apiMock.get.mockImplementation(() => Promise.resolve({ data: { ...workspace, items: [{ ...workspace.items[0], clientItemKey: stagedClientKey, evidenceStatus: null }] } }));
    renderEditor();
    fireEvent.change(screen.getByLabelText("Choose payment slips"), { target: { files: [new File(["synthetic"], "slip.png", { type: "image/png" })] } });
    fireEvent.click(screen.getByRole("button", { name: "Upload and review" }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(apiMock.post.mock.calls.some(([path]) => String(path).includes("/evidence/finalize"))).toBe(false);
});

test("renders the split destination response and exact moved membership", async () => {
    const source = { ...workspace, items: [{ ...workspace.items[0], clientItemKey: "split-key", batchItemPublicId: "00000000-0000-4000-8000-000000000005", paymentIntakePublicId: "00000000-0000-4000-8000-000000000004" }] };
    const destinationId = "00000000-0000-4000-8000-000000000012";
    localStorage.setItem("creditsync.paymentBatch.workspace:anonymous:anonymous:batch-id", workspace.batchPublicId);
    apiMock.get.mockImplementation((path: string) => Promise.resolve({ data: path.includes(destinationId) ? { ...workspace, batchPublicId: destinationId, batch: { ...workspace.batch, publicId: destinationId }, items: [{ ...workspace.items[0], publicId: "00000000-0000-4000-8000-000000000013", clientItemKey: "split-key" }] } : source }));
    apiMock.post.mockResolvedValue({ data: { sourceBatchPublicId: workspace.batchPublicId, destinationBatchPublicId: destinationId, dependencyPublicId: "00000000-0000-4000-8000-000000000014", movedItemPublicIds: [source.items[0].batchItemPublicId], auditPublicId: "00000000-0000-4000-8000-000000000015", correlationId: "00000000-0000-4000-8000-000000000016" } });
    vi.spyOn(window, "prompt").mockReturnValue("split synthetic");
    renderEditor();
    await waitFor(() => expect(screen.getAllByRole("checkbox").some((input) => !input.hasAttribute("disabled"))).toBe(true));
    fireEvent.click(screen.getAllByRole("checkbox").find((input) => !input.hasAttribute("disabled"))!); fireEvent.click(screen.getByRole("button", { name: "Split held items" }));
    await waitFor(() => expect(screen.getByTestId("payment-batch-split-result").textContent).toContain(destinationId));
    expect(screen.getByTestId("payment-batch-split-result").textContent).toContain("00000000-0000-4000-8000-000000000013");
});

test("cancel clears the old batch operation keys before starting a new draft", async () => {
    const scope = "creditsync.paymentBatch.workspace:anonymous:anonymous";
    const oldKey = "old-execute-key";
    localStorage.setItem(`${scope}:batch-id`, workspace.batchPublicId); localStorage.setItem(`${scope}:execute-key:${workspace.batchPublicId}`, oldKey);
    apiMock.get.mockResolvedValue({ data: workspace });
    apiMock.post.mockResolvedValue({ data: { batchPublicId: workspace.batchPublicId, status: "cancelled", auditPublicId: "00000000-0000-4000-8000-000000000017", correlationId: "00000000-0000-4000-8000-000000000018" } });
    vi.spyOn(window, "prompt").mockReturnValue("cancel synthetic");
    renderEditor();
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel batch" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Cancel batch" }));
    await waitFor(() => expect(localStorage.getItem(`${scope}:batch-id`)).toBeNull());
    expect(localStorage.getItem(`${scope}:execute-key:${workspace.batchPublicId}`)).toBeNull();
    expect(localStorage.getItem(`${scope}:execute-key:draft`)).not.toBe(oldKey);
    expect(screen.getByTestId("payment-batch-receipt").textContent).toContain("00000000-0000-4000-8000-000000000017");
});

test("does not let delayed hydration overwrite a user edit", async () => {
    const scope = "creditsync.paymentBatch.workspace:anonymous:anonymous";
    let resolveHydration!: (value: { data: typeof workspace }) => void;
    const deferred = new Promise<{ data: typeof workspace }>((resolve) => { resolveHydration = resolve; });
    apiMock.get.mockReturnValueOnce(deferred);
    localStorage.setItem(`${scope}:batch-id`, workspace.batchPublicId);
    localStorage.setItem(`${scope}:draft`, JSON.stringify([{ id: "edit-key", amount: "10.00", targetDueDate: "2026-09-10", receivedAt: "2026-09-10T00:30", paymentIntakePublicId: "", intent: "on_time" }]));
    renderEditor();
    await waitFor(() => expect(apiMock.get).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "77.00" } });
    resolveHydration({ data: { ...workspace, items: [{ ...workspace.items[0], clientItemKey: "edit-key", amount: null as unknown as string }] } });
    await waitFor(() => expect((screen.getByLabelText("Amount") as HTMLInputElement).value).toBe("77.00"));
    void deferred;
});

test("renders backend preview sequence and components without raw JSON", async () => {
    const scope = "creditsync.paymentBatch.workspace:anonymous:anonymous";
    const preview = { publicId: "00000000-0000-4000-8000-000000000020", status: "ready", version: 4, previewHash: "hash", confirmationHash: "confirm", evidenceReady: true, allocations: [{ itemPublicId: "item-09", borrowerPublicId: "borrower", loanPublicId: "loan-a", amount: "75.00", targetDueDate: "2026-09-09", intent: "on_time", calculatedComponents: { principal: "50.00", interest: "20.00", fee: "5.00", penalty: "0.00" } }, { itemPublicId: "item-07", borrowerPublicId: "borrower", loanPublicId: "loan-b", amount: "45.00", targetDueDate: "2026-09-07", intent: "on_time", calculatedComponents: { principal: "40.00", interest: "5.00", fee: "0.00", penalty: "0.00" } }], candidates: [], warnings: [] };
    localStorage.setItem(`${scope}:batch-id`, workspace.batchPublicId);
    apiMock.get.mockResolvedValue({ data: { ...workspace, batch: { ...workspace.batch, latestPreview: preview }, items: [{ ...workspace.items[0], clientItemKey: "preview-key", batchItemPublicId: "batch-item" }] } });
    localStorage.setItem(`${scope}:draft`, JSON.stringify([{ id: "preview-key", amount: "120.00", targetDueDate: "2026-09-09", receivedAt: "2026-09-09T00:30", paymentIntakePublicId: "intake", loanPublicId: "loan-a", selectedBorrowerPublicId: "borrower", intent: "on_time" }]));
    renderEditor();
    const output = await waitFor(() => screen.getByTestId("payment-batch-preview"));
    expect(output.textContent).toContain("Sequence 1");
    expect(output.textContent).toContain("principal 50.00");
    expect(output.textContent).toContain("interest 20.00");
    expect(output.textContent).not.toContain("{\"principal\"");
});

test("blocks preview until a reviewed edit is persisted", async () => {
    const scope = "creditsync.paymentBatch.workspace:anonymous:anonymous";
    localStorage.setItem(`${scope}:batch-id`, workspace.batchPublicId);
    localStorage.setItem(`${scope}:draft`, JSON.stringify([{ id: "reviewed-key", amount: "120.00", targetDueDate: "2026-09-10", receivedAt: "2026-09-10T00:30", paymentIntakePublicId: "intake", loanPublicId: "loan", selectedBorrowerPublicId: "borrower", intent: "on_time" }]));
    apiMock.get.mockResolvedValue({ data: { ...workspace, items: [{ ...workspace.items[0], clientItemKey: "reviewed-key", paymentIntakePublicId: "intake", batchItemPublicId: "batch-item", revision: 3 }] } });
    renderEditor();
    await waitFor(() => expect(screen.getByRole("button", { name: "Preview complete batch" })).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "121.00" } });
    expect((screen.getByRole("button", { name: "Preview complete batch" }) as HTMLButtonElement).disabled).toBe(true);
});

test("reuses the batch-scoped execute key after remount and committed response loss", async () => {
    const scope = "creditsync.paymentBatch.workspace:anonymous:anonymous";
    const executeKey = "stable-execute-key";
    const preview = { publicId: "00000000-0000-4000-8000-000000000030", status: "ready", version: 5, previewHash: "hash", confirmationHash: "confirm", evidenceReady: true, allocations: [{ itemPublicId: "item", borrowerPublicId: "borrower", loanPublicId: "loan", amount: "10.00", targetDueDate: "2026-09-10", intent: "on_time", calculatedComponents: { principal: "10.00", interest: "0.00", fee: "0.00", penalty: "0.00" } }], candidates: [], warnings: [] };
    localStorage.setItem(`${scope}:batch-id`, workspace.batchPublicId);
    localStorage.setItem(`${scope}:execute-key:${workspace.batchPublicId}`, executeKey);
    localStorage.setItem(`${scope}:draft`, JSON.stringify([{ id: "execute-key", amount: "10.00", targetDueDate: "2026-09-10", receivedAt: "2026-09-10T00:30", paymentIntakePublicId: "intake", batchItemPublicId: "item", loanPublicId: "loan", selectedBorrowerPublicId: "borrower", allocations: [{ loanPublicId: "loan", amount: "10.00" }], intent: "on_time" }]));
    apiMock.get.mockResolvedValue({ data: { ...workspace, batch: { ...workspace.batch, latestPreview: preview }, items: [{ ...workspace.items[0], clientItemKey: "execute-key", paymentIntakePublicId: "intake", batchItemPublicId: "item" }] } });
    apiMock.post.mockResolvedValue({ data: { receipt: { receiptPublicId: "receipt", auditPublicId: "audit", correlationId: "correlation" } } });
    const first = renderEditor();
    await waitFor(() => expect(screen.getByTestId("payment-batch-preview")).toBeTruthy());
    fireEvent.click(screen.getByLabelText(/I reviewed the complete batch preview/i)); fireEvent.click(screen.getByRole("button", { name: "Execute batch" }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith(`/payment-batches/${workspace.batchPublicId}/execute`, expect.objectContaining({ idempotencyKey: executeKey })));
    first.unmount();
    renderEditor();
    await waitFor(() => expect(screen.getByTestId("payment-batch-preview")).toBeTruthy());
    fireEvent.click(screen.getByLabelText(/I reviewed the complete batch preview/i)); fireEvent.click(screen.getByRole("button", { name: "Execute batch" }));
    await waitFor(() => expect(apiMock.post.mock.calls.filter(([path]) => String(path).endsWith("/execute"))).toHaveLength(2));
    expect(apiMock.post.mock.calls[1][1]).toMatchObject({ idempotencyKey: executeKey });
});

test("retries a failed finalize with the same staged membership and skips staging", async () => {
    let stagedClientKey = "";
    let finalizeCalls = 0;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    apiMock.post.mockImplementation((path: string, body?: { items?: Array<{ clientItemKey: string }> }) => {
        if (path === "/payment-batches/stage") { stagedClientKey = body!.items![0].clientItemKey; return Promise.resolve({ data: { batchPublicId: workspace.batchPublicId, items: [{ publicId: workspace.items[0].publicId, clientItemKey: stagedClientKey, status: "staged" }] } }); }
        if (path.includes("/evidence/prepare")) return Promise.resolve({ data: { evidencePublicId: "00000000-0000-4000-8000-000000000040", status: "pending", uploadUrl: "https://upload.synthetic.test" } });
        if (path.includes("/evidence/finalize")) { finalizeCalls += 1; return finalizeCalls === 1 ? Promise.reject(new Error("synthetic finalize failure")) : Promise.resolve({ data: { status: "ready" } }); }
        return Promise.resolve({ data: {} });
    });
    apiMock.get.mockImplementation(() => Promise.resolve({ data: { ...workspace, items: [{ ...workspace.items[0], clientItemKey: stagedClientKey, evidenceStatus: finalizeCalls > 1 ? "ready" : null }] } }));
    renderEditor();
    fireEvent.change(screen.getByLabelText("Choose payment slips"), { target: { files: [new File(["synthetic"], "retry.png", { type: "image/png" })] } });
    fireEvent.click(screen.getByRole("button", { name: "Upload and review" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Retry failed file" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Retry failed file" }));
    await waitFor(() => expect(finalizeCalls).toBe(2));
    expect(apiMock.post.mock.calls.filter(([path]) => path === "/payment-batches/stage")).toHaveLength(1);
    expect(apiMock.post.mock.calls.filter(([path]) => String(path).includes("/evidence/prepare"))).toHaveLength(2);
    expect(apiMock.post.mock.calls.filter(([path]) => String(path).includes("/evidence/prepare"))[0][0]).toContain(workspace.items[0].publicId);
});
