import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../src/lib/api";
import PaymentInbox from "../src/pages/dashboard/payments/PaymentInbox";

vi.mock("../src/lib/api", () => ({ api: { get: vi.fn(), post: vi.fn() }, resolveFileAccess: vi.fn() }));
const intakeId = "019c3a5a-94ce-7f2c-8b08-f56852dca7a1";
const hash = "a".repeat(64);
const intake = { publicId: intakeId, status: "needs_review", amount: "30.30", receivedAt: "2026-09-11T09:30:00.000Z", payerName: "Review fixture", warnings: [], evidence: [], latestProposal: null, cancellation: { allowed: true, stateHash: hash, blockedReason: null, batchPublicId: null } };

async function openCancellation() {
    const user = userEvent.setup();
    render(<MemoryRouter><PaymentInbox /></MemoryRouter>);
    await user.click(await screen.findByRole("button", { name: /^Review fixture/ }));
    await user.click(await screen.findByRole("button", { name: "Cancel intake" }));
    return { user, dialog: await screen.findByRole("dialog", { name: "Cancel payment intake" }) };
}

describe("independent cancellation acceptance", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(api.get).mockImplementation(async (url) => {
            if (url === "/payment-intakes") return { data: { items: [intake], page: 1, pageSize: 25, total: 1, totalPages: 1 } };
            if (url === "/loans" || url === "/audit-logs") return { data: [] };
            if (url === `/payment-intakes/${intakeId}`) return { data: intake };
            throw new Error(`Unexpected request: ${url}`);
        });
        vi.mocked(api.post).mockRejectedValue(new Error("Response lost"));
    });

    test("shows the amount of the exact target inside confirmation", async () => {
        const { dialog } = await openCancellation();
        expect(within(dialog).getByText(/30\.30/)).toBeInTheDocument();
        expect(api.post).not.toHaveBeenCalled();
        expect(within(dialog).getByRole("button", { name: "Confirm cancellation" })).toBeDisabled();
    });

    test("reuses the exact command on uncertain-response retry", async () => {
        const { user, dialog } = await openCancellation();
        await user.type(within(dialog).getByLabelText("Reason"), "Entered twice");
        await user.click(within(dialog).getByRole("button", { name: "Confirm cancellation" }));
        await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
        await waitFor(() => expect(within(dialog).getByRole("button", { name: "Confirm cancellation" })).toBeEnabled());
        await user.click(within(dialog).getByRole("button", { name: "Confirm cancellation" }));
        await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
        expect(vi.mocked(api.post).mock.calls[1]).toEqual(vi.mocked(api.post).mock.calls[0]);
        expect(vi.mocked(api.post).mock.calls[0]?.[1]).toMatchObject({ reason: "Entered twice", expectedStateHash: hash });
    });

    test("uses a new command key when a newly confirmed reason changes", async () => {
        const { user, dialog } = await openCancellation();
        const reason = within(dialog).getByLabelText("Reason");
        await user.type(reason, "Entered twice");
        await user.click(within(dialog).getByRole("button", { name: "Confirm cancellation" }));
        await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
        await waitFor(() => expect(within(dialog).getByRole("button", { name: "Confirm cancellation" })).toBeEnabled());
        await user.clear(reason);
        await user.type(reason, "Wrong borrower selected");
        await user.click(within(dialog).getByRole("button", { name: "Confirm cancellation" }));
        await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
        const first = vi.mocked(api.post).mock.calls[0]?.[1] as { idempotencyKey: string };
        const second = vi.mocked(api.post).mock.calls[1]?.[1] as { idempotencyKey: string };
        expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
    });

    test("keeps an uncertain request recoverable when the dialog is reopened", async () => {
        const { user, dialog } = await openCancellation();
        await user.type(within(dialog).getByLabelText("Reason"), "Entered twice");
        await user.click(within(dialog).getByRole("button", { name: "Confirm cancellation" }));
        await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
        await waitFor(() => expect(within(dialog).getByRole("button", { name: "Cancel", exact: true })).toBeEnabled());
        await user.click(within(dialog).getByRole("button", { name: "Cancel", exact: true }));
        await user.click(screen.getByRole("button", { name: "Cancel intake" }));
        const reopened = await screen.findByRole("dialog", { name: "Cancel payment intake" });
        const reason = within(reopened).getByLabelText("Reason");
        await user.clear(reason);
        await user.type(reason, "Entered twice");
        await user.click(within(reopened).getByRole("button", { name: "Confirm cancellation" }));
        await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
        expect(vi.mocked(api.post).mock.calls[1]).toEqual(vi.mocked(api.post).mock.calls[0]);
    });

    test("keeps a visible review-required explanation after stale-state refresh", async () => {
        vi.mocked(api.post).mockRejectedValue({ response: { status: 409, data: { code: "PAYMENT_CANCEL_STALE" } } });
        const { user, dialog } = await openCancellation();
        await user.type(within(dialog).getByLabelText("Reason"), "Entered twice");
        await user.click(within(dialog).getByRole("button", { name: "Confirm cancellation" }));
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
        expect(await screen.findByText(/This intake changed\. Review it again before cancelling\./)).toBeInTheDocument();
        expect(vi.mocked(api.get).mock.calls.filter(([url]) => url === "/payment-intakes").length).toBeGreaterThan(1);
        expect(api.post).toHaveBeenCalledTimes(1);
    });
});
