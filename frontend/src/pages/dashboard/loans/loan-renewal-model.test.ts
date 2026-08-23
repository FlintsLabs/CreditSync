import { describe, expect, test } from "vitest";
import { canExecuteRenewal, defaultRenewalPolicy, displayRenewalMoney, invalidateRenewalApproval, newRenewalAdjustment } from "./loan-renewal-model";

describe("daily renewal operator model", () => {
    test("defaults to full-contract interest and adds a blank fee without totals", () => {
        expect(defaultRenewalPolicy).toBe("full_contract_interest");
        expect(newRenewalAdjustment()).toEqual({ kind: "fee", amount: "", reason: "" });
    });

    test("edits invalidate preview, confirmation, collection acknowledgment, and intent", () => {
        expect(invalidateRenewalApproval({ preview: { publicId: "old" }, confirmed: true, collectionConfirmed: true, executionIntentKey: "key" })).toEqual({
            preview: null, confirmed: false, collectionConfirmed: false, executionIntentKey: null,
        });
    });

    test("formats backend money strings and requires collection-specific acknowledgment", () => {
        expect(displayRenewalMoney("600.00", "en")).toContain("600.00");
        expect(canExecuteRenewal("payout", true, false)).toBe(true);
        expect(canExecuteRenewal("collection", true, false)).toBe(false);
        expect(canExecuteRenewal("collection", true, true)).toBe(true);
    });
});
