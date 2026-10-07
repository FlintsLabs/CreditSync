CREATE UNIQUE INDEX IF NOT EXISTS "payment_match_allocations_tenant_id_loan_unique" ON "payment_match_allocations" ("tenant_id", "id", "loan_id");
CREATE TABLE "payment_match_floating_targets" (
  "id" serial PRIMARY KEY NOT NULL,
  "public_id" uuid DEFAULT uuidv7() NOT NULL UNIQUE,
  "tenant_id" text NOT NULL,
  "allocation_id" integer NOT NULL,
  "loan_id" integer NOT NULL,
  "accrual_date" date NOT NULL,
  "amount" numeric NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "payment_match_floating_targets_amount_check" CHECK ("amount" > 0 AND scale("amount") <= 2 AND "amount" NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)),
  CONSTRAINT "payment_match_floating_targets_tenant_allocation_loan_fk" FOREIGN KEY ("tenant_id", "allocation_id", "loan_id") REFERENCES "payment_match_allocations"("tenant_id", "id", "loan_id")
);
CREATE UNIQUE INDEX "payment_match_floating_targets_tenant_id_unique" ON "payment_match_floating_targets" ("tenant_id", "id");
CREATE UNIQUE INDEX "payment_match_floating_targets_allocation_date_unique" ON "payment_match_floating_targets" ("tenant_id", "allocation_id", "accrual_date");
CREATE INDEX "payment_match_floating_targets_tenant_loan_date_idx" ON "payment_match_floating_targets" ("tenant_id", "loan_id", "accrual_date");
CREATE OR REPLACE FUNCTION reject_payment_match_floating_target_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'selected floating accrual targets are immutable'; END; $$;
CREATE TRIGGER "payment_match_floating_targets_immutable" BEFORE UPDATE OR DELETE ON "payment_match_floating_targets" FOR EACH ROW EXECUTE FUNCTION reject_payment_match_floating_target_mutation();
