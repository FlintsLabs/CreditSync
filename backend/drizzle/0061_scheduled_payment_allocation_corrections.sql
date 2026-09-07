CREATE TABLE IF NOT EXISTS "payment_allocation_correction_previews" (
  "id" serial PRIMARY KEY, "public_id" uuid DEFAULT uuidv7() NOT NULL UNIQUE, "tenant_id" text NOT NULL,
  "payment_intake_id" integer NOT NULL, "source_transaction_id" integer NOT NULL, "source_schedule_id" integer NOT NULL,
  "target_schedule_id" integer NOT NULL, "loan_id" integer NOT NULL, "status" text DEFAULT 'ready' NOT NULL,
  "amount" numeric NOT NULL, "principal_component" numeric DEFAULT 0 NOT NULL, "interest_component" numeric DEFAULT 0 NOT NULL,
  "fee_component" numeric DEFAULT 0 NOT NULL, "penalty_component" numeric DEFAULT 0 NOT NULL,
  "source_snapshot" jsonb NOT NULL, "target_snapshot" jsonb NOT NULL, "proposed_projection" jsonb NOT NULL,
  "warnings" jsonb DEFAULT '[]'::jsonb NOT NULL, "preview_hash" text NOT NULL, "expected_balance_version" text NOT NULL,
  "reason" text NOT NULL, "expires_at" timestamp NOT NULL, "created_by_user_id" integer, "executed_by_user_id" integer,
  "executed_at" timestamp, "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "payment_allocation_correction_previews_status_check" CHECK ("status" IN ('ready','blocked','executed','expired')),
  CONSTRAINT "payment_allocation_correction_previews_reason_check" CHECK (length(btrim("reason")) > 0),
  CONSTRAINT "payment_allocation_correction_previews_amount_check" CHECK ("amount" > 0 AND scale("amount") <= 2 AND "amount" = "principal_component" + "interest_component" + "fee_component" + "penalty_component"),
  CONSTRAINT "payment_allocation_correction_previews_tenant_intake_fk" FOREIGN KEY ("tenant_id","payment_intake_id") REFERENCES "payment_intakes"("tenant_id","id"),
  CONSTRAINT "payment_allocation_correction_previews_tenant_source_tx_fk" FOREIGN KEY ("tenant_id","source_transaction_id") REFERENCES "transactions"("tenant_id","id"),
  CONSTRAINT "payment_allocation_correction_previews_tenant_source_schedule_fk" FOREIGN KEY ("tenant_id","source_schedule_id") REFERENCES "loan_schedules"("tenant_id","id"),
  CONSTRAINT "payment_allocation_correction_previews_tenant_target_schedule_fk" FOREIGN KEY ("tenant_id","target_schedule_id") REFERENCES "loan_schedules"("tenant_id","id"),
  CONSTRAINT "payment_allocation_correction_previews_tenant_loan_fk" FOREIGN KEY ("tenant_id","loan_id") REFERENCES "loans"("tenant_id","id"),
  CONSTRAINT "payment_allocation_correction_previews_tenant_created_by_fk" FOREIGN KEY ("tenant_id","created_by_user_id") REFERENCES "users"("tenant_id","id"),
  CONSTRAINT "payment_allocation_correction_previews_tenant_executed_by_fk" FOREIGN KEY ("tenant_id","executed_by_user_id") REFERENCES "users"("tenant_id","id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "payment_allocation_correction_previews_tenant_id_id_unique" ON "payment_allocation_correction_previews"("tenant_id","id");
CREATE INDEX IF NOT EXISTS "payment_allocation_correction_previews_tenant_source_idx" ON "payment_allocation_correction_previews"("tenant_id","source_transaction_id","created_at");

CREATE TABLE IF NOT EXISTS "payment_allocation_correction_groups" (
  "id" serial PRIMARY KEY, "public_id" uuid DEFAULT uuidv7() NOT NULL UNIQUE, "tenant_id" text NOT NULL,
  "preview_id" integer NOT NULL, "payment_intake_id" integer NOT NULL, "source_transaction_id" integer NOT NULL,
  "source_schedule_id" integer NOT NULL, "target_schedule_id" integer NOT NULL, "loan_id" integer NOT NULL,
  "reason" text NOT NULL, "idempotency_key" text NOT NULL, "request_hash" text NOT NULL, "correlation_id" text NOT NULL, "audit_public_id" uuid NOT NULL,
  "created_by_user_id" integer, "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "payment_allocation_correction_groups_tenant_preview_fk" FOREIGN KEY ("tenant_id","preview_id") REFERENCES "payment_allocation_correction_previews"("tenant_id","id"),
  CONSTRAINT "payment_allocation_correction_groups_tenant_intake_fk" FOREIGN KEY ("tenant_id","payment_intake_id") REFERENCES "payment_intakes"("tenant_id","id"),
  CONSTRAINT "payment_allocation_correction_groups_tenant_source_tx_fk" FOREIGN KEY ("tenant_id","source_transaction_id") REFERENCES "transactions"("tenant_id","id"),
  CONSTRAINT "payment_allocation_correction_groups_tenant_source_schedule_fk" FOREIGN KEY ("tenant_id","source_schedule_id") REFERENCES "loan_schedules"("tenant_id","id"),
  CONSTRAINT "payment_allocation_correction_groups_tenant_target_schedule_fk" FOREIGN KEY ("tenant_id","target_schedule_id") REFERENCES "loan_schedules"("tenant_id","id"),
  CONSTRAINT "payment_allocation_correction_groups_tenant_loan_fk" FOREIGN KEY ("tenant_id","loan_id") REFERENCES "loans"("tenant_id","id"),
  CONSTRAINT "payment_allocation_correction_groups_tenant_audit_fk" FOREIGN KEY ("tenant_id","audit_public_id") REFERENCES "audit_logs"("tenant_id","public_id"),
  CONSTRAINT "payment_allocation_correction_groups_tenant_created_by_fk" FOREIGN KEY ("tenant_id","created_by_user_id") REFERENCES "users"("tenant_id","id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "payment_allocation_correction_groups_tenant_id_id_unique" ON "payment_allocation_correction_groups"("tenant_id","id");
CREATE UNIQUE INDEX IF NOT EXISTS "payment_allocation_correction_groups_tenant_idempotency_unique" ON "payment_allocation_correction_groups"("tenant_id","idempotency_key");
CREATE UNIQUE INDEX IF NOT EXISTS "payment_allocation_correction_groups_tenant_source_unique" ON "payment_allocation_correction_groups"("tenant_id","source_transaction_id");
ALTER TABLE "payment_allocation_correction_groups" ADD CONSTRAINT "payment_allocation_correction_groups_reason_check" CHECK (length(btrim("reason")) > 0);
ALTER TABLE "payment_allocation_correction_groups" ADD CONSTRAINT "payment_allocation_correction_groups_idempotency_check" CHECK (length(btrim("idempotency_key")) > 0);

CREATE TABLE IF NOT EXISTS "payment_allocation_correction_entries" (
  "id" serial PRIMARY KEY, "public_id" uuid DEFAULT uuidv7() NOT NULL UNIQUE, "tenant_id" text NOT NULL,
  "group_id" integer NOT NULL, "entry_type" text NOT NULL, "source_transaction_id" integer NOT NULL, "transaction_id" integer NOT NULL,
  "loan_id" integer NOT NULL, "schedule_id" integer NOT NULL, "amount" numeric NOT NULL,
  "principal_component" numeric NOT NULL, "interest_component" numeric NOT NULL, "fee_component" numeric NOT NULL, "penalty_component" numeric NOT NULL,
  "reason" text NOT NULL, "audit_public_id" uuid NOT NULL, "created_by_user_id" integer, "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "payment_allocation_correction_entries_type_check" CHECK ("entry_type" IN ('reversal','replacement')),
  CONSTRAINT "payment_allocation_correction_entries_reason_check" CHECK (length(btrim("reason")) > 0),
  CONSTRAINT "payment_allocation_correction_entries_amount_scale_check" CHECK (scale("amount") <= 2 AND scale("principal_component") <= 2 AND scale("interest_component") <= 2 AND scale("fee_component") <= 2 AND scale("penalty_component") <= 2),
  CONSTRAINT "payment_allocation_correction_entries_conservation_check" CHECK ("amount" = "principal_component" + "interest_component" + "fee_component" + "penalty_component"),
  CONSTRAINT "payment_allocation_correction_entries_sign_check" CHECK (("entry_type" = 'reversal' AND "amount" < 0 AND "principal_component" <= 0 AND "interest_component" <= 0 AND "fee_component" <= 0 AND "penalty_component" <= 0) OR ("entry_type" = 'replacement' AND "amount" > 0 AND "principal_component" >= 0 AND "interest_component" >= 0 AND "fee_component" >= 0 AND "penalty_component" >= 0)),
  CONSTRAINT "payment_allocation_correction_entries_tenant_group_fk" FOREIGN KEY ("tenant_id","group_id") REFERENCES "payment_allocation_correction_groups"("tenant_id","id"),
  CONSTRAINT "payment_allocation_correction_entries_tenant_source_tx_fk" FOREIGN KEY ("tenant_id","source_transaction_id") REFERENCES "transactions"("tenant_id","id"),
  CONSTRAINT "payment_allocation_correction_entries_tenant_tx_fk" FOREIGN KEY ("tenant_id","transaction_id") REFERENCES "transactions"("tenant_id","id"),
  CONSTRAINT "payment_allocation_correction_entries_tenant_loan_fk" FOREIGN KEY ("tenant_id","loan_id") REFERENCES "loans"("tenant_id","id"),
  CONSTRAINT "payment_allocation_correction_entries_tenant_schedule_fk" FOREIGN KEY ("tenant_id","schedule_id") REFERENCES "loan_schedules"("tenant_id","id"),
  CONSTRAINT "payment_allocation_correction_entries_tenant_audit_fk" FOREIGN KEY ("tenant_id","audit_public_id") REFERENCES "audit_logs"("tenant_id","public_id"),
  CONSTRAINT "payment_allocation_correction_entries_tenant_created_by_fk" FOREIGN KEY ("tenant_id","created_by_user_id") REFERENCES "users"("tenant_id","id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "payment_allocation_correction_entries_tenant_id_id_unique" ON "payment_allocation_correction_entries"("tenant_id","id");
CREATE INDEX IF NOT EXISTS "payment_allocation_correction_entries_tenant_group_idx" ON "payment_allocation_correction_entries"("tenant_id","group_id","id");

CREATE OR REPLACE FUNCTION reject_immutable_payment_allocation_correction_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payment allocation correction records are immutable; DELETE is not allowed';
  END IF;
  IF TG_TABLE_NAME IN ('payment_allocation_correction_groups','payment_allocation_correction_entries')
     OR (TG_TABLE_NAME = 'payment_allocation_correction_previews' AND OLD.status IN ('blocked','executed','expired')) THEN
    RAISE EXCEPTION 'payment allocation correction records are immutable; % is not allowed', TG_OP;
  END IF;
  IF TG_TABLE_NAME = 'payment_allocation_correction_previews' THEN
    IF OLD.status = 'ready' AND NEW.status = 'ready' THEN
      IF (to_jsonb(NEW) - ARRAY['status', 'executed_by_user_id', 'executed_at']) IS DISTINCT FROM
         (to_jsonb(OLD) - ARRAY['status', 'executed_by_user_id', 'executed_at']) THEN
        RAISE EXCEPTION 'ready payment allocation correction preview content is immutable';
      END IF;
      IF NEW.executed_by_user_id IS DISTINCT FROM OLD.executed_by_user_id OR NEW.executed_at IS DISTINCT FROM OLD.executed_at THEN
        RAISE EXCEPTION 'ready payment allocation correction preview lifecycle metadata is immutable';
      END IF;
    ELSIF OLD.status = 'ready' AND NEW.status = 'executed' THEN
      IF (to_jsonb(NEW) - ARRAY['status', 'executed_by_user_id', 'executed_at']) IS DISTINCT FROM
         (to_jsonb(OLD) - ARRAY['status', 'executed_by_user_id', 'executed_at'])
         OR NEW.executed_by_user_id IS NULL OR NEW.executed_at IS NULL THEN
        RAISE EXCEPTION 'ready payment allocation correction preview may only transition with executed metadata';
      END IF;
    ELSIF OLD.status = 'ready' AND NEW.status = 'expired' THEN
      IF (to_jsonb(NEW) - ARRAY['status']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status'])
         OR NEW.executed_by_user_id IS NOT NULL OR NEW.executed_at IS NOT NULL THEN
        RAISE EXCEPTION 'ready payment allocation correction preview may only transition to expired';
      END IF;
    ELSE
      RAISE EXCEPTION 'invalid payment allocation correction preview transition';
    END IF;
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER payment_allocation_correction_previews_immutable BEFORE UPDATE OR DELETE ON "payment_allocation_correction_previews" FOR EACH ROW EXECUTE FUNCTION reject_immutable_payment_allocation_correction_mutation();
CREATE TRIGGER payment_allocation_correction_groups_immutable BEFORE UPDATE OR DELETE ON "payment_allocation_correction_groups" FOR EACH ROW EXECUTE FUNCTION reject_immutable_payment_allocation_correction_mutation();
CREATE TRIGGER payment_allocation_correction_entries_immutable BEFORE UPDATE OR DELETE ON "payment_allocation_correction_entries" FOR EACH ROW EXECUTE FUNCTION reject_immutable_payment_allocation_correction_mutation();
