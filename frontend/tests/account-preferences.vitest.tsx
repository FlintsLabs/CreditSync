import { useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider, useTheme } from "../src/components/theme-provider";
import AccountPreferencesPage from "../src/pages/dashboard/settings/AccountPreferencesPage";
import i18n from "../src/lib/i18n";

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
    beforeEach(async () => {
        localStorage.clear();
        vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
        await i18n.changeLanguage("en");
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        document.documentElement.classList.remove("light", "dark");
    });

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

    function renderPage(path = "/settings") {
        return render(
            <ThemeProvider defaultTheme="system">
                <MemoryRouter initialEntries={[path]}>
                    <Routes>
                        <Route path="/settings" element={<AccountPreferencesPage />} />
                        <Route path="/login" element={<output>login destination</output>} />
                    </Routes>
                </MemoryRouter>
            </ThemeProvider>,
        );
    }

    it("shows stored identity as read-only account information", () => {
        localStorage.setItem("user", JSON.stringify({
            id: 7,
            name: "Mali Chai",
            email: "mali@example.com",
            role: "owner",
        }));

        renderPage();

        expect(screen.getByRole("heading", { level: 1, name: "Account & Preferences" })).toBeInTheDocument();
        expect(screen.getAllByText("Mali Chai").length).toBeGreaterThan(0);
        expect(screen.getAllByText("mali@example.com").length).toBeGreaterThan(0);
        expect(screen.getByText("Owner")).toBeInTheDocument();
        expect(screen.queryByRole("textbox", { name: /name|email/i })).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: /save/i })).not.toBeInTheDocument();
    });

    it("uses neutral fallbacks when stored identity is unavailable", () => {
        renderPage();

        expect(screen.getAllByText("Profile unavailable").length).toBeGreaterThan(0);
        expect(screen.getAllByText("Email unavailable").length).toBeGreaterThan(0);
        expect(screen.getByText("Role unavailable")).toBeInTheDocument();
        expect(screen.getByText("U")).toBeInTheDocument();
    });

    it("applies language and theme choices immediately with live feedback", async () => {
        const user = userEvent.setup();
        renderPage();

        expect(screen.getByRole("button", { name: "English" })).toHaveAttribute("aria-pressed", "true");
        expect(screen.getByRole("button", { name: "System" })).toHaveAttribute("aria-pressed", "true");

        await user.click(screen.getByRole("button", { name: "Thai" }));
        expect(i18n.resolvedLanguage).toBe("th");
        expect(screen.getByRole("status")).toHaveTextContent("เปลี่ยนภาษาเป็นไทยแล้ว");

        await user.click(screen.getByRole("button", { name: "มืด" }));
        expect(localStorage.getItem("vite-ui-theme")).toBe("dark");
        expect(screen.getByRole("button", { name: "มืด" })).toHaveAttribute("aria-pressed", "true");
    });

    it("keeps a language choice selected and warns when persistence rejects", async () => {
        const user = userEvent.setup();
        vi.spyOn(i18n, "changeLanguage").mockRejectedValueOnce(new Error("storage unavailable"));
        renderPage();

        await user.click(screen.getByRole("button", { name: "Thai" }));

        expect(screen.getByRole("button", { name: "Thai" })).toHaveAttribute("aria-pressed", "true");
        expect(screen.getByRole("status")).toHaveTextContent("could not be saved");
    });

    it("keeps a theme choice selected and warns when persistence fails", async () => {
        const user = userEvent.setup();
        vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => {
            throw new DOMException("quota", "QuotaExceededError");
        });
        renderPage();

        await user.click(screen.getByRole("button", { name: "Dark" }));

        expect(screen.getByRole("button", { name: "Dark" })).toHaveAttribute("aria-pressed", "true");
        expect(screen.getByRole("status")).toHaveTextContent("could not be saved");
    });

    it("focuses and scrolls to a requested settings section", async () => {
        const scrollIntoView = vi.fn();
        vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
            callback(0);
            return 1;
        });
        Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
            configurable: true,
            value: scrollIntoView,
        });

        renderPage("/settings#preferences");

        const section = screen.getByRole("region", { name: "Preferences" });
        await waitFor(() => expect(section).toHaveFocus());
        expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" });
    });

    it("clears the local session and navigates to login", async () => {
        const user = userEvent.setup();
        localStorage.setItem("token", "token-value");
        localStorage.setItem("user", JSON.stringify({ id: 7, name: "Mali", email: "mali@example.com", role: "owner" }));
        localStorage.setItem("vite-ui-theme", "dark");
        renderPage();

        await user.click(screen.getByRole("button", { name: "Sign out" }));

        expect(await screen.findByText("login destination")).toBeInTheDocument();
        expect(localStorage.getItem("token")).toBeNull();
        expect(localStorage.getItem("user")).toBeNull();
        expect(localStorage.getItem("vite-ui-theme")).toBe("dark");
    });
});
