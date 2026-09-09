ALTER TABLE "loan_restructures" DROP CONSTRAINT "loan_restructures_amounts_check";--> statement-breakpoint
ALTER TABLE "loan_restructures" DROP CONSTRAINT "loan_restructures_amount_scale_check";--> statement-breakpoint
ALTER TABLE "loan_restructures" ADD COLUMN "external_credit_principal" numeric DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "loan_restructures" ADD COLUMN "external_credit_interest" numeric DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "loan_restructures" ADD COLUMN "external_credit_fees" numeric DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "loan_restructures" ADD COLUMN "external_credit_penalty" numeric DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "loan_restructures" ADD CONSTRAINT "loan_restructures_amounts_check" CHECK (
        "loan_restructures"."gross_principal" >= 0 AND "loan_restructures"."gross_interest" >= 0 AND "loan_restructures"."gross_fees" >= 0 AND "loan_restructures"."gross_penalty" >= 0 AND
        "loan_restructures"."waived_interest" >= 0 AND "loan_restructures"."waived_fees" >= 0 AND "loan_restructures"."waived_penalty" >= 0 AND
        "loan_restructures"."net_principal" >= 0 AND "loan_restructures"."net_interest" >= 0 AND "loan_restructures"."net_fees" >= 0 AND "loan_restructures"."net_penalty" >= 0 AND
        "loan_restructures"."external_settlement_credits" >= 0 AND "loan_restructures"."additional_principal" >= 0 AND "loan_restructures"."cash_amount" >= 0 AND
        "loan_restructures"."waived_interest" <= "loan_restructures"."gross_interest" AND "loan_restructures"."waived_fees" <= "loan_restructures"."gross_fees" AND "loan_restructures"."waived_penalty" <= "loan_restructures"."gross_penalty" AND
        "loan_restructures"."external_credit_principal" >= 0 AND "loan_restructures"."external_credit_interest" >= 0 AND "loan_restructures"."external_credit_fees" >= 0 AND "loan_restructures"."external_credit_penalty" >= 0 AND
        "loan_restructures"."external_settlement_credits" = "loan_restructures"."external_credit_principal" + "loan_restructures"."external_credit_interest" + "loan_restructures"."external_credit_fees" + "loan_restructures"."external_credit_penalty" AND
        "loan_restructures"."net_principal" = "loan_restructures"."gross_principal" - "loan_restructures"."external_credit_principal" AND
        "loan_restructures"."net_interest" = "loan_restructures"."gross_interest" - "loan_restructures"."waived_interest" - "loan_restructures"."external_credit_interest" AND
        "loan_restructures"."net_fees" = "loan_restructures"."gross_fees" - "loan_restructures"."waived_fees" - "loan_restructures"."external_credit_fees" AND
        "loan_restructures"."net_penalty" = "loan_restructures"."gross_penalty" - "loan_restructures"."waived_penalty" - "loan_restructures"."external_credit_penalty"
    );--> statement-breakpoint
ALTER TABLE "loan_restructures" ADD CONSTRAINT "loan_restructures_amount_scale_check" CHECK (
        scale("loan_restructures"."gross_principal") <= 2 AND scale("loan_restructures"."gross_interest") <= 2 AND
        scale("loan_restructures"."gross_fees") <= 2 AND scale("loan_restructures"."gross_penalty") <= 2 AND
        scale("loan_restructures"."waived_interest") <= 2 AND scale("loan_restructures"."waived_fees") <= 2 AND scale("loan_restructures"."waived_penalty") <= 2 AND
        scale("loan_restructures"."net_principal") <= 2 AND scale("loan_restructures"."net_interest") <= 2 AND
        scale("loan_restructures"."net_fees") <= 2 AND scale("loan_restructures"."net_penalty") <= 2 AND
        scale("loan_restructures"."external_settlement_credits") <= 2 AND scale("loan_restructures"."external_credit_principal") <= 2 AND scale("loan_restructures"."external_credit_interest") <= 2 AND
        scale("loan_restructures"."external_credit_fees") <= 2 AND scale("loan_restructures"."external_credit_penalty") <= 2 AND scale("loan_restructures"."additional_principal") <= 2 AND scale("loan_restructures"."cash_amount") <= 2
    );