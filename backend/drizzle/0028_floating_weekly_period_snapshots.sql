ALTER TABLE "loan_interest_accruals" ADD COLUMN "period_start_date" date;--> statement-breakpoint
ALTER TABLE "loan_interest_accruals" ADD COLUMN "period_end_date" date;--> statement-breakpoint
ALTER TABLE "loan_interest_accruals" ADD COLUMN "period_day_index" integer;--> statement-breakpoint
ALTER TABLE "loan_interest_accruals" ADD COLUMN "period_days" integer;--> statement-breakpoint
ALTER TABLE "loan_interest_accruals" ADD COLUMN "cumulative_interest_amount" numeric;--> statement-breakpoint
ALTER TABLE "loan_interest_accruals" ADD CONSTRAINT "loan_interest_accruals_status_check" CHECK ("loan_interest_accruals"."status" IN ('accrued', 'accruing', 'due', 'paid', 'partially_paid', 'reversed'));--> statement-breakpoint
ALTER TABLE "loan_interest_accruals" ADD CONSTRAINT "loan_interest_accruals_period_snapshot_check" CHECK (
    ("period_start_date" IS NULL AND "period_end_date" IS NULL AND "period_day_index" IS NULL
        AND "period_days" IS NULL AND "cumulative_interest_amount" IS NULL)
    OR
    ("period_start_date" IS NOT NULL AND "period_end_date" > "period_start_date"
        AND "period_day_index" BETWEEN 1 AND "period_days"
        AND "period_days" = 7 AND "cumulative_interest_amount" >= 0)
);--> statement-breakpoint

CREATE OR REPLACE FUNCTION protect_loan_interest_accrual_history()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'loan interest accrual history is append-only';
    END IF;

    IF NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
        OR NEW."loan_id" IS DISTINCT FROM OLD."loan_id"
        OR NEW."interest_rate_period_id" IS DISTINCT FROM OLD."interest_rate_period_id"
        OR NEW."accrual_date" IS DISTINCT FROM OLD."accrual_date"
        OR NEW."opening_principal" IS DISTINCT FROM OLD."opening_principal"
        OR NEW."rate_mode" IS DISTINCT FROM OLD."rate_mode"
        OR NEW."rate" IS DISTINCT FROM OLD."rate"
        OR NEW."period_start_date" IS DISTINCT FROM OLD."period_start_date"
        OR NEW."period_end_date" IS DISTINCT FROM OLD."period_end_date"
        OR NEW."period_day_index" IS DISTINCT FROM OLD."period_day_index"
        OR NEW."period_days" IS DISTINCT FROM OLD."period_days"
        OR NEW."cumulative_interest_amount" IS DISTINCT FROM OLD."cumulative_interest_amount"
        OR NEW."interest_amount" IS DISTINCT FROM OLD."interest_amount"
        OR NEW."reversed_accrual_id" IS DISTINCT FROM OLD."reversed_accrual_id"
        OR NEW."created_by_user_id" IS DISTINCT FROM OLD."created_by_user_id"
        OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
    THEN
        RAISE EXCEPTION 'loan interest accrual financial history is immutable';
    END IF;

    RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "loan_interest_accruals_history_immutable"
BEFORE UPDATE OR DELETE ON "loan_interest_accruals"
FOR EACH ROW EXECUTE FUNCTION protect_loan_interest_accrual_history();
