ALTER TABLE "loan_interest_accruals" ADD COLUMN "accrued_penalty" numeric DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "loan_interest_accruals" ADD COLUMN "paid_penalty" numeric DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "loan_interest_accruals" ADD CONSTRAINT "loan_interest_accruals_penalty_money_check" CHECK (
        "loan_interest_accruals"."accrued_penalty" >= 0 AND scale("loan_interest_accruals"."accrued_penalty") <= 2
        AND "loan_interest_accruals"."paid_penalty" >= 0 AND scale("loan_interest_accruals"."paid_penalty") <= 2
        AND "loan_interest_accruals"."paid_penalty" <= "loan_interest_accruals"."accrued_penalty"
    );