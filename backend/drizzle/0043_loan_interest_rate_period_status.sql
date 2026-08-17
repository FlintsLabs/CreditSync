ALTER TABLE "loan_interest_rate_periods"
ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'posted' NOT NULL;--> statement-breakpoint
