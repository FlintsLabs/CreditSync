import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { loanInterestAccruals, loans } from "../db/schema";
import { loanListLegacyAccrualProjection } from "../services/loan-payment-health-service";
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

    test("selects only deployed legacy daily-interest columns for floating list health", () => {
        const query = db.select(loanListLegacyAccrualProjection)
            .from(loanInterestAccruals)
            .where(and(
                eq(loanInterestAccruals.tenantId, "tenant-a"),
                eq(loanInterestAccruals.loanId, 42),
            )).toSQL().sql;
        const selectClause = query.slice(0, query.indexOf(" from "));

        expect(selectClause).toContain('"tenant_id"');
        expect(selectClause).toContain('"loan_id"');
        expect(selectClause).toContain('"accrual_date"');
        expect(selectClause).toContain('"interest_amount"');
        expect(selectClause).toContain('"paid_amount"');
        expect(selectClause).toContain('"status"');
        expect(selectClause).not.toContain('"period_start_date"');
        expect(selectClause).not.toContain('"period_end_date"');
        expect(selectClause).not.toContain('"period_day_index"');
        expect(selectClause).not.toContain('"period_days"');
        expect(selectClause).not.toContain('"cumulative_interest_amount"');
        expect(selectClause).not.toContain('"period_unit"');
        expect(selectClause).not.toContain('"period_length"');
        expect(selectClause).not.toContain('"contractual_interest_amount"');
        expect(selectClause).not.toContain('"daily_increment_amount"');
        expect(selectClause).not.toContain('"accrued_penalty"');
        expect(selectClause).not.toContain('"paid_penalty"');
    });
});
