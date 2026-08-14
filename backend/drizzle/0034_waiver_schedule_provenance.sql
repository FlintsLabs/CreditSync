ALTER TABLE "loan_waiver_previews" ADD COLUMN "settlement_date" date;--> statement-breakpoint
ALTER TABLE "loan_waiver_previews" ADD COLUMN "schedule_allocations" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "loan_restructure_waivers" ADD COLUMN "settlement_date" date;--> statement-breakpoint
ALTER TABLE "loan_restructure_waivers" ADD COLUMN "schedule_allocations" jsonb DEFAULT '[]'::jsonb NOT NULL;
