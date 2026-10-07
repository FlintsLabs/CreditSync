CREATE TABLE IF NOT EXISTS "payment_identity_decisions" (
  "id" serial PRIMARY KEY,
  "public_id" uuid NOT NULL DEFAULT uuidv7() UNIQUE,
  "tenant_id" text NOT NULL,
  "decision" text NOT NULL,
  "reason" text NOT NULL,
  "participant_public_ids" jsonb NOT NULL,
  "participant_snapshot_hash" text NOT NULL,
  "supersedes_decision_id" integer,
  "request_id" text NOT NULL,
  "correlation_id" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "audit_public_id" uuid NOT NULL,
  "created_by_user_id" integer NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "payment_identity_decisions_kind_check" CHECK ("decision" IN ('same_payment', 'distinct_payment')),
  CONSTRAINT "payment_identity_decisions_reason_check" CHECK (length(trim("reason")) BETWEEN 1 AND 2000),
  CONSTRAINT "payment_identity_decisions_tenant_actor_fk" FOREIGN KEY ("tenant_id", "created_by_user_id") REFERENCES "users" ("tenant_id", "id"),
  CONSTRAINT "payment_identity_decisions_tenant_audit_fk" FOREIGN KEY ("tenant_id", "audit_public_id") REFERENCES "audit_logs" ("tenant_id", "public_id")
);
CREATE TABLE IF NOT EXISTS "payment_identity_decision_previews" (
  "id" serial PRIMARY KEY, "public_id" uuid NOT NULL DEFAULT uuidv7() UNIQUE, "tenant_id" text NOT NULL,
  "participant_public_ids" jsonb NOT NULL, "participant_snapshot_hash" text NOT NULL, "decision" text NOT NULL, "reason" text NOT NULL,
  "preview_hash" text NOT NULL, "expires_at" timestamptz NOT NULL, "request_id" text NOT NULL, "correlation_id" text NOT NULL, "idempotency_key" text NOT NULL,
  "created_by_user_id" integer NOT NULL, "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "payment_identity_decision_previews_kind_check" CHECK ("decision" IN ('same_payment', 'distinct_payment')),
  CONSTRAINT "payment_identity_decision_previews_tenant_actor_fk" FOREIGN KEY ("tenant_id", "created_by_user_id") REFERENCES "users" ("tenant_id", "id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "payment_identity_decision_previews_tenant_id_id_unique" ON "payment_identity_decision_previews" ("tenant_id", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "payment_identity_decision_previews_tenant_idempotency_unique" ON "payment_identity_decision_previews" ("tenant_id", "idempotency_key");
CREATE UNIQUE INDEX IF NOT EXISTS "payment_identity_decisions_tenant_id_id_unique" ON "payment_identity_decisions" ("tenant_id", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "payment_identity_decisions_tenant_idempotency_unique" ON "payment_identity_decisions" ("tenant_id", "idempotency_key");
CREATE INDEX IF NOT EXISTS "payment_identity_decisions_tenant_participant_idx" ON "payment_identity_decisions" USING gin ("participant_public_ids");
CREATE OR REPLACE FUNCTION reject_payment_identity_decision_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'payment identity decisions are append-only'; END; $$;
DROP TRIGGER IF EXISTS payment_identity_decisions_immutable ON "payment_identity_decisions";
CREATE TRIGGER payment_identity_decisions_immutable BEFORE UPDATE OR DELETE ON "payment_identity_decisions" FOR EACH ROW EXECUTE FUNCTION reject_payment_identity_decision_mutation();
