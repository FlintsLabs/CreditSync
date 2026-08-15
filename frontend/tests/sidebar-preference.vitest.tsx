import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
    SIDEBAR_COLLAPSED_STORAGE_KEY,
    useSidebarCollapsed,
} from "../src/hooks/useSidebarCollapsed";

export function Harness() {
    const [collapsed, toggle] = useSidebarCollapsed();
    return (
        <button type="button" aria-pressed={collapsed} onClick={toggle}>
            {collapsed ? "collapsed" : "expanded"}
        </button>
    );
}

describe("useSidebarCollapsed", () => {
    beforeEach(() => localStorage.clear());

    it("defaults to expanded when no valid preference exists", () => {
        localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, "invalid");
        render(<Harness />);
        expect(screen.getByRole("button")).toHaveTextContent("expanded");
    });

    it("restores a collapsed preference", () => {
        localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, "true");
        render(<Harness />);
        expect(screen.getByRole("button")).toHaveAttribute("aria-pressed", "true");
    });

    it("toggles and persists the explicit preference", async () => {
        const user = userEvent.setup();
        render(<Harness />);

        await user.click(screen.getByRole("button"));
        expect(localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY)).toBe("true");

        await user.click(screen.getByRole("button"));
        expect(localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY)).toBe("false");
    });

    it("still toggles in memory when storage throws", async () => {
        vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
            throw new Error("blocked");
        });
        vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
            throw new Error("blocked");
        });
        const user = userEvent.setup();
        render(<Harness />);

        await user.click(screen.getByRole("button"));
        expect(screen.getByRole("button")).toHaveTextContent("collapsed");

        vi.restoreAllMocks();
    });
});
