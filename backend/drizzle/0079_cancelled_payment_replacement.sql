ALTER TABLE "payment_intakes" ADD COLUMN "replacement_of_intake_id" integer;
CREATE UNIQUE INDEX "payment_intakes_tenant_replacement_of_unique" ON "payment_intakes" ("tenant_id", "replacement_of_intake_id") WHERE "replacement_of_intake_id" IS NOT NULL;
ALTER TABLE "payment_intakes" ADD CONSTRAINT "payment_intakes_tenant_replacement_of_fk" FOREIGN KEY ("tenant_id", "replacement_of_intake_id") REFERENCES "payment_intakes"("tenant_id", "id");
CREATE UNIQUE INDEX "payment_evidence_tenant_id_id_unique" ON "payment_evidence" ("tenant_id", "id");

CREATE TABLE "payment_replacement_lineages" (
  "id" serial PRIMARY KEY NOT NULL,
  "public_id" uuid DEFAULT uuidv7() NOT NULL UNIQUE,
  "tenant_id" text NOT NULL,
  "source_payment_intake_id" integer NOT NULL,
  "replacement_payment_intake_id" integer NOT NULL,
  "reason" text NOT NULL,
  "request_hash" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "request_id" text NOT NULL,
  "correlation_id" text NOT NULL,
  "audit_public_id" uuid NOT NULL,
  "bank_reference_hash" text,
  "qr_payload_hash" text,
  "created_by_user_id" integer,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "payment_replacement_lineages_source_fk" FOREIGN KEY ("tenant_id", "source_payment_intake_id") REFERENCES "payment_intakes"("tenant_id", "id") DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "payment_replacement_lineages_child_fk" FOREIGN KEY ("tenant_id", "replacement_payment_intake_id") REFERENCES "payment_intakes"("tenant_id", "id") DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "payment_replacement_lineages_audit_fk" FOREIGN KEY ("tenant_id", "audit_public_id") REFERENCES "audit_logs"("tenant_id", "public_id"),
  CONSTRAINT "payment_replacement_lineages_actor_fk" FOREIGN KEY ("tenant_id", "created_by_user_id") REFERENCES "users"("tenant_id", "id"),
  CONSTRAINT "payment_replacement_lineages_reason_check" CHECK (length(trim("reason")) BETWEEN 1 AND 2000)
);
CREATE UNIQUE INDEX "payment_replacement_lineages_tenant_id_id_unique" ON "payment_replacement_lineages" ("tenant_id", "id");
CREATE UNIQUE INDEX "payment_replacement_lineages_tenant_source_unique" ON "payment_replacement_lineages" ("tenant_id", "source_payment_intake_id");
CREATE UNIQUE INDEX "payment_replacement_lineages_tenant_child_unique" ON "payment_replacement_lineages" ("tenant_id", "replacement_payment_intake_id");
CREATE UNIQUE INDEX "payment_replacement_lineages_tenant_idempotency_unique" ON "payment_replacement_lineages" ("tenant_id", "idempotency_key");

CREATE TABLE "payment_replacement_evidence_references" (
  "id" serial PRIMARY KEY NOT NULL,
  "public_id" uuid DEFAULT uuidv7() NOT NULL UNIQUE,
  "tenant_id" text NOT NULL,
  "lineage_id" integer NOT NULL,
  "replacement_payment_intake_id" integer NOT NULL,
  "source_payment_intake_id" integer NOT NULL,
  "source_evidence_id" integer,
  "source_supplement_id" integer,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "payment_replacement_evidence_refs_lineage_fk" FOREIGN KEY ("tenant_id", "lineage_id") REFERENCES "payment_replacement_lineages"("tenant_id", "id"),
  CONSTRAINT "payment_replacement_evidence_refs_child_fk" FOREIGN KEY ("tenant_id", "replacement_payment_intake_id") REFERENCES "payment_intakes"("tenant_id", "id"),
  CONSTRAINT "payment_replacement_evidence_refs_source_fk" FOREIGN KEY ("tenant_id", "source_payment_intake_id") REFERENCES "payment_intakes"("tenant_id", "id"),
  CONSTRAINT "payment_replacement_evidence_refs_evidence_fk" FOREIGN KEY ("tenant_id", "source_evidence_id") REFERENCES "payment_evidence"("tenant_id", "id"),
  CONSTRAINT "payment_replacement_evidence_refs_supplement_fk" FOREIGN KEY ("tenant_id", "source_supplement_id") REFERENCES "payment_evidence_supplements"("tenant_id", "id"),
  CONSTRAINT "payment_replacement_evidence_refs_exact_source_check" CHECK (("source_evidence_id" IS NOT NULL AND "source_supplement_id" IS NULL) OR ("source_evidence_id" IS NULL AND "source_supplement_id" IS NOT NULL))
);
CREATE UNIQUE INDEX "payment_replacement_evidence_refs_tenant_id_id_unique" ON "payment_replacement_evidence_references" ("tenant_id", "id");
CREATE UNIQUE INDEX "payment_replacement_evidence_refs_tenant_child_evidence_unique" ON "payment_replacement_evidence_references" ("tenant_id", "replacement_payment_intake_id", "source_evidence_id") WHERE "source_evidence_id" IS NOT NULL;
CREATE UNIQUE INDEX "payment_replacement_evidence_refs_tenant_child_supplement_unique" ON "payment_replacement_evidence_references" ("tenant_id", "replacement_payment_intake_id", "source_supplement_id") WHERE "source_supplement_id" IS NOT NULL;

CREATE OR REPLACE FUNCTION reject_payment_replacement_lineage_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'payment replacement lineage is immutable'; END; $$;
CREATE TRIGGER "payment_replacement_lineages_immutable" BEFORE UPDATE OR DELETE ON "payment_replacement_lineages" FOR EACH ROW EXECUTE FUNCTION reject_payment_replacement_lineage_mutation();
CREATE TRIGGER "payment_replacement_evidence_references_immutable" BEFORE UPDATE OR DELETE ON "payment_replacement_evidence_references" FOR EACH ROW EXECUTE FUNCTION reject_payment_replacement_lineage_mutation();

CREATE OR REPLACE FUNCTION validate_payment_replacement_lineage_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_row payment_intakes%ROWTYPE; child_row payment_intakes%ROWTYPE;
BEGIN
  SELECT * INTO source_row FROM payment_intakes WHERE tenant_id = NEW.tenant_id AND id = NEW.source_payment_intake_id;
  SELECT * INTO child_row FROM payment_intakes WHERE tenant_id = NEW.tenant_id AND id = NEW.replacement_payment_intake_id;
  IF NEW.source_payment_intake_id = NEW.replacement_payment_intake_id OR source_row.id IS NULL OR child_row.id IS NULL THEN RAISE EXCEPTION 'invalid replacement lineage endpoints'; END IF;
  IF source_row.status <> 'cancelled' OR source_row.posted_at IS NOT NULL OR child_row.status <> 'draft' OR child_row.replacement_of_intake_id IS DISTINCT FROM source_row.id
    OR EXISTS (SELECT 1 FROM transactions t WHERE t.tenant_id = NEW.tenant_id AND t.payment_intake_id = source_row.id)
    OR EXISTS (SELECT 1 FROM payment_reconciliation_proposals p WHERE p.tenant_id = NEW.tenant_id AND p.payment_intake_id = source_row.id)
    OR EXISTS (SELECT 1 FROM payment_reconciliation_groups g WHERE g.tenant_id = NEW.tenant_id AND (g.payment_intake_id = source_row.id OR g.posted_intake_id = source_row.id))
    OR EXISTS (SELECT 1 FROM payment_allocation_correction_groups g WHERE g.tenant_id = NEW.tenant_id AND g.payment_intake_id = source_row.id)
    OR EXISTS (SELECT 1 FROM payment_batch_items bi JOIN payment_batches b ON b.tenant_id = bi.tenant_id AND b.id = bi.batch_id WHERE bi.tenant_id = NEW.tenant_id AND bi.payment_intake_id = source_row.id AND b.status <> 'cancelled') THEN RAISE EXCEPTION 'replacement lineage lifecycle is invalid'; END IF;
  IF child_row.owner_user_id IS DISTINCT FROM source_row.owner_user_id OR child_row.amount IS DISTINCT FROM source_row.amount OR child_row.received_at IS DISTINCT FROM source_row.received_at OR child_row.payer_name IS DISTINCT FROM source_row.payer_name OR (child_row.bank_reference_hash IS NOT NULL AND child_row.bank_reference_hash IS DISTINCT FROM source_row.bank_reference_hash) OR (child_row.qr_payload_hash IS NOT NULL AND child_row.qr_payload_hash IS DISTINCT FROM source_row.qr_payload_hash) THEN RAISE EXCEPTION 'replacement lineage payment identity is immutable'; END IF;
  RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER "payment_replacement_lineages_validate_insert" AFTER INSERT ON "payment_replacement_lineages" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_payment_replacement_lineage_insert();

CREATE OR REPLACE FUNCTION validate_payment_replacement_reference_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE lineage_row payment_replacement_lineages%ROWTYPE; source_row payment_intakes%ROWTYPE; child_row payment_intakes%ROWTYPE; evidence_ok boolean := false;
BEGIN
  SELECT * INTO lineage_row FROM payment_replacement_lineages WHERE tenant_id = NEW.tenant_id AND id = NEW.lineage_id;
  SELECT * INTO source_row FROM payment_intakes WHERE tenant_id = NEW.tenant_id AND id = NEW.source_payment_intake_id;
  SELECT * INTO child_row FROM payment_intakes WHERE tenant_id = NEW.tenant_id AND id = NEW.replacement_payment_intake_id;
  IF lineage_row.id IS NULL OR child_row.id IS NULL OR source_row.id IS NULL OR lineage_row.replacement_payment_intake_id <> NEW.replacement_payment_intake_id OR NOT EXISTS (
    WITH RECURSIVE
      edges(a, b) AS (
        SELECT l.source_payment_intake_id, l.replacement_payment_intake_id
        FROM payment_replacement_lineages l
        WHERE l.tenant_id = NEW.tenant_id
      ),
      chain(id) AS (
        SELECT lineage_row.source_payment_intake_id
        UNION
        SELECT CASE WHEN e.a = c.id THEN e.b ELSE e.a END
        FROM chain c
        JOIN edges e ON e.a = c.id OR e.b = c.id
      )
    SELECT 1 FROM chain WHERE id = NEW.source_payment_intake_id
  ) THEN RAISE EXCEPTION 'replacement evidence reference endpoints are invalid'; END IF;
  IF NEW.source_evidence_id IS NOT NULL THEN
    SELECT EXISTS (SELECT 1 FROM payment_evidence e JOIN files f ON f.tenant_id = e.tenant_id AND f.id = e.file_id WHERE e.tenant_id = NEW.tenant_id AND e.id = NEW.source_evidence_id AND e.payment_intake_id = NEW.source_payment_intake_id AND e.status = 'ready' AND e.finalized_at IS NOT NULL) INTO evidence_ok;
  ELSE
    SELECT EXISTS (SELECT 1 FROM payment_evidence_supplements e JOIN files f ON f.tenant_id = e.tenant_id AND f.id = e.file_id WHERE e.tenant_id = NEW.tenant_id AND e.id = NEW.source_supplement_id AND e.payment_intake_id = NEW.source_payment_intake_id AND e.status = 'recorded' AND e.recorded_at IS NOT NULL) INTO evidence_ok;
  END IF;
  IF NOT evidence_ok THEN RAISE EXCEPTION 'replacement evidence must reference ready immutable evidence with a file'; END IF;
  RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER "payment_replacement_evidence_refs_validate_insert" AFTER INSERT ON "payment_replacement_evidence_references" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_payment_replacement_reference_insert();

CREATE OR REPLACE FUNCTION reject_payment_replacement_parent_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP = 'UPDATE' AND NEW.replacement_of_intake_id IS DISTINCT FROM OLD.replacement_of_intake_id THEN RAISE EXCEPTION 'replacement parent is immutable'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER "payment_intakes_replacement_parent_immutable" BEFORE UPDATE ON "payment_intakes" FOR EACH ROW EXECUTE FUNCTION reject_payment_replacement_parent_mutation();
CREATE OR REPLACE FUNCTION validate_payment_replacement_parent() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NEW.replacement_of_intake_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM payment_replacement_lineages l WHERE l.tenant_id = NEW.tenant_id AND l.replacement_payment_intake_id = NEW.id AND l.source_payment_intake_id = NEW.replacement_of_intake_id) THEN RAISE EXCEPTION 'replacement child has no matching lineage'; END IF;
  RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER "payment_intakes_replacement_parent_validate" AFTER INSERT ON "payment_intakes" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_payment_replacement_parent();
