ALTER TABLE "loan_funding_allocations" ADD COLUMN "renewal_id" integer;--> statement-breakpoint
ALTER TABLE "loan_funding_allocations" ADD COLUMN "allocation_group_id" uuid;--> statement-breakpoint
ALTER TABLE "loan_funding_allocations" ADD COLUMN "reversed_allocation_id" integer;--> statement-breakpoint
ALTER TABLE "loan_renewals" ADD COLUMN "reversal_idempotency_key" text;--> statement-breakpoint
ALTER TABLE "loan_renewals" ADD COLUMN "reversal_request_hash" text;--> statement-breakpoint
ALTER TABLE "loan_renewals" ADD COLUMN "pre_execution_loan_state" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "loan_funding_allocations_tenant_id_id_unique" ON "loan_funding_allocations" USING btree ("tenant_id","id");--> statement-breakpoint
ALTER TABLE "loan_funding_allocations" ADD CONSTRAINT "loan_funding_allocations_tenant_renewal_fk" FOREIGN KEY ("tenant_id","renewal_id") REFERENCES "public"."loan_renewals"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_funding_allocations" ADD CONSTRAINT "loan_funding_allocations_tenant_reversed_allocation_fk" FOREIGN KEY ("tenant_id","reversed_allocation_id") REFERENCES "public"."loan_funding_allocations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "loan_funding_allocations_tenant_reversed_allocation_unique" ON "loan_funding_allocations" USING btree ("tenant_id","reversed_allocation_id") WHERE "loan_funding_allocations"."reversed_allocation_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "loan_renewals_tenant_reversal_idempotency_unique" ON "loan_renewals" USING btree ("tenant_id","reversal_idempotency_key") WHERE "loan_renewals"."reversal_idempotency_key" IS NOT NULL;
