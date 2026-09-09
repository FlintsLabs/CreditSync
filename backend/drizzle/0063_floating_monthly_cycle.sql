ALTER TABLE "loans" DROP CONSTRAINT IF EXISTS "loans_floating_accrual_cycle_check";
ALTER TABLE "loans" ADD CONSTRAINT "loans_floating_accrual_cycle_check" CHECK ((repayment_type = 'floating' AND floating_accrual_cycle IN ('daily', 'weekly', 'monthly')) OR (repayment_type <> 'floating' AND floating_accrual_cycle IS NULL));
ALTER TABLE "loans" DROP CONSTRAINT IF EXISTS "loans_interest_period_unit_check";
ALTER TABLE "loans" ADD CONSTRAINT "loans_interest_period_unit_check" CHECK (interest_period_unit IS NULL OR interest_period_unit IN ('day', 'week', 'month'));
DO $$
BEGIN
    IF to_regclass('public.loan_interest_rate_periods') IS NOT NULL
        AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'loan_interest_rate_periods' AND column_name = 'period_unit') THEN
        ALTER TABLE "loan_interest_rate_periods" DROP CONSTRAINT IF EXISTS "loan_interest_rate_periods_period_unit_check";
        ALTER TABLE "loan_interest_rate_periods" ADD CONSTRAINT "loan_interest_rate_periods_period_unit_check" CHECK (period_unit IN ('day', 'week', 'month'));
    END IF;
    IF to_regclass('public.loan_interest_accruals') IS NOT NULL
        AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'loan_interest_accruals' AND column_name = 'period_unit') THEN
        ALTER TABLE "loan_interest_accruals" DROP CONSTRAINT IF EXISTS "loan_interest_accruals_period_unit_check";
        ALTER TABLE "loan_interest_accruals" ADD CONSTRAINT "loan_interest_accruals_period_unit_check" CHECK (period_unit IS NULL OR period_unit IN ('day', 'week', 'month'));
        ALTER TABLE "loan_interest_accruals" DROP CONSTRAINT IF EXISTS "loan_interest_accruals_period_snapshot_check";
        ALTER TABLE "loan_interest_accruals" ADD CONSTRAINT "loan_interest_accruals_period_snapshot_check" CHECK (
            (period_start_date IS NULL AND period_end_date IS NULL AND period_day_index IS NULL AND period_days IS NULL AND cumulative_interest_amount IS NULL)
            OR (period_start_date IS NOT NULL AND period_end_date > period_start_date
                AND period_day_index BETWEEN 1 AND COALESCE(period_days, CASE period_unit WHEN 'week' THEN 7 ELSE 1 END)
                AND (period_days IS NULL OR (period_unit = 'day' AND period_days = 1) OR (period_unit = 'week' AND period_days = 7) OR (period_unit = 'month' AND period_days BETWEEN 28 AND 31))
                AND cumulative_interest_amount >= 0)
        );
        ALTER TABLE "loan_interest_accruals" DROP CONSTRAINT IF EXISTS "loan_interest_accruals_period_day_index_check";
        ALTER TABLE "loan_interest_accruals" ADD CONSTRAINT "loan_interest_accruals_period_day_index_check" CHECK (
            period_day_index IS NULL OR (period_day_index >= 1 AND ((period_unit = 'day' AND period_day_index <= 1) OR (period_unit = 'week' AND period_day_index <= 7) OR (period_unit = 'month' AND period_day_index <= 31)))
        );
    END IF;
END $$;
