import { useLayoutEffect, useRef } from "react";

export function useActiveScope(scope: string) {
    const activeScope = useRef(scope);
    useLayoutEffect(() => {
        activeScope.current = scope;
        return () => { activeScope.current = ""; };
    }, [scope]);
    return activeScope;
}

export async function refreshForScope<T>(
    expectedScope: string,
    activeScope: { current: string },
    request: () => Promise<T>,
    install: (value: T) => void,
) {
    const value = await request();
    if (activeScope.current !== expectedScope) return;
    install(value);
}
