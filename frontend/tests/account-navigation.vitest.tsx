import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    PREFERENCES_SETTINGS_PATH,
    PROFILE_SETTINGS_PATH,
    SETTINGS_PATH,
    signOut,
} from "../src/lib/account";

describe("account navigation", () => {
    beforeEach(() => localStorage.clear());

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
});
