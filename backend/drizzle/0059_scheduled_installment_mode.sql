ALTER TABLE "loans"
    ADD COLUMN "scheduled_installment_mode" text;
--> statement-breakpoint
ALTER TABLE "loans"
    ADD CONSTRAINT "loans_scheduled_installment_mode_check"
    CHECK ("scheduled_installment_mode" IS NULL OR "scheduled_installment_mode" IN ('rate_derived', 'fixed_total'));
