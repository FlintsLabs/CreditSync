CREATE TABLE "payment_duplicate_reviews" (
  "id" serial PRIMARY KEY NOT NULL, "public_id" uuid DEFAULT uuidv7() NOT NULL UNIQUE, "tenant_id" text NOT NULL,
  "canonical_payment_intake_id" integer NOT NULL, "reason" text NOT NULL, "request_id" text NOT NULL, "correlation_id" text NOT NULL,
  "idempotency_key" text NOT NULL, "request_hash" text NOT NULL, "preview_hash" text NOT NULL, "canonical_state_hash" text NOT NULL,
  "evidence_hash" text NOT NULL, "dependency_hash" text NOT NULL, "expires_at" timestamptz NOT NULL, "audit_public_id" uuid NOT NULL,
  "created_by_user_id" integer NOT NULL, "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "payment_duplicate_reviews_tenant_canonical_fk" FOREIGN KEY ("tenant_id", "canonical_payment_intake_id") REFERENCES "payment_intakes"("tenant_id", "id"),
  CONSTRAINT "payment_duplicate_reviews_tenant_audit_fk" FOREIGN KEY ("tenant_id", "audit_public_id") REFERENCES "audit_logs"("tenant_id", "public_id"),
  CONSTRAINT "payment_duplicate_reviews_tenant_actor_fk" FOREIGN KEY ("tenant_id", "created_by_user_id") REFERENCES "users"("tenant_id", "id"),
  CONSTRAINT "payment_duplicate_reviews_reason_check" CHECK (length(trim("reason")) BETWEEN 1 AND 2000)
);
CREATE UNIQUE INDEX "payment_duplicate_reviews_tenant_id_id_unique" ON "payment_duplicate_reviews" ("tenant_id", "id");
CREATE UNIQUE INDEX "payment_duplicate_reviews_tenant_idempotency_unique" ON "payment_duplicate_reviews" ("tenant_id", "idempotency_key");

CREATE TABLE "payment_duplicate_review_candidates" (
  "id" serial PRIMARY KEY NOT NULL, "public_id" uuid DEFAULT uuidv7() NOT NULL UNIQUE, "tenant_id" text NOT NULL,
  "review_id" integer NOT NULL, "candidate_payment_intake_id" integer NOT NULL, "candidate_state_hash" text NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "payment_duplicate_review_candidates_tenant_review_fk" FOREIGN KEY ("tenant_id", "review_id") REFERENCES "payment_duplicate_reviews"("tenant_id", "id"),
  CONSTRAINT "payment_duplicate_review_candidates_tenant_candidate_fk" FOREIGN KEY ("tenant_id", "candidate_payment_intake_id") REFERENCES "payment_intakes"("tenant_id", "id")
);
CREATE UNIQUE INDEX "payment_duplicate_review_candidates_tenant_id_id_unique" ON "payment_duplicate_review_candidates" ("tenant_id", "id");
CREATE UNIQUE INDEX "payment_duplicate_review_candidates_tenant_review_candidate_unique" ON "payment_duplicate_review_candidates" ("tenant_id", "review_id", "candidate_payment_intake_id");

CREATE TABLE "payment_duplicate_review_executions" (
  "id" serial PRIMARY KEY NOT NULL, "public_id" uuid DEFAULT uuidv7() NOT NULL UNIQUE, "tenant_id" text NOT NULL,
  "review_id" integer NOT NULL, "idempotency_key" text NOT NULL, "request_hash" text NOT NULL, "audit_public_id" uuid NOT NULL,
  "request_id" text NOT NULL, "correlation_id" text NOT NULL, "confirmed_at" timestamptz DEFAULT now() NOT NULL,
  "created_by_user_id" integer NOT NULL, "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "payment_duplicate_review_executions_tenant_review_fk" FOREIGN KEY ("tenant_id", "review_id") REFERENCES "payment_duplicate_reviews"("tenant_id", "id"),
  CONSTRAINT "payment_duplicate_review_executions_tenant_audit_fk" FOREIGN KEY ("tenant_id", "audit_public_id") REFERENCES "audit_logs"("tenant_id", "public_id"),
  CONSTRAINT "payment_duplicate_review_executions_tenant_actor_fk" FOREIGN KEY ("tenant_id", "created_by_user_id") REFERENCES "users"("tenant_id", "id")
);
CREATE UNIQUE INDEX "payment_duplicate_review_executions_tenant_id_id_unique" ON "payment_duplicate_review_executions" ("tenant_id", "id");
CREATE UNIQUE INDEX "payment_duplicate_review_executions_tenant_review_unique" ON "payment_duplicate_review_executions" ("tenant_id", "review_id");
CREATE UNIQUE INDEX "payment_duplicate_review_executions_tenant_idempotency_unique" ON "payment_duplicate_review_executions" ("tenant_id", "idempotency_key");

CREATE OR REPLACE FUNCTION reject_payment_duplicate_review_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'payment duplicate review ledger is immutable'; END; $$;
CREATE TRIGGER "payment_duplicate_reviews_immutable" BEFORE UPDATE OR DELETE ON "payment_duplicate_reviews" FOR EACH ROW EXECUTE FUNCTION reject_payment_duplicate_review_mutation();
CREATE TRIGGER "payment_duplicate_review_candidates_immutable" BEFORE UPDATE OR DELETE ON "payment_duplicate_review_candidates" FOR EACH ROW EXECUTE FUNCTION reject_payment_duplicate_review_mutation();
CREATE TRIGGER "payment_duplicate_review_executions_immutable" BEFORE UPDATE OR DELETE ON "payment_duplicate_review_executions" FOR EACH ROW EXECUTE FUNCTION reject_payment_duplicate_review_mutation();

CREATE OR REPLACE FUNCTION validate_payment_duplicate_review_candidate() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE review_row payment_duplicate_reviews%ROWTYPE; candidate_row payment_intakes%ROWTYPE;
BEGIN
  SELECT * INTO review_row FROM payment_duplicate_reviews WHERE tenant_id = NEW.tenant_id AND id = NEW.review_id;
  SELECT * INTO candidate_row FROM payment_intakes WHERE tenant_id = NEW.tenant_id AND id = NEW.candidate_payment_intake_id;
  IF review_row.id IS NULL OR candidate_row.id IS NULL OR candidate_row.id = review_row.canonical_payment_intake_id OR candidate_row.status <> 'cancelled' THEN RAISE EXCEPTION 'duplicate review candidate is invalid'; END IF;
  IF EXISTS (SELECT 1 FROM transactions WHERE tenant_id = NEW.tenant_id AND payment_intake_id = candidate_row.id)
     OR EXISTS (SELECT 1 FROM payment_reconciliation_proposals WHERE tenant_id = NEW.tenant_id AND payment_intake_id = candidate_row.id)
     OR EXISTS (SELECT 1 FROM payment_reconciliation_groups WHERE tenant_id = NEW.tenant_id AND (payment_intake_id = candidate_row.id OR posted_intake_id = candidate_row.id))
     OR EXISTS (SELECT 1 FROM payment_allocation_correction_groups WHERE tenant_id = NEW.tenant_id AND payment_intake_id = candidate_row.id)
     OR candidate_row.replacement_of_intake_id IS NOT NULL OR candidate_row.repost_of_intake_id IS NOT NULL THEN RAISE EXCEPTION 'duplicate review candidate has financial dependency'; END IF;
  RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER "payment_duplicate_review_candidates_validate" AFTER INSERT ON "payment_duplicate_review_candidates" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_payment_duplicate_review_candidate();

CREATE TABLE "payment_duplicate_review_memberships" (
  "id" serial PRIMARY KEY NOT NULL, "public_id" uuid DEFAULT uuidv7() NOT NULL UNIQUE, "tenant_id" text NOT NULL,
  "review_id" integer NOT NULL, "execution_id" integer NOT NULL, "canonical_payment_intake_id" integer NOT NULL,
  "candidate_payment_intake_id" integer NOT NULL, "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "payment_duplicate_review_memberships_tenant_review_fk" FOREIGN KEY ("tenant_id", "review_id") REFERENCES "payment_duplicate_reviews"("tenant_id", "id"),
  CONSTRAINT "payment_duplicate_review_memberships_tenant_execution_fk" FOREIGN KEY ("tenant_id", "execution_id") REFERENCES "payment_duplicate_review_executions"("tenant_id", "id"),
  CONSTRAINT "payment_duplicate_review_memberships_tenant_canonical_fk" FOREIGN KEY ("tenant_id", "canonical_payment_intake_id") REFERENCES "payment_intakes"("tenant_id", "id"),
  CONSTRAINT "payment_duplicate_review_memberships_tenant_candidate_fk" FOREIGN KEY ("tenant_id", "candidate_payment_intake_id") REFERENCES "payment_intakes"("tenant_id", "id"),
  CONSTRAINT "payment_duplicate_review_memberships_distinct_check" CHECK ("canonical_payment_intake_id" <> "candidate_payment_intake_id")
);
CREATE UNIQUE INDEX "payment_duplicate_review_memberships_tenant_id_id_unique" ON "payment_duplicate_review_memberships" ("tenant_id", "id");
CREATE INDEX "payment_duplicate_review_memberships_tenant_canonical_idx" ON "payment_duplicate_review_memberships" ("tenant_id", "canonical_payment_intake_id");
CREATE UNIQUE INDEX "payment_duplicate_review_memberships_tenant_candidate_unique" ON "payment_duplicate_review_memberships" ("tenant_id", "candidate_payment_intake_id");
CREATE UNIQUE INDEX "payment_duplicate_review_memberships_tenant_review_candidate_unique" ON "payment_duplicate_review_memberships" ("tenant_id", "review_id", "candidate_payment_intake_id");
CREATE OR REPLACE FUNCTION reject_payment_duplicate_review_membership_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'payment duplicate review membership is immutable'; END; $$;
CREATE TRIGGER "payment_duplicate_review_memberships_immutable" BEFORE UPDATE OR DELETE ON "payment_duplicate_review_memberships" FOR EACH ROW EXECUTE FUNCTION reject_payment_duplicate_review_membership_mutation();
CREATE OR REPLACE FUNCTION validate_payment_duplicate_review_membership() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE review_row payment_duplicate_reviews%ROWTYPE; execution_row payment_duplicate_review_executions%ROWTYPE; candidate_row payment_intakes%ROWTYPE;
BEGIN
  SELECT * INTO review_row FROM payment_duplicate_reviews WHERE tenant_id = NEW.tenant_id AND id = NEW.review_id;
  SELECT * INTO execution_row FROM payment_duplicate_review_executions WHERE tenant_id = NEW.tenant_id AND id = NEW.execution_id;
  SELECT * INTO candidate_row FROM payment_intakes WHERE tenant_id = NEW.tenant_id AND id = NEW.candidate_payment_intake_id;
  IF review_row.id IS NULL OR execution_row.id IS NULL OR execution_row.review_id <> review_row.id OR NEW.canonical_payment_intake_id <> review_row.canonical_payment_intake_id OR candidate_row.id IS NULL OR candidate_row.status <> 'cancelled' OR candidate_row.replacement_of_intake_id IS NOT NULL OR candidate_row.repost_of_intake_id IS NOT NULL THEN RAISE EXCEPTION 'duplicate review membership is invalid'; END IF;
  IF EXISTS (SELECT 1 FROM payment_duplicate_review_memberships m WHERE m.tenant_id = NEW.tenant_id AND m.id <> NEW.id AND (m.candidate_payment_intake_id = NEW.canonical_payment_intake_id OR m.canonical_payment_intake_id = NEW.candidate_payment_intake_id OR (m.canonical_payment_intake_id = NEW.canonical_payment_intake_id AND m.review_id <> NEW.review_id))) THEN RAISE EXCEPTION 'duplicate review membership role conflict'; END IF;
  RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER "payment_duplicate_review_memberships_validate" AFTER INSERT ON "payment_duplicate_review_memberships" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_payment_duplicate_review_membership();
