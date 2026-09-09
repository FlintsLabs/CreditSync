import { describe, expect, test, vi } from "vitest";
import {
    getLoanQueryRevision,
    invalidateLoanQueries,
    loanDetailQueryKey,
    loanListQueryKey,
    resetLoanQueryInvalidationForTests,
    subscribeLoanQuery,
} from "../src/lib/loan-query-invalidation";

const OLD_LOAN_ID = "019ff023-fd64-7d41-9aae-723d2a458a8a";
const REPLACEMENT_LOAN_ID = "019ff023-fd64-7d41-9aae-723d2a458a8b";

describe("durable loan query invalidation", () => {
    test("persists list and both detail revisions while routes are unmounted", () => {
        resetLoanQueryInvalidationForTests();
        const oldKey = loanDetailQueryKey(OLD_LOAN_ID);
        const replacementKey = loanDetailQueryKey(REPLACEMENT_LOAN_ID);
        const unrelatedKey = loanDetailQueryKey("019ff023-fd64-7d41-9aae-723d2a458a8c");

        invalidateLoanQueries([OLD_LOAN_ID, REPLACEMENT_LOAN_ID, OLD_LOAN_ID]);

        expect(getLoanQueryRevision(loanListQueryKey)).toBe(1);
        expect(getLoanQueryRevision(oldKey)).toBe(1);
        expect(getLoanQueryRevision(replacementKey)).toBe(1);
        expect(getLoanQueryRevision(unrelatedKey)).toBe(0);
    });

    test("notifies only list and affected detail subscribers", () => {
        resetLoanQueryInvalidationForTests();
        const listListener = vi.fn();
        const oldListener = vi.fn();
        const unrelatedListener = vi.fn();
        const unsubscribe = [
            subscribeLoanQuery(loanListQueryKey, listListener),
            subscribeLoanQuery(loanDetailQueryKey(OLD_LOAN_ID), oldListener),
            subscribeLoanQuery(loanDetailQueryKey("019ff023-fd64-7d41-9aae-723d2a458a8c"), unrelatedListener),
        ];

        invalidateLoanQueries([OLD_LOAN_ID, REPLACEMENT_LOAN_ID]);

        expect(listListener).toHaveBeenCalledTimes(1);
        expect(oldListener).toHaveBeenCalledTimes(1);
        expect(unrelatedListener).not.toHaveBeenCalled();
        unsubscribe.forEach((stop) => stop());
    });
});
