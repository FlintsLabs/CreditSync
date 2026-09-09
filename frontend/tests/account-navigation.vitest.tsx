import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { UserAccountMenu } from "../src/components/AppBar";
import DashboardLayout from "../src/layouts/DashboardLayout";
import App from "../src/App";
import {
    PREFERENCES_SETTINGS_PATH,
    PROFILE_SETTINGS_PATH,
    SETTINGS_PATH,
    signOut,
} from "../src/lib/account";

vi.mock("@react-oauth/google", () => ({
    GoogleOAuthProvider: ({ children }: { children: ReactNode }) => children,
    GoogleLogin: () => <button>Google login</button>,
}));

describe("account navigation", () => {
    beforeEach(() => {
        localStorage.clear();
        vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
    });

    afterEach(() => {
        vi.unstubAllEnvs();
        vi.unstubAllGlobals();
        delete (window as Window & { matchMedia?: typeof window.matchMedia }).matchMedia;
        window.history.pushState({}, "", "/");
    });

    it("keeps account destinations canonical", () => {
        expect(SETTINGS_PATH).toBe("/settings");
        expect(PROFILE_SETTINGS_PATH).toBe("/settings#profile");
        expect(PREFERENCES_SETTINGS_PATH).toBe("/settings#preferences");
    });

    it("clears only session keys and navigates to login", () => {
        localStorage.setItem("token", "token-value");
        localStorage.setItem("user", "user-value");
        localStorage.setItem("vite-ui-theme", "dark");
        const navigate = vi.fn();

        signOut(navigate);

        expect(localStorage.getItem("token")).toBeNull();
        expect(localStorage.getItem("user")).toBeNull();
        expect(localStorage.getItem("vite-ui-theme")).toBe("dark");
        expect(navigate).toHaveBeenCalledWith("/login");
    });

    function LocationProbe() {
        const location = useLocation();
        return <output aria-label="location">{`${location.pathname}${location.hash}`}</output>;
    }

    function renderAccountMenu() {
        return render(<MemoryRouter initialEntries={["/dashboard"]}>
            <UserAccountMenu />
            <LocationProbe />
        </MemoryRouter>);
    }

    it.each([
        ["Profile", "/settings#profile"],
        ["Settings", "/settings#preferences"],
    ])("opens %s at its account settings destination", async (item, destination) => {
        localStorage.setItem("user", JSON.stringify({ id: 7, name: "Mali", email: "mali@example.com", role: "owner" }));
        const user = userEvent.setup();
        renderAccountMenu();

        await user.click(screen.getByRole("button", { name: "Open account menu for Mali" }));
        await user.click(await screen.findByRole("menuitem", { name: item }));

        expect(screen.getByLabelText("location")).toHaveTextContent(destination);
    });

    it("signs out from the account menu through the shared contract", async () => {
        localStorage.setItem("token", "token-value");
        localStorage.setItem("user", JSON.stringify({ id: 7, name: "Mali", email: "mali@example.com", role: "owner" }));
        const user = userEvent.setup();
        renderAccountMenu();

        await user.click(screen.getByRole("button", { name: "Open account menu for Mali" }));
        await user.click(await screen.findByRole("menuitem", { name: "Log out" }));

        expect(screen.getByLabelText("location")).toHaveTextContent("/login");
        expect(localStorage.getItem("token")).toBeNull();
        expect(localStorage.getItem("user")).toBeNull();
    });

    it("uses a generic accessible account label without stored identity", () => {
        renderAccountMenu();
        expect(screen.getByRole("button", { name: "Open account menu" })).toBeInTheDocument();
    });

    it("points dashboard Settings navigation at the canonical path", () => {
        localStorage.setItem("user", JSON.stringify({ id: 7, name: "Mali", email: "mali@example.com", role: "owner" }));
        render(<MemoryRouter initialEntries={["/dashboard"]}>
            <Routes>
                <Route path="/" element={<DashboardLayout />}>
                    <Route path="dashboard" element={<output>dashboard</output>} />
                </Route>
            </Routes>
        </MemoryRouter>);

        expect(screen.getAllByRole("link", { name: "Settings" })[0]).toHaveAttribute("href", "/settings");
    });

    it("keeps Settings accessible on collapsed desktop sidebar", () => {
        localStorage.setItem("user", JSON.stringify({ id: 7, name: "Mali", email: "mali@example.com", role: "owner" }));
        localStorage.setItem("creditsync:sidebar-collapsed", "true");

        render(<MemoryRouter initialEntries={["/loans"]}>
            <Routes>
                <Route path="/" element={<DashboardLayout />}>
                    <Route path="loans" element={<output>loans</output>} />
                </Route>
            </Routes>
        </MemoryRouter>);

        const sidebar = screen.getByTestId("desktop-sidebar");
        expect(sidebar).toHaveClass("w-[72px]");
        expect(within(sidebar).getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/settings");
    });

    it("redirects the legacy protected settings URL to the canonical page", async () => {
        vi.stubEnv("VITE_GOOGLE_CLIENT_ID", "test-client-id");
        localStorage.setItem("token", "token-value");
        window.history.pushState({}, "", "/dashboard/settings");

        render(<App />);

        expect(await screen.findByRole("heading", { level: 1, name: "Account & Preferences" })).toBeInTheDocument();
        expect(window.location.pathname).toBe("/settings");
    });
});
