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
