import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import DashboardLayout from "../src/layouts/DashboardLayout";

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
        const brandHeading = within(sidebar).getByRole("heading", { level: 1, name: "CreditSync" });
        expect(brandHeading).toHaveClass("text-lg");
        const brandSection = brandHeading.closest("div.flex-1.min-w-0");
        expect(brandSection).not.toBeNull();
        expect(brandSection).toHaveClass("min-w-0");
        expect(brandSection).toHaveClass("flex-1");
        expect(screen.getAllByRole("link", { name: "Loans" })[0]).toHaveAttribute("aria-current", "page");

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
    });
});
