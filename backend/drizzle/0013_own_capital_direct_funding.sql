ALTER TABLE "bank_profiles" ADD COLUMN "opportunity_cost_rate" numeric NOT NULL DEFAULT 2.00;--> statement-breakpoint
ALTER TABLE "bank_profiles" ADD CONSTRAINT "bank_profiles_opportunity_cost_rate_nonnegative" CHECK ("opportunity_cost_rate" >= 0);
