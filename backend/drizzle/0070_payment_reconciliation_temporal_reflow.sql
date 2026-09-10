CREATE TABLE "payment_reconciliation_reflow_proposals" (
  "id" serial PRIMARY KEY NOT NULL,
  "public_id" uuid DEFAULT uuidv7() NOT NULL,
  "tenant_id" text NOT NULL,
  "reconciliation_group_id" integer NOT NULL,
  "status" text DEFAULT 'ready' NOT NULL,
  "preview_hash" text NOT NULL,
  "expected_balance_version" text NOT NULL,
  "source_snapshot" jsonb NOT NULL,
  "proposed_reflow" jsonb NOT NULL,
  "warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "reason" text NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "created_by_user_id" integer,
  "executed_by_user_id" integer,
  "executed_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "payment_reconciliation_reflow_proposals_public_id_unique" UNIQUE("public_id"),
  CONSTRAINT "payment_reconciliation_reflow_proposals_status_check" CHECK ("status" IN ('ready', 'executed', 'expired')),
  CONSTRAINT "payment_reconciliation_reflow_proposals_reason_check" CHECK (length(trim("reason")) > 0),
  CONSTRAINT "payment_reconciliation_reflow_proposals_tenant_group_fk" FOREIGN KEY ("tenant_id", "reconciliation_group_id") REFERENCES "payment_reconciliation_groups"("tenant_id", "id"),
  CONSTRAINT "payment_reconciliation_reflow_proposals_tenant_created_by_fk" FOREIGN KEY ("tenant_id", "created_by_user_id") REFERENCES "users"("tenant_id", "id"),
  CONSTRAINT "payment_reconciliation_reflow_proposals_tenant_executed_by_fk" FOREIGN KEY ("tenant_id", "executed_by_user_id") REFERENCES "users"("tenant_id", "id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "payment_reconciliation_reflow_proposals_tenant_id_id_unique" ON "payment_reconciliation_reflow_proposals" ("tenant_id", "id");
--> statement-breakpoint
CREATE INDEX "payment_reconciliation_reflow_proposals_tenant_group_idx" ON "payment_reconciliation_reflow_proposals" ("tenant_id", "reconciliation_group_id", "created_at");
--> statement-breakpoint
CREATE TABLE "payment_reconciliation_reflow_groups" (
  "id" serial PRIMARY KEY NOT NULL,
  "public_id" uuid DEFAULT uuidv7() NOT NULL,
  "tenant_id" text NOT NULL,
  "reconciliation_group_id" integer NOT NULL,
  "proposal_id" integer,
  "origin" text NOT NULL,
  "status" text DEFAULT 'executed' NOT NULL,
  "reason" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "correlation_id" text NOT NULL,
  "audit_public_id" uuid NOT NULL,
  "created_by_user_id" integer,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "payment_reconciliation_reflow_groups_public_id_unique" UNIQUE("public_id"),
  CONSTRAINT "payment_reconciliation_reflow_groups_status_check" CHECK ("status" = 'executed'),
  CONSTRAINT "payment_reconciliation_reflow_groups_origin_check" CHECK ("origin" IN ('automatic', 'repair')),
  CONSTRAINT "payment_reconciliation_reflow_groups_reason_check" CHECK (length(trim("reason")) > 0),
  CONSTRAINT "payment_reconciliation_reflow_groups_repair_proposal_check" CHECK (("origin" = 'repair' AND "proposal_id" IS NOT NULL) OR ("origin" = 'automatic' AND "proposal_id" IS NULL)),
  CONSTRAINT "payment_reconciliation_reflow_groups_tenant_reconciliation_fk" FOREIGN KEY ("tenant_id", "reconciliation_group_id") REFERENCES "payment_reconciliation_groups"("tenant_id", "id"),
  CONSTRAINT "payment_reconciliation_reflow_groups_tenant_proposal_fk" FOREIGN KEY ("tenant_id", "proposal_id") REFERENCES "payment_reconciliation_reflow_proposals"("tenant_id", "id"),
  CONSTRAINT "payment_reconciliation_reflow_groups_tenant_audit_fk" FOREIGN KEY ("tenant_id", "audit_public_id") REFERENCES "audit_logs"("tenant_id", "public_id"),
  CONSTRAINT "payment_reconciliation_reflow_groups_tenant_created_by_fk" FOREIGN KEY ("tenant_id", "created_by_user_id") REFERENCES "users"("tenant_id", "id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "payment_reconciliation_reflow_groups_tenant_id_id_unique" ON "payment_reconciliation_reflow_groups" ("tenant_id", "id");
--> statement-breakpoint
CREATE UNIQUE INDEX "payment_reconciliation_reflow_groups_tenant_idempotency_unique" ON "payment_reconciliation_reflow_groups" ("tenant_id", "idempotency_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "reflow_groups_reconciliation_unique" ON "payment_reconciliation_reflow_groups" ("tenant_id", "reconciliation_group_id");
--> statement-breakpoint
CREATE TABLE "payment_reconciliation_reflow_entries" (
  "id" serial PRIMARY KEY NOT NULL,
  "public_id" uuid DEFAULT uuidv7() NOT NULL,
  "tenant_id" text NOT NULL,
  "group_id" integer NOT NULL,
  "loan_id" integer NOT NULL,
  "transaction_id" integer NOT NULL,
  "source_allocation_id" integer NOT NULL,
  "reversal_allocation_id" integer NOT NULL,
  "replacement_allocation_id" integer NOT NULL,
  "effective_date" date NOT NULL,
  "old_due_date" date NOT NULL,
  "new_due_date" date NOT NULL,
  "displaced_amount" numeric NOT NULL,
  "audit_public_id" uuid NOT NULL,
  "created_by_user_id" integer,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "payment_reconciliation_reflow_entries_public_id_unique" UNIQUE("public_id"),
  CONSTRAINT "payment_reconciliation_reflow_entries_amount_check" CHECK ("displaced_amount" > 0 AND scale("displaced_amount") <= 2 AND "displaced_amount" NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)),
  CONSTRAINT "payment_reconciliation_reflow_entries_tenant_group_fk" FOREIGN KEY ("tenant_id", "group_id") REFERENCES "payment_reconciliation_reflow_groups"("tenant_id", "id"),
  CONSTRAINT "payment_reconciliation_reflow_entries_tenant_loan_fk" FOREIGN KEY ("tenant_id", "loan_id") REFERENCES "loans"("tenant_id", "id"),
  CONSTRAINT "payment_reconciliation_reflow_entries_tenant_transaction_fk" FOREIGN KEY ("tenant_id", "loan_id", "transaction_id") REFERENCES "transactions"("tenant_id", "loan_id", "id"),
  CONSTRAINT "reflow_entries_source_alloc_fk" FOREIGN KEY ("tenant_id", "loan_id", "source_allocation_id") REFERENCES "floating_transaction_allocations"("tenant_id", "loan_id", "id"),
  CONSTRAINT "reflow_entries_reversal_alloc_fk" FOREIGN KEY ("tenant_id", "loan_id", "reversal_allocation_id") REFERENCES "floating_transaction_allocations"("tenant_id", "loan_id", "id"),
  CONSTRAINT "reflow_entries_replacement_alloc_fk" FOREIGN KEY ("tenant_id", "loan_id", "replacement_allocation_id") REFERENCES "floating_transaction_allocations"("tenant_id", "loan_id", "id"),
  CONSTRAINT "payment_reconciliation_reflow_entries_tenant_audit_fk" FOREIGN KEY ("tenant_id", "audit_public_id") REFERENCES "audit_logs"("tenant_id", "public_id"),
  CONSTRAINT "payment_reconciliation_reflow_entries_tenant_created_by_fk" FOREIGN KEY ("tenant_id", "created_by_user_id") REFERENCES "users"("tenant_id", "id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "payment_reconciliation_reflow_entries_tenant_id_id_unique" ON "payment_reconciliation_reflow_entries" ("tenant_id", "id");
--> statement-breakpoint
CREATE UNIQUE INDEX "payment_reconciliation_reflow_entries_source_unique" ON "payment_reconciliation_reflow_entries" ("tenant_id", "source_allocation_id");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION reject_payment_reconciliation_reflow_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payment reconciliation reflow provenance is immutable';
  END IF;
  IF TG_TABLE_NAME IN ('payment_reconciliation_reflow_groups', 'payment_reconciliation_reflow_entries') THEN
    RAISE EXCEPTION 'payment reconciliation reflow provenance is immutable';
  END IF;
  IF OLD.status = 'ready' AND NEW.status IN ('executed', 'expired')
     AND NEW.reconciliation_group_id = OLD.reconciliation_group_id
     AND NEW.preview_hash = OLD.preview_hash
     AND NEW.expected_balance_version = OLD.expected_balance_version
     AND NEW.source_snapshot = OLD.source_snapshot
     AND NEW.proposed_reflow = OLD.proposed_reflow
     AND NEW.warnings = OLD.warnings
     AND NEW.reason = OLD.reason
     AND NEW.expires_at = OLD.expires_at
  THEN RETURN NEW;
  END IF;
  RAISE EXCEPTION 'payment reconciliation reflow proposal content is immutable';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "payment_reconciliation_reflow_proposals_immutable" BEFORE UPDATE OR DELETE ON "payment_reconciliation_reflow_proposals" FOR EACH ROW EXECUTE FUNCTION reject_payment_reconciliation_reflow_mutation();
--> statement-breakpoint
CREATE TRIGGER "payment_reconciliation_reflow_groups_immutable" BEFORE UPDATE OR DELETE ON "payment_reconciliation_reflow_groups" FOR EACH ROW EXECUTE FUNCTION reject_payment_reconciliation_reflow_mutation();
--> statement-breakpoint
CREATE TRIGGER "payment_reconciliation_reflow_entries_immutable" BEFORE UPDATE OR DELETE ON "payment_reconciliation_reflow_entries" FOR EACH ROW EXECUTE FUNCTION reject_payment_reconciliation_reflow_mutation();
