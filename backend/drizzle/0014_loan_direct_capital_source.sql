ALTER TABLE "loans" ADD COLUMN "funding_bank_profile_id" integer;--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loans_funding_bank_profile_fk" FOREIGN KEY ("funding_bank_profile_id") REFERENCES "public"."bank_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loans_one_funding_source_check" CHECK ("bank_loan_id" IS NULL OR "funding_bank_profile_id" IS NULL);
