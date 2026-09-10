ALTER TABLE "payment_batch_staging_items" ADD COLUMN "resolution_state" text DEFAULT 'unresolved' NOT NULL;
--> statement-breakpoint
UPDATE "payment_batch_staging_items" SET "resolution_state" = 'mapped' WHERE "reviewed_mapping" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "payment_batch_staging_items" ADD CONSTRAINT "payment_batch_staging_resolution_state_check" CHECK ("resolution_state" IN ('unresolved', 'mapped', 'cleared'));
