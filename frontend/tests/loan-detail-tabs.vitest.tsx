import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { LoanDetailTabs } from "../src/pages/dashboard/loans/LoanDetailTabs";

describe("LoanDetailTabs", () => {
    it("selects Information by default and only mounts the selected accessible panel", async () => {
        const onChange = vi.fn();
        render(<LoanDetailTabs value="information" onChange={onChange} renderPanel={(tab) => <div>{tab} panel</div>} />);

        expect(screen.getByRole("tab", { name: "Information" })).toHaveAttribute("aria-selected", "true");
        expect(screen.getByText("information panel")).toBeInTheDocument();
        expect(screen.queryByText("agents panel")).not.toBeInTheDocument();

        await userEvent.click(screen.getByRole("tab", { name: "Agents" }));
        expect(onChange).toHaveBeenCalledWith("agents");
    });
});
