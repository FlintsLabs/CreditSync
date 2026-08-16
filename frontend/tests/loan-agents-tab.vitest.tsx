import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LoanAgentsTab } from "../src/pages/dashboard/loans/LoanAgentsTab";
import { api } from "../src/lib/api";
import i18n from "../src/lib/i18n";

vi.mock("../src/lib/api", () => ({ api: { get: vi.fn(), post: vi.fn(), patch: vi.fn() } }));

describe("LoanAgentsTab", () => {
    beforeEach(async () => { vi.clearAllMocks(); await i18n.changeLanguage("en"); });

    it("renders the no-agent state and exact participant rates and total", async () => {
        vi.mocked(api.get).mockImplementation(async (url) => {
            if (url === "/intermediaries?status=active") return { data: [{ publicId: "agent-a", name: "Agent A", aliases: ["A"] }] };
            return { data: [] };
        });
        const { rerender } = render(<LoanAgentsTab loanPublicId="loan-1" />);
        expect(await screen.findByText("No agents assigned")).toBeInTheDocument();

        vi.mocked(api.get).mockImplementation(async (url) => url === "/intermediaries?status=active"
            ? { data: [{ publicId: "agent-a", name: "Agent A", aliases: ["A"] }, { publicId: "agent-b", name: "Agent B", aliases: [] }] }
            : { data: [
                { publicId: "part-a", intermediaryPublicId: "agent-a", commissionRate: "33.3333", role: "collector", effectiveFrom: "2026-08-01T00:00:00.000Z", effectiveTo: null, status: "active" },
                { publicId: "part-b", intermediaryPublicId: "agent-b", commissionRate: "16.6667", role: "introducer", effectiveFrom: "2026-08-01T00:00:00.000Z", effectiveTo: null, status: "active" },
            ] });
        rerender(<LoanAgentsTab loanPublicId="loan-2" />);
        const table = await screen.findByRole("table");
        expect(within(table).getByText("33.3333%")).toBeInTheDocument();
        expect(within(table).getByText("50.0000%")).toBeInTheDocument();
    });

    it("validates rates exactly before a confirmed add", async () => {
        vi.mocked(api.get).mockImplementation(async (url) => url === "/intermediaries?status=active"
            ? { data: [{ publicId: "agent-a", name: "Agent A", aliases: [] }] }
            : { data: [] });
        vi.mocked(api.post).mockResolvedValue({ data: {} });
        render(<LoanAgentsTab loanPublicId="loan-1" />);
        await screen.findByText("No agents assigned");
        await userEvent.click(screen.getByRole("button", { name: "Add agent" }));
        await userEvent.selectOptions(screen.getByLabelText("Agent"), "agent-a");
        await userEvent.type(screen.getByLabelText("Commission rate (%)"), "0.0000");
        await userEvent.type(screen.getByLabelText("Role"), "collector");
        await userEvent.click(screen.getByLabelText("I confirm this commission agreement"));
        await userEvent.click(screen.getByRole("button", { name: "Confirm add" }));
        expect(await screen.findByRole("alert")).toHaveTextContent("greater than 0");
        expect(api.post).not.toHaveBeenCalled();
    });

    it("localizes the no-agent state in Thai", async () => {
        await i18n.changeLanguage("th");
        vi.mocked(api.get).mockResolvedValue({ data: [] });
        render(<LoanAgentsTab loanPublicId="loan-1" />);
        expect(await screen.findByText("ยังไม่มีเอเจนต์ที่มอบหมาย")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "เพิ่มเอเจนต์" })).toBeInTheDocument();
    });
});
