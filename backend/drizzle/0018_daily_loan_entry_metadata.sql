ALTER TABLE "loans" ADD COLUMN "daily_term_unit" text;--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN "daily_term_value" integer;--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN "daily_entry_mode" text;--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN "daily_interest_input_mode" text;--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN "daily_interest_input_value" numeric;--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN "daily_flat_rate_percent" numeric;--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loans_daily_term_unit_check" CHECK ("daily_term_unit" IS NULL OR "daily_term_unit" IN ('days', 'months'));--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loans_daily_term_value_check" CHECK ("daily_term_value" IS NULL OR "daily_term_value" > 0);--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loans_daily_entry_mode_check" CHECK ("daily_entry_mode" IS NULL OR "daily_entry_mode" IN ('daily_payment', 'daily_interest'));--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loans_daily_interest_input_mode_check" CHECK ("daily_interest_input_mode" IS NULL OR "daily_interest_input_mode" IN ('percent', 'fixed_amount', 'per_thousand'));--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loans_daily_entry_consistency_check" CHECK (
  "daily_entry_mode" IS NULL OR (
    "repayment_type" = 'daily' AND "daily_term_unit" IS NOT NULL AND "daily_term_value" IS NOT NULL AND "daily_flat_rate_percent" IS NOT NULL AND
    (
      "daily_entry_mode" = 'daily_payment' AND "daily_interest_input_mode" IS NULL AND "daily_interest_input_value" IS NULL
    ) OR (
      "daily_entry_mode" = 'daily_interest' AND "daily_interest_input_mode" IS NOT NULL AND "daily_interest_input_value" IS NOT NULL
    )
  )
);
