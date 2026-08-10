ALTER TABLE "payment_intakes" ADD COLUMN "origin_loan_id" integer;
--> statement-breakpoint
ALTER TABLE "payment_intakes" ADD CONSTRAINT "payment_intakes_tenant_origin_loan_fk"
FOREIGN KEY ("tenant_id", "origin_loan_id") REFERENCES "loans"("tenant_id", "id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "payment_intakes_tenant_origin_loan_received_at_idx"
ON "payment_intakes" USING btree ("tenant_id", "origin_loan_id", "received_at");
