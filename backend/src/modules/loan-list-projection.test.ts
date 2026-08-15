import { describe, expect, test } from "bun:test";
import { db } from "../db";
import { loans } from "../db/schema";
import { loanListLoanProjection } from "./loan-contract-routes";

describe("loan list projection", () => {
    test("selects only deployed-compatible list and payment-health columns", () => {
        const query = db.select({ loan: loanListLoanProjection }).from(loans).toSQL().sql;

        expect(query).toContain('"public_id"');
        expect(query).toContain('"daily_interest_mode"');
        expect(query).toContain('"daily_interest_rate"');
        expect(query).toContain('"first_day_treatment"');
        expect(query).toContain('"interest_start_date"');
        expect(query).not.toContain('"floating_accrual_cycle"');
        expect(query).not.toContain('"interest_period_unit"');
        expect(query).not.toContain('"interest_period_length"');
        expect(query).not.toContain('"advance_interest_periods"');
        expect(query).not.toContain('"advance_interest_refund_policy"');
        expect(query).not.toContain('"interest_period_anchor_date"');
    });
});
