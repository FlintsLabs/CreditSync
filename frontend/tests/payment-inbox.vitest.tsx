import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { api, resolveFileAccess } from "../src/lib/api";
import PaymentInbox from "../src/pages/dashboard/payments/PaymentInbox";

vi.mock("../src/lib/api", () => ({ api: { get: vi.fn(), post: vi.fn() }, resolveFileAccess: vi.fn() }));

const INTAKE_A = "019c3a5a-94ce-7f2c-8b08-f56852dca7a1";
const INTAKE_B = "019c3a5a-94ce-7f2c-8b08-f56852dca7a2";
const BORROWER_A = "019c3a5a-94ce-7f2c-8b08-f56852dca7a3";
const BORROWER_B = "019c3a5a-94ce-7f2c-8b08-f56852dca7a4";
const LOAN_A = "019c3a5a-94ce-7f2c-8b08-f56852dca7a5";
const LOAN_B = "019c3a5a-94ce-7f2c-8b08-f56852dca7a6";

const list = [
    { publicId: INTAKE_A, status: "needs_review", amount: "30.30", receivedAt: "2026-08-10T09:30:00.000Z", payerName: "A" },
    { publicId: INTAKE_B, status: "draft", amount: "40.00", receivedAt: "2026-08-10T10:30:00.000Z", payerName: "B" },
];
const listPage = { items: list, page: 1, pageSize: 25, total: 27, totalPages: 2 };
const loans = [
    { publicId: LOAN_A, borrowerPublicId: BORROWER_A, borrowerName: "Borrower A", status: "active" },
    { publicId: LOAN_B, borrowerPublicId: BORROWER_B, borrowerName: "Borrower B", status: "active" },
];

function detail(publicId: string) {
    return {
        ...list.find((item) => item.publicId === publicId)!,
        warnings: publicId === INTAKE_A ? [{ code: "POSSIBLE_SEMANTIC_DUPLICATE", intakePublicIds: [INTAKE_B] }] : [],
        evidence: [], latestProposal: null,
    };
}

describe("PaymentInbox", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(api.get).mockImplementation(async (url) => {
            if (url === "/payment-intakes") return { data: listPage };
            if (url === "/loans") return { data: loans };
            if (url.startsWith("/payment-intakes/")) return { data: detail(url.split("/").at(-1)!) };
            if (url === "/audit-logs") return { data: [] };
            throw new Error(`Unexpected GET ${url}`);
        });
        vi.mocked(api.post).mockResolvedValue({ data: {
            publicId: "019c3a5a-94ce-7f2c-8b08-f56852dca7af", status: "ready", version: 1,
            totalAllocated: "30.30", allocations: [], warnings: [], expiresAt: "2026-08-10T12:00:00.000Z",
        } });
    });

    test("renders flat rows and keeps filters when moving to the next server page", async () => {
        const user = userEvent.setup();
        render(<MemoryRouter><PaymentInbox /></MemoryRouter>);

        const inbox = await screen.findByRole("list", { name: /inbox/i });
        const rows = within(inbox).getAllByRole("listitem");
        expect(rows).toHaveLength(2);
        expect(within(rows[0]!).getByRole("button", { name: /^A/ })).not.toHaveClass("border");
        expect(screen.getByText("1–25 of 27")).toBeInTheDocument();

        await user.type(screen.getByRole("searchbox", { name: /search payer/i }), "Borrower");
        await user.selectOptions(screen.getByRole("combobox", { name: /status/i }), "ready");
        await waitFor(() => expect(api.get).toHaveBeenCalledWith("/payment-intakes", { params: {
            search: "Borrower", status: "ready", page: "1", pageSize: "25",
        } }));

        await user.click(screen.getByRole("button", { name: /next page/i }));
        await waitFor(() => expect(api.get).toHaveBeenCalledWith("/payment-intakes", { params: {
            search: "Borrower", status: "ready", page: "2", pageSize: "25",
        } }));
    });

    test("gives every payment status a distinct semantic tone while retaining its label", async () => {
        const statuses = ["draft", "needs_review", "ready", "posted", "reversed", "duplicate"];
        vi.mocked(api.get).mockImplementation(async (url) => {
            if (url === "/payment-intakes") return { data: {
                items: statuses.map((status, index) => ({
                    publicId: `${INTAKE_A.slice(0, -1)}${index + 1}`,
                    status,
                    amount: "10.00",
                    receivedAt: `2026-08-10T0${index}:00:00.000Z`,
                    payerName: `Payer ${index + 1}`,
                })),
                page: 1, pageSize: 25, total: 6, totalPages: 1,
            } };
            if (url === "/loans") return { data: loans };
            throw new Error(`Unexpected GET ${url}`);
        });
        render(<MemoryRouter><PaymentInbox /></MemoryRouter>);

        const expected = {
            Draft: "neutral",
            "Needs review": "warning",
            Ready: "success",
            Posted: "info",
            Reversed: "danger",
            Duplicate: "duplicate",
        };
        const inbox = await screen.findByRole("list", { name: /inbox/i });
        for (const [label, tone] of Object.entries(expected)) {
            expect((await within(inbox).findByText(label)).closest("[data-status-tone]")).toHaveAttribute("data-status-tone", tone);
        }
    });

    test("adds and removes explicit allocation rows and previews the complete split", async () => {
        const user = userEvent.setup();
        render(<MemoryRouter><PaymentInbox /></MemoryRouter>);
        await user.click(await screen.findByRole("button", { name: /^A/ }));

        expect(await screen.findByText(/possible semantic duplicate/i)).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: /add allocation/i }));
        const rows = screen.getAllByTestId("allocation-row");
        expect(rows).toHaveLength(2);

        await user.selectOptions(within(rows[0]!).getByLabelText(/borrower loan/i), LOAN_A);
        await user.clear(within(rows[0]!).getByLabelText(/allocation amount/i));
        await user.type(within(rows[0]!).getByLabelText(/allocation amount/i), "10.10");
        await user.selectOptions(within(rows[1]!).getByLabelText(/borrower loan/i), LOAN_B);
        await user.type(within(rows[1]!).getByLabelText(/allocation amount/i), "20.20");
        await user.click(screen.getByRole("button", { name: /preview allocation/i }));

        await waitFor(() => expect(api.post).toHaveBeenCalledWith(`/payment-intakes/${INTAKE_A}/match-preview`, {
            allocations: [
                { borrowerPublicId: BORROWER_A, loanPublicId: LOAN_A, amount: "10.10" },
                { borrowerPublicId: BORROWER_B, loanPublicId: LOAN_B, amount: "20.20" },
            ],
        }));
        expect(screen.getAllByText(/30\.30/).length).toBeGreaterThan(0);
        expect(screen.queryByRole("button", { name: /confirm and post/i })).not.toBeInTheDocument();
        await user.click(screen.getByRole("checkbox", { name: /reviewed the possible duplicate/i }));
        expect(screen.getByRole("button", { name: /confirm and post/i })).toBeInTheDocument();

        await user.click(within(rows[1]!).getByRole("button", { name: /remove allocation/i }));
        expect(screen.getAllByTestId("allocation-row")).toHaveLength(1);
        expect(screen.queryByRole("button", { name: /confirm and post/i })).not.toBeInTheDocument();
    });

    test("requires a new preview after every edit, add, or remove mutation", async () => {
        const user = userEvent.setup();
        render(<MemoryRouter><PaymentInbox /></MemoryRouter>);
        await user.click(await screen.findByRole("button", { name: /^B/ }));
        let rows = screen.getAllByTestId("allocation-row");
        await user.selectOptions(within(rows[0]!).getByLabelText(/borrower loan/i), LOAN_A);
        await user.click(screen.getByRole("button", { name: /preview allocation/i }));
        expect(await screen.findByRole("button", { name: /confirm and post/i })).toBeInTheDocument();

        await user.clear(within(rows[0]!).getByLabelText(/allocation amount/i));
        await user.type(within(rows[0]!).getByLabelText(/allocation amount/i), "20.00");
        expect(screen.queryByRole("button", { name: /confirm and post/i })).not.toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: /preview allocation/i }));
        expect(await screen.findByRole("button", { name: /confirm and post/i })).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: /add allocation/i }));
        expect(screen.queryByRole("button", { name: /confirm and post/i })).not.toBeInTheDocument();
        rows = screen.getAllByTestId("allocation-row");
        await user.selectOptions(within(rows[1]!).getByLabelText(/borrower loan/i), LOAN_B);
        await user.type(within(rows[1]!).getByLabelText(/allocation amount/i), "20.00");
        await user.click(screen.getByRole("button", { name: /preview allocation/i }));
        expect(await screen.findByRole("button", { name: /confirm and post/i })).toBeInTheDocument();

        await user.click(within(rows[1]!).getByRole("button", { name: /remove allocation/i }));
        expect(screen.queryByRole("button", { name: /confirm and post/i })).not.toBeInTheDocument();
    });

    test("disables editor mutations and discards a preview response after the intake changes", async () => {
        const user = userEvent.setup();
        let resolvePreview!: (value: { data: Record<string, unknown> }) => void;
        const pendingPreview = new Promise<{ data: Record<string, unknown> }>((resolve) => { resolvePreview = resolve; });
        vi.mocked(api.post).mockImplementation(async (url) => {
            if (url.endsWith("/match-preview")) return pendingPreview;
            throw new Error(`Unexpected POST ${url}`);
        });
        render(<MemoryRouter><PaymentInbox /></MemoryRouter>);
        await user.click(await screen.findByRole("button", { name: /^B/ }));
        const row = screen.getByTestId("allocation-row");
        await user.selectOptions(within(row).getByLabelText(/borrower loan/i), LOAN_A);
        await user.click(screen.getByRole("button", { name: /preview allocation/i }));

        expect(within(row).getByLabelText(/borrower loan/i)).toBeDisabled();
        expect(within(row).getByLabelText(/allocation amount/i)).toBeDisabled();
        expect(screen.queryByRole("button", { name: /add allocation/i })).not.toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: /^A/ }));
        expect(await screen.findByText(INTAKE_A)).toBeInTheDocument();
        await act(async () => resolvePreview({ data: {
            publicId: "019c3a5a-94ce-7f2c-8b08-f56852dca7af",
            status: "ready", version: 1, totalAllocated: "40.00", allocations: [], warnings: [],
            expiresAt: "2026-08-10T12:00:00.000Z",
        } }));
        await user.click(screen.getByRole("checkbox", { name: /reviewed the possible duplicate/i }));
        expect(screen.queryByRole("button", { name: /confirm and post/i })).not.toBeInTheDocument();
    });

    test("announces a localized error when manual refresh fails", async () => {
        const user = userEvent.setup();
        render(<MemoryRouter><PaymentInbox /></MemoryRouter>);
        const refresh = await screen.findByRole("button", { name: /refresh/i });
        vi.mocked(api.get).mockImplementation(async (url) => {
            if (url === "/payment-intakes") throw new Error("network down");
            if (url === "/loans") return { data: loans };
            throw new Error(`Unexpected GET ${url}`);
        });
        await user.click(refresh);
        expect(await screen.findByRole("alert")).toHaveTextContent("Unable to load payment inbox.");
        await waitFor(() => expect(refresh).toBeEnabled());
    });

    test("ignores a stale detail response after selecting another intake", async () => {
        const user = userEvent.setup();
        let resolveA!: (value: { data: ReturnType<typeof detail> }) => void;
        const pendingA = new Promise<{ data: ReturnType<typeof detail> }>((resolve) => { resolveA = resolve; });
        vi.mocked(api.get).mockImplementation(async (url) => {
            if (url === "/payment-intakes") return { data: listPage };
            if (url === "/loans") return { data: loans };
            if (url === `/payment-intakes/${INTAKE_A}`) return pendingA;
            if (url === `/payment-intakes/${INTAKE_B}`) return { data: detail(INTAKE_B) };
            if (url === "/audit-logs") return { data: [] };
            throw new Error(`Unexpected GET ${url}`);
        });
        render(<MemoryRouter><PaymentInbox /></MemoryRouter>);
        const buttonA = await screen.findByRole("button", { name: /^A/ });
        const buttonB = await screen.findByRole("button", { name: /^B/ });
        await user.click(buttonA);
        await user.click(buttonB);
        expect(await screen.findByText(INTAKE_B)).toBeInTheDocument();
        await act(async () => resolveA({ data: detail(INTAKE_A) }));
        expect(screen.getByText(INTAKE_B)).toBeInTheDocument();
        expect(screen.queryByText(INTAKE_A)).not.toBeInTheDocument();
    });

    test("requires a second-step reason before reversing a posted payment", async () => {
        const user = userEvent.setup();
        vi.mocked(api.get).mockImplementation(async (url) => {
            if (url === "/payment-intakes") return { data: listPage };
            if (url === "/loans") return { data: loans };
            if (url === `/payment-intakes/${INTAKE_B}`) return { data: { ...detail(INTAKE_B), status: "posted" } };
            if (url === "/audit-logs") return { data: [] };
            throw new Error(`Unexpected GET ${url}`);
        });
        render(<MemoryRouter><PaymentInbox /></MemoryRouter>);
        await user.click(await screen.findByRole("button", { name: /^B/ }));
        await user.click(await screen.findByRole("button", { name: /reverse posted payment/i }));
        const confirm = screen.getByRole("button", { name: /confirm reversal/i });
        expect(confirm).toBeDisabled();
        await user.type(screen.getByLabelText(/reason for reversal/i), "Bank correction confirmed");
        await user.click(confirm);
        await waitFor(() => expect(api.post).toHaveBeenCalledWith(`/payment-intakes/${INTAKE_B}/reverse`, {
            reason: "Bank correction confirmed",
        }));
    });

    test("prepares and finalizes optional evidence before posting", async () => {
        const user = userEvent.setup();
        const evidenceId = "019c3a5a-94ce-7f2c-8b08-f56852dca7b0";
        vi.mocked(api.post).mockImplementation(async (url) => {
            if (url.endsWith("/evidence/upload-intents")) return { data: { publicId: evidenceId, status: "ready", duplicate: false } };
            if (url.endsWith(`/evidence/${evidenceId}/finalize`)) return { data: { publicId: evidenceId, status: "ready" } };
            throw new Error(`Unexpected POST ${url}`);
        });
        render(<MemoryRouter><PaymentInbox /></MemoryRouter>);
        await user.click(await screen.findByRole("button", { name: /^B/ }));
        const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
        const file = new File([new Uint8Array([1, 2, 3])], "slip.png", { type: "image/png" });
        Object.defineProperty(file, "arrayBuffer", { value: async () => new Uint8Array([1, 2, 3]).buffer });
        await user.upload(input, file);
        await waitFor(() => expect(api.post).toHaveBeenCalledWith(`/payment-intakes/${INTAKE_B}/evidence/upload-intents`, {
            mimeType: "image/png",
            size: 3,
            sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
            evidenceType: "slip",
        }));
        expect(api.post).toHaveBeenCalledWith(`/payment-intakes/${INTAKE_B}/evidence/${evidenceId}/finalize`);
    });

    test("previews ready payment evidence only after the user asks", async () => {
        const user = userEvent.setup();
        const filePublicId = "019c3a5a-94ce-7f2c-8b08-f56852dca7b1";
        vi.mocked(api.get).mockImplementation(async (url) => {
            if (url === "/payment-intakes") return { data: listPage };
            if (url === "/loans") return { data: loans };
            if (url === `/payment-intakes/${INTAKE_B}`) return { data: { ...detail(INTAKE_B), evidence: [
                { publicId: "evidence-ready", status: "ready", mimeType: "image/jpeg", filePublicId },
                { publicId: "evidence-pending", status: "pending", mimeType: "image/png", filePublicId: null },
            ] } };
            if (url === "/audit-logs") return { data: [] };
            throw new Error(`Unexpected GET ${url}`);
        });
        vi.mocked(resolveFileAccess).mockResolvedValue({ url: "https://signed.example/payment.jpg", mimeType: "image/jpeg" });
        render(<MemoryRouter><PaymentInbox /></MemoryRouter>);

        await user.click(await screen.findByRole("button", { name: /^B/ }));
        expect(resolveFileAccess).not.toHaveBeenCalled();
        expect(screen.getAllByText(/pending/i).length).toBeGreaterThan(0);
        await user.click(await screen.findByRole("button", { name: /preview slip/i }));
        expect(await screen.findByRole("img", { name: /preview slip/i })).toHaveAttribute("src", "https://signed.example/payment.jpg");
        expect(resolveFileAccess).toHaveBeenCalledWith(filePublicId);
    });
});
