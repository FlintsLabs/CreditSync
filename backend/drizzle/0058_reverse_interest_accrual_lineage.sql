ALTER TABLE "loan_interest_accruals"
    ADD COLUMN "materialization_source" text,
    ADD COLUMN "source_payment_intake_id" integer,
    ADD COLUMN "source_reversal_transaction_id" integer,
    ADD COLUMN "materialization_reason" text;
--> statement-breakpoint
ALTER TABLE "loan_interest_accruals"
    ADD CONSTRAINT "loan_interest_accruals_materialization_source_check"
    CHECK ("materialization_source" IS NULL OR "materialization_source" IN ('scheduled', 'payment_reversal', 'manual'));
--> statement-breakpoint
ALTER TABLE "loan_interest_accruals"
    ADD CONSTRAINT "loan_interest_accruals_source_payment_intake_fk"
    FOREIGN KEY ("tenant_id", "source_payment_intake_id")
    REFERENCES "public"."payment_intakes"("tenant_id", "id");
--> statement-breakpoint
ALTER TABLE "loan_interest_accruals"
    ADD CONSTRAINT "loan_interest_accruals_source_reversal_transaction_fk"
    FOREIGN KEY ("tenant_id", "source_reversal_transaction_id")
    REFERENCES "public"."transactions"("tenant_id", "id");
--> statement-breakpoint
ALTER TABLE "loan_interest_accruals"
    ADD CONSTRAINT "loan_interest_accruals_materialization_reason_check"
    CHECK ("materialization_source" IS NULL OR length(btrim("materialization_reason")) > 0);
--> statement-breakpoint
CREATE INDEX "loan_interest_accruals_tenant_source_payment_idx"
    ON "loan_interest_accruals" USING btree ("tenant_id", "source_payment_intake_id");
