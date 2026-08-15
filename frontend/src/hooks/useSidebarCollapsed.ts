import { useCallback, useState } from "react";

export const SIDEBAR_COLLAPSED_STORAGE_KEY = "creditsync:sidebar-collapsed";

function readInitialPreference(): boolean {
    try {
        return window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === "true";
    } catch {
        return false;
    }
}

export function useSidebarCollapsed(): readonly [boolean, () => void] {
    const [collapsed, setCollapsed] = useState(readInitialPreference);

    const toggle = useCallback(() => {
        setCollapsed((current) => {
            const next = !current;
            try {
                window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(next));
            } catch {
                // Storage is unavailable; keep in-memory state.
            }
            return next;
        });
    }, []);

    return [collapsed, toggle] as const;
}
