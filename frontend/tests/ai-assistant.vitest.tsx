import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AIAssistant } from "../src/components/AIAssistant";
import { api } from "../src/lib/api";

describe("AI assistant", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("opens with an accessible control and renders the backend response", async () => {
        vi.spyOn(api, "post").mockResolvedValue({ data: { response: "You have 3 active loans." } });
        const user = userEvent.setup();

        render(<AIAssistant />);
        await user.click(screen.getByRole("button", { name: "Open AI Assistant" }));
        await user.type(screen.getByRole("textbox", { name: "Message" }), "active loans");
        await user.click(screen.getByRole("button", { name: "Send message" }));

        expect(await screen.findByText("You have 3 active loans.")).toBeInTheDocument();
    });
});
