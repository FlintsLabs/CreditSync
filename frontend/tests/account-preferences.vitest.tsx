import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider, useTheme } from "../src/components/theme-provider";

function ThemeHarness() {
    const { theme, setTheme } = useTheme();
    const [saved, setSaved] = useState<boolean | null>(null);

    return <>
        <output>{theme}</output>
        <output>{saved === null ? "idle" : saved ? "saved" : "not-saved"}</output>
        <button onClick={() => setSaved(setTheme("light"))}>Light</button>
    </>;
}

describe("account preferences", () => {
    afterEach(() => vi.restoreAllMocks());

    it("keeps the selected theme in memory when storage persistence fails", async () => {
        const user = userEvent.setup();
        vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => {
            throw new DOMException("quota", "QuotaExceededError");
        });
        render(<ThemeProvider defaultTheme="dark"><ThemeHarness /></ThemeProvider>);

        await user.click(screen.getByRole("button", { name: "Light" }));

        expect(screen.getByText("light")).toBeInTheDocument();
        expect(screen.getByText("not-saved")).toBeInTheDocument();
    });
});
