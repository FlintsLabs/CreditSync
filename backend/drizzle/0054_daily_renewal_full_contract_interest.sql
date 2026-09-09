ALTER TABLE "loan_renewals"
  ADD COLUMN "settlement_policy" text DEFAULT 'full_contract_interest' NOT NULL,
  ADD COLUMN "composition" jsonb;
--> statement-breakpoint
ALTER TABLE "loan_renewals"
  ADD CONSTRAINT "loan_renewals_settlement_policy_check"
  CHECK ("settlement_policy" IN ('full_contract_interest', 'accrued_to_date'));
--> statement-breakpoint
ALTER TABLE "loan_renewals" ALTER COLUMN "settlement_policy" DROP DEFAULT;
--> statement-breakpoint
CREATE TABLE "loan_renewal_adjustment_lines" (
  "id" serial PRIMARY KEY NOT NULL,
  "public_id" uuid DEFAULT uuidv7() NOT NULL,
  "tenant_id" text NOT NULL,
  "renewal_id" integer NOT NULL,
  "line_no" integer NOT NULL,
  "kind" text NOT NULL,
  "amount" numeric(30,2) NOT NULL,
  "reason" text NOT NULL,
  "status" text DEFAULT 'posted' NOT NULL,
  "reverses_line_id" integer,
  "actor_source" text NOT NULL,
  "request_id" text NOT NULL,
  "correlation_id" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "audit_public_id" uuid NOT NULL,
  "created_by_user_id" integer,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "loan_renewal_adjustment_lines_public_id_unique" UNIQUE("public_id"),
  CONSTRAINT "loan_renewal_adjustment_lines_amount_check" CHECK ("amount" > 0),
  CONSTRAINT "loan_renewal_adjustment_lines_reason_check" CHECK (length(btrim("reason")) > 0),
  CONSTRAINT "loan_renewal_adjustment_lines_kind_check" CHECK ("kind" IN ('fee','penalty','other_charge','waiver')),
  CONSTRAINT "loan_renewal_adjustment_lines_status_check" CHECK ("status" IN ('posted','reversed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "loan_renewal_adjustment_lines_tenant_id_id_unique"
  ON "loan_renewal_adjustment_lines" ("tenant_id", "id");
--> statement-breakpoint
CREATE UNIQUE INDEX "loan_renewal_adjustment_lines_tenant_renewal_line_unique"
  ON "loan_renewal_adjustment_lines" ("tenant_id", "renewal_id", "line_no");
--> statement-breakpoint
CREATE UNIQUE INDEX "loan_renewal_adjustment_lines_tenant_idempotency_unique"
  ON "loan_renewal_adjustment_lines" ("tenant_id", "idempotency_key");
--> statement-breakpoint
ALTER TABLE "loan_renewal_adjustment_lines"
  ADD CONSTRAINT "loan_renewal_adjustment_lines_tenant_renewal_fk"
  FOREIGN KEY ("tenant_id", "renewal_id") REFERENCES "loan_renewals"("tenant_id", "id");
--> statement-breakpoint
ALTER TABLE "loan_renewal_adjustment_lines"
  ADD CONSTRAINT "loan_renewal_adjustment_lines_tenant_reverses_fk"
  FOREIGN KEY ("tenant_id", "reverses_line_id") REFERENCES "loan_renewal_adjustment_lines"("tenant_id", "id");
--> statement-breakpoint
ALTER TABLE "loan_renewal_adjustment_lines"
  ADD CONSTRAINT "loan_renewal_adjustment_lines_tenant_audit_fk"
  FOREIGN KEY ("tenant_id", "audit_public_id") REFERENCES "audit_logs"("tenant_id", "public_id");
--> statement-breakpoint
ALTER TABLE "loan_renewal_adjustment_lines"
  ADD CONSTRAINT "loan_renewal_adjustment_lines_tenant_created_by_fk"
  FOREIGN KEY ("tenant_id", "created_by_user_id") REFERENCES "users"("tenant_id", "id");
--> statement-breakpoint
CREATE FUNCTION reject_immutable_loan_renewal_adjustment_line_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'loan renewal adjustment lines are immutable; % is not allowed', TG_OP;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "loan_renewal_adjustment_lines_immutable"
BEFORE UPDATE OR DELETE ON "loan_renewal_adjustment_lines"
FOR EACH ROW EXECUTE FUNCTION reject_immutable_loan_renewal_adjustment_line_mutation();
