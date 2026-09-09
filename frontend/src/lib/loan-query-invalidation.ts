import { useSyncExternalStore } from "react";
import { api } from "./api";

export const loanListQueryKey = "loans:list";
export const loanDetailQueryKey = (loanPublicId: string) => `loans:detail:${loanPublicId}`;

const revisions = new Map<string, number>();
const listeners = new Map<string, Set<() => void>>();

export function getLoanQueryRevision(key: string): number {
    return revisions.get(key) ?? 0;
}

export function subscribeLoanQuery(key: string, listener: () => void): () => void {
    const subscribers = listeners.get(key) ?? new Set<() => void>();
    subscribers.add(listener);
    listeners.set(key, subscribers);
    return () => {
        subscribers.delete(listener);
        if (subscribers.size === 0) listeners.delete(key);
    };
}

export function invalidateLoanQueries(loanPublicIds: string[]): void {
    const keys = [
        loanListQueryKey,
        ...[...new Set(loanPublicIds.filter(Boolean))].map(loanDetailQueryKey),
    ];
    for (const key of keys) revisions.set(key, getLoanQueryRevision(key) + 1);
    for (const key of keys) listeners.get(key)?.forEach((listener) => listener());
}

export function useLoanQueryRevision(key: string): number {
    return useSyncExternalStore(
        (listener) => subscribeLoanQuery(key, listener),
        () => getLoanQueryRevision(key),
        () => getLoanQueryRevision(key),
    );
}

/** Shared route adapter keeps list/detail consumers on the same invalidatable boundary. */
export async function fetchLoanList<T>(): Promise<T[]> {
    return (await api.get<T[]>("/loans")).data ?? [];
}

export async function fetchLoanDetail<T>(loanPublicId: string): Promise<T> {
    return (await api.get<T>(`/loans/${loanPublicId}`)).data;
}

export function resetLoanQueryInvalidationForTests(): void {
    revisions.clear();
    listeners.clear();
}
