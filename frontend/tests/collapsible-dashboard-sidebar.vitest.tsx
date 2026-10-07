import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import DashboardLayout from "../src/layouts/DashboardLayout";
import { APPLICATION_VERSION, CHANGELOG_URL, MCP_SCHEMA_VERSION, PLUGIN_VERSION } from "../src/lib/release";

const SIDEBAR_COLLAPSED_STORAGE_KEY = "creditsync:sidebar-collapsed";

export function LocationProbe() {
    const location = useLocation();
    return <output aria-label="location">{location.pathname}</output>;
}

describe("compact dashboard sidebar", () => {
    beforeEach(() => {
        localStorage.clear();
        localStorage.setItem(
            "user",
            JSON.stringify({
                id: 1,
                name: "Mali",
                email: "mali@example.com",
                role: "owner",
            }),
        );
        Object.defineProperty(window, "matchMedia", {
            configurable: true,
            writable: true,
            value: vi.fn().mockReturnValue({ matches: false }),
        });
    });

    afterEach(() => {
        delete (window as Window & { matchMedia?: typeof window.matchMedia }).matchMedia;
    });

    it("collapses and expands with accessible toggles and restored route state", async () => {
        const user = userEvent.setup();
        render(
            <MemoryRouter initialEntries={["/loans"]}>
                <Routes>
                    <Route path="/" element={<DashboardLayout />}>
                        <Route path="dashboard" element={<h1>dashboard</h1>} />
                        <Route path="loans" element={<h1>loans</h1>} />
                        <Route path="borrowers" element={<h1>borrowers</h1>} />
                        <Route path="transactions" element={<h1>transactions</h1>} />
                        <Route path="payments" element={<h1>payments</h1>} />
                        <Route path="matching" element={<h1>matching</h1>} />
                        <Route path="reconciliation" element={<h1>reconciliation</h1>} />
                        <Route path="intermediaries" element={<h1>intermediaries</h1>} />
                        <Route path="funds" element={<h1>funds</h1>} />
                        <Route path="settings" element={<h1>settings</h1>} />
                        <Route path="*" element={<LocationProbe />} />
                    </Route>
                </Routes>
            </MemoryRouter>,
        );

        const sidebar = screen.getByTestId("desktop-sidebar");
        expect(sidebar).toHaveAttribute("data-sidebar-state", "expanded");
        expect(sidebar).toHaveClass("w-64");
        expect(screen.getByRole("button", { name: "Collapse sidebar" })).toHaveAttribute("aria-expanded", "true");
        expect(screen.getAllByRole("link", { name: "Loans" })[0]).toHaveAttribute("aria-current", "page");
        const header = within(sidebar).getByTestId("sidebar-header");
        expect(within(header).getByTestId("sidebar-brand-mark")).toBeInTheDocument();
        expect(within(header).getByRole("button", { name: "Collapse sidebar" })).toBeInTheDocument();
        expect(within(header).queryByRole("button", { name: "Toggle theme" })).not.toBeInTheDocument();
        expect(within(sidebar).queryByRole("button", { name: "Switch language" })).not.toBeInTheDocument();
        const accountFooter = within(sidebar).getByTestId("sidebar-account-footer");
        expect(within(accountFooter).getByRole("button", { name: "Open account menu for Mali" })).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Collapse sidebar" }));

        expect(sidebar).toHaveAttribute("data-sidebar-state", "collapsed");
        expect(sidebar).toHaveClass("w-[72px]");
        expect(screen.getByRole("button", { name: "Expand sidebar" })).toHaveAttribute("aria-expanded", "false");
        expect(screen.getAllByRole("link", { name: "Loans" })[0]).toHaveAccessibleName("Loans");
        expect(localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY)).toBe("true");
    });

    it("restores compact state on load and keeps desktop links usable", async () => {
        const user = userEvent.setup();
        localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, "true");
        render(
            <MemoryRouter initialEntries={["/loans"]}>
                <Routes>
                <Route path="/" element={<DashboardLayout />}>
                        <Route path="loans" element={<LocationProbe />} />
                        <Route path="borrowers" element={<LocationProbe />} />
                        <Route path="transactions" element={<LocationProbe />} />
                        <Route path="payments" element={<LocationProbe />} />
                        <Route path="settings" element={<LocationProbe />} />
                        <Route path="*" element={<LocationProbe />} />
                    </Route>
                </Routes>
            </MemoryRouter>,
        );

        const sidebar = screen.getByTestId("desktop-sidebar");
        expect(sidebar).toHaveAttribute("data-sidebar-state", "collapsed");
        expect(sidebar).toHaveClass("w-[72px]");

        const loansLink = within(sidebar).getByRole("link", { name: "Loans" });
        await user.click(loansLink);
        expect(screen.getByLabelText("location")).toHaveTextContent("/loans");

        const borrowersLink = within(sidebar).getByRole("link", { name: "Borrowers" });
        await user.click(borrowersLink);
        expect(screen.getByLabelText("location")).toHaveTextContent("/borrowers");

        const txsLink = within(sidebar).getByRole("link", { name: "Transactions" });
        await user.click(txsLink);
        expect(screen.getByLabelText("location")).toHaveTextContent("/transactions");
    });

    it("keeps mobile controls unchanged", () => {
        render(
            <MemoryRouter initialEntries={["/loans"]}>
                <Routes>
                <Route path="/" element={<DashboardLayout />}>
                        <Route path="loans" element={<LocationProbe />} />
                    </Route>
                </Routes>
            </MemoryRouter>,
        );

        expect(screen.getByRole("button", { name: "Open navigation" })).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Toggle theme" })).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Switch language" })).not.toBeInTheDocument();
        const mobileHeader = screen.getByTestId("mobile-header");
        expect(within(mobileHeader).queryByRole("button", { name: "Open account menu for Mali" })).not.toBeInTheDocument();
    });

    it("shows the first five permitted destinations and keeps nested routes current", () => {
        const renderAt = (role: string, route: string) => {
            localStorage.setItem("user", JSON.stringify({ id: 1, name: "Mali", email: "mali@example.com", role }));
            return render(
                <MemoryRouter initialEntries={[route]}>
                    <Routes>
                        <Route path="/" element={<DashboardLayout />}>
                            <Route path="*" element={<LocationProbe />} />
                        </Route>
                    </Routes>
                </MemoryRouter>,
            );
        };

        const admin = renderAt("owner", "/loans/loan-123");
        const adminNav = screen.getByRole("navigation", { name: "Main navigation" });
        expect(within(adminNav).getAllByRole("link")).toHaveLength(5);
        expect(within(adminNav).getByRole("link", { name: "Loans" })).toHaveAttribute("aria-current", "page");
        expect(within(adminNav).queryByRole("link", { name: "Matching" })).not.toBeInTheDocument();
        admin.unmount();

        renderAt("collector", "/payments/receipt-456");
        const collectorNav = screen.getByRole("navigation", { name: "Main navigation" });
        expect(within(collectorNav).getAllByRole("link")).toHaveLength(5);
        expect(within(collectorNav).getByRole("link", { name: "Settings" })).toBeInTheDocument();
        expect(within(collectorNav).getByRole("link", { name: "Payment Inbox" })).toHaveAttribute("aria-current", "page");
    });

    it("keeps navigation keyboard-focusable and exposes safe-area spacing", () => {
        render(
            <MemoryRouter initialEntries={["/borrowers/borrower-123"]}>
                <Routes>
                    <Route path="/" element={<DashboardLayout />}>
                        <Route path="*" element={<LocationProbe />} />
                    </Route>
                </Routes>
            </MemoryRouter>,
        );

        const nav = screen.getByRole("navigation", { name: "Main navigation" });
        const borrowersLink = within(nav).getByRole("link", { name: "Borrowers" });
        expect(borrowersLink).toHaveAttribute("aria-current", "page");
        expect(borrowersLink).toHaveClass("focus-visible:ring-2");
        expect(nav).toHaveClass("pb-[calc(0.5rem+var(--safe-area-bottom))]");
        expect(screen.getByRole("main")).toHaveClass("pb-[calc(6rem+var(--safe-area-bottom))]");
        expect(screen.getByTestId("application-footer")).toHaveClass("pb-[calc(6rem+var(--safe-area-bottom))]", "pr-20", "md:pr-24");
        expect(screen.getByTestId("ai-assistant-root")).toHaveClass("bottom-[calc(6rem+var(--safe-area-bottom))]");
    });

    it("shows release metadata and a changelog link below authenticated content", () => {
        render(
            <MemoryRouter initialEntries={["/loans"]}>
                <Routes>
                    <Route path="/" element={<DashboardLayout />}>
                        <Route path="loans" element={<h1>loans</h1>} />
                    </Route>
                </Routes>
            </MemoryRouter>,
        );

        const footer = screen.getByTestId("application-footer");
        expect(within(footer).getByText(`CreditSync v${APPLICATION_VERSION}`)).toBeInTheDocument();
        expect(within(footer).getByText(`MCP v${MCP_SCHEMA_VERSION}`)).toBeInTheDocument();
        expect(within(footer).getByText(`Plugin v${PLUGIN_VERSION}`)).toBeInTheDocument();
        expect(within(footer).getByRole("link", { name: "Changelog" })).toHaveAttribute(
            "href",
            CHANGELOG_URL,
        );
    });

    it("places the account menu in the mobile drawer footer without theme or language controls", async () => {
        const user = userEvent.setup();
        render(
            <MemoryRouter initialEntries={["/loans"]}>
                <Routes>
                    <Route path="/" element={<DashboardLayout />}>
                        <Route path="loans" element={<LocationProbe />} />
                    </Route>
                </Routes>
            </MemoryRouter>,
        );

        await user.click(screen.getByRole("button", { name: "Open navigation" }));

        const drawer = screen.getByTestId("mobile-sidebar");
        const accountFooter = within(drawer).getByTestId("sidebar-account-footer");
        expect(within(accountFooter).getByRole("button", { name: "Open account menu for Mali" })).toBeInTheDocument();
        expect(within(drawer).queryByRole("button", { name: "Toggle theme" })).not.toBeInTheDocument();
        expect(within(drawer).queryByRole("button", { name: "Switch language" })).not.toBeInTheDocument();
    });
});
