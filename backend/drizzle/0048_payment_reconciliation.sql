CREATE TABLE IF NOT EXISTS "payment_reconciliation_proposals" (
  "id" serial PRIMARY KEY,
  "public_id" uuid DEFAULT uuidv7() NOT NULL UNIQUE,
  "tenant_id" text NOT NULL,
  "payment_intake_id" integer NOT NULL,
  "status" text DEFAULT 'ready' NOT NULL,
  "preview_hash" text NOT NULL,
  "expected_balance_version" text NOT NULL,
  "source_snapshot" jsonb NOT NULL,
  "proposed_allocations" jsonb NOT NULL,
  "warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "reason" text NOT NULL,
  "expires_at" timestamp NOT NULL,
  "created_by_user_id" integer,
  "executed_by_user_id" integer,
  "executed_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "payment_reconciliation_proposals_status_check" CHECK ("status" IN ('ready', 'executed', 'expired')),
  CONSTRAINT "payment_reconciliation_proposals_tenant_intake_fk" FOREIGN KEY ("tenant_id", "payment_intake_id") REFERENCES "payment_intakes"("tenant_id", "id"),
  CONSTRAINT "payment_reconciliation_proposals_tenant_created_by_fk" FOREIGN KEY ("tenant_id", "created_by_user_id") REFERENCES "users"("tenant_id", "id"),
  CONSTRAINT "payment_reconciliation_proposals_tenant_executed_by_fk" FOREIGN KEY ("tenant_id", "executed_by_user_id") REFERENCES "users"("tenant_id", "id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "payment_reconciliation_proposals_tenant_id_id_unique" ON "payment_reconciliation_proposals" ("tenant_id", "id");
CREATE INDEX IF NOT EXISTS "payment_reconciliation_proposals_tenant_intake_idx" ON "payment_reconciliation_proposals" ("tenant_id", "payment_intake_id", "created_at");

CREATE TABLE IF NOT EXISTS "payment_reconciliation_groups" (
  "id" serial PRIMARY KEY,
  "public_id" uuid DEFAULT uuidv7() NOT NULL UNIQUE,
  "tenant_id" text NOT NULL,
  "proposal_id" integer NOT NULL,
  "payment_intake_id" integer NOT NULL,
  "status" text DEFAULT 'executed' NOT NULL,
  "reason" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "correlation_id" text NOT NULL,
  "audit_public_id" uuid NOT NULL,
  "created_by_user_id" integer,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "payment_reconciliation_groups_status_check" CHECK ("status" = 'executed'),
  CONSTRAINT "payment_reconciliation_groups_tenant_proposal_fk" FOREIGN KEY ("tenant_id", "proposal_id") REFERENCES "payment_reconciliation_proposals"("tenant_id", "id"),
  CONSTRAINT "payment_reconciliation_groups_tenant_intake_fk" FOREIGN KEY ("tenant_id", "payment_intake_id") REFERENCES "payment_intakes"("tenant_id", "id"),
  CONSTRAINT "payment_reconciliation_groups_tenant_audit_fk" FOREIGN KEY ("tenant_id", "audit_public_id") REFERENCES "audit_logs"("tenant_id", "public_id"),
  CONSTRAINT "payment_reconciliation_groups_tenant_created_by_fk" FOREIGN KEY ("tenant_id", "created_by_user_id") REFERENCES "users"("tenant_id", "id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "payment_reconciliation_groups_tenant_id_id_unique" ON "payment_reconciliation_groups" ("tenant_id", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "payment_reconciliation_groups_tenant_idempotency_unique" ON "payment_reconciliation_groups" ("tenant_id", "idempotency_key");

CREATE TABLE IF NOT EXISTS "payment_reconciliation_entries" (
  "id" serial PRIMARY KEY,
  "public_id" uuid DEFAULT uuidv7() NOT NULL UNIQUE,
  "tenant_id" text NOT NULL,
  "group_id" integer NOT NULL,
  "entry_type" text NOT NULL,
  "component" text NOT NULL,
  "amount" numeric NOT NULL,
  "principal_component" numeric DEFAULT 0 NOT NULL,
  "interest_component" numeric DEFAULT 0 NOT NULL,
  "fee_component" numeric DEFAULT 0 NOT NULL,
  "penalty_component" numeric DEFAULT 0 NOT NULL,
  "source_transaction_id" integer,
  "source_allocation_id" integer,
  "transaction_id" integer,
  "loan_id" integer NOT NULL,
  "schedule_id" integer,
  "reason" text NOT NULL,
  "audit_public_id" uuid NOT NULL,
  "created_by_user_id" integer,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "payment_reconciliation_entries_type_check" CHECK ("entry_type" IN ('reversal', 'replacement')),
  CONSTRAINT "payment_reconciliation_entries_component_check" CHECK ("component" IN ('interest', 'principal', 'fee', 'penalty', 'mixed')),
  CONSTRAINT "payment_reconciliation_entries_tenant_group_fk" FOREIGN KEY ("tenant_id", "group_id") REFERENCES "payment_reconciliation_groups"("tenant_id", "id"),
  CONSTRAINT "payment_reconciliation_entries_tenant_source_tx_fk" FOREIGN KEY ("tenant_id", "source_transaction_id") REFERENCES "transactions"("tenant_id", "id"),
  CONSTRAINT "payment_reconciliation_entries_tenant_tx_fk" FOREIGN KEY ("tenant_id", "transaction_id") REFERENCES "transactions"("tenant_id", "id"),
  CONSTRAINT "payment_reconciliation_entries_tenant_loan_fk" FOREIGN KEY ("tenant_id", "loan_id") REFERENCES "loans"("tenant_id", "id"),
  CONSTRAINT "payment_reconciliation_entries_tenant_schedule_fk" FOREIGN KEY ("tenant_id", "schedule_id") REFERENCES "loan_schedules"("tenant_id", "id"),
  CONSTRAINT "payment_reconciliation_entries_tenant_audit_fk" FOREIGN KEY ("tenant_id", "audit_public_id") REFERENCES "audit_logs"("tenant_id", "public_id"),
  CONSTRAINT "payment_reconciliation_entries_tenant_created_by_fk" FOREIGN KEY ("tenant_id", "created_by_user_id") REFERENCES "users"("tenant_id", "id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "payment_reconciliation_entries_tenant_id_id_unique" ON "payment_reconciliation_entries" ("tenant_id", "id");
CREATE INDEX IF NOT EXISTS "payment_reconciliation_entries_tenant_group_idx" ON "payment_reconciliation_entries" ("tenant_id", "group_id", "id");

CREATE OR REPLACE FUNCTION reject_immutable_payment_reconciliation_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'payment_reconciliation_proposals' AND OLD.status = 'executed' THEN
    RAISE EXCEPTION 'executed payment reconciliation proposals are immutable; % is not allowed', TG_OP;
  ELSIF TG_TABLE_NAME = 'payment_reconciliation_groups' THEN
    RAISE EXCEPTION 'executed payment reconciliation groups are immutable; % is not allowed', TG_OP;
  ELSIF TG_TABLE_NAME = 'payment_reconciliation_entries' THEN
    RAISE EXCEPTION 'payment reconciliation entries are immutable; % is not allowed', TG_OP;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS payment_reconciliation_proposals_executed_immutable ON "payment_reconciliation_proposals";
CREATE TRIGGER payment_reconciliation_proposals_executed_immutable BEFORE UPDATE OR DELETE ON "payment_reconciliation_proposals" FOR EACH ROW EXECUTE FUNCTION reject_immutable_payment_reconciliation_mutation();
DROP TRIGGER IF EXISTS payment_reconciliation_groups_immutable ON "payment_reconciliation_groups";
CREATE TRIGGER payment_reconciliation_groups_immutable BEFORE UPDATE OR DELETE ON "payment_reconciliation_groups" FOR EACH ROW EXECUTE FUNCTION reject_immutable_payment_reconciliation_mutation();
DROP TRIGGER IF EXISTS payment_reconciliation_entries_immutable ON "payment_reconciliation_entries";
CREATE TRIGGER payment_reconciliation_entries_immutable BEFORE UPDATE OR DELETE ON "payment_reconciliation_entries" FOR EACH ROW EXECUTE FUNCTION reject_immutable_payment_reconciliation_mutation();
