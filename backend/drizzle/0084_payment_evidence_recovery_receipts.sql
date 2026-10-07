CREATE TABLE IF NOT EXISTS "payment_evidence_recovery_previews" (
  "id" serial PRIMARY KEY, "public_id" uuid NOT NULL DEFAULT uuidv7() UNIQUE, "tenant_id" text NOT NULL,
  "source_payment_intake_id" integer NOT NULL, "reason" text NOT NULL, "expected_count" integer NOT NULL, "requirement_floor" integer NOT NULL,
  "source_state_hash" text NOT NULL, "reusable_evidence_ids" jsonb NOT NULL, "reuse_evidence" boolean NOT NULL,
  "preview_hash" text NOT NULL, "request_hash" text NOT NULL, "audit_public_id" uuid NOT NULL, "expires_at" timestamptz NOT NULL,
  "request_id" text NOT NULL, "correlation_id" text NOT NULL, "idempotency_key" text NOT NULL, "created_by_user_id" integer NOT NULL, "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "payment_evidence_recovery_previews_count_check" CHECK ("expected_count" BETWEEN 1 AND 20 AND "requirement_floor" BETWEEN 0 AND 20),
  CONSTRAINT "payment_evidence_recovery_previews_tenant_source_fk" FOREIGN KEY ("tenant_id", "source_payment_intake_id") REFERENCES "payment_intakes" ("tenant_id", "id"),
  CONSTRAINT "payment_evidence_recovery_previews_tenant_actor_fk" FOREIGN KEY ("tenant_id", "created_by_user_id") REFERENCES "users" ("tenant_id", "id"),
  CONSTRAINT "payment_evidence_recovery_previews_tenant_audit_fk" FOREIGN KEY ("tenant_id", "audit_public_id") REFERENCES "audit_logs" ("tenant_id", "public_id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "payment_evidence_recovery_previews_tenant_id_id_unique" ON "payment_evidence_recovery_previews" ("tenant_id", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "payment_evidence_recovery_previews_tenant_idempotency_unique" ON "payment_evidence_recovery_previews" ("tenant_id", "idempotency_key");
CREATE TABLE IF NOT EXISTS "payment_evidence_recovery_executions" (
  "id" serial PRIMARY KEY, "public_id" uuid NOT NULL DEFAULT uuidv7() UNIQUE, "tenant_id" text NOT NULL, "preview_id" integer NOT NULL,
  "source_payment_intake_id" integer NOT NULL, "lineage_id" integer NOT NULL, "request_hash" text NOT NULL, "idempotency_key" text NOT NULL,
  "audit_public_id" uuid NOT NULL, "correlation_id" text NOT NULL, "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "payment_evidence_recovery_executions_tenant_preview_fk" FOREIGN KEY ("tenant_id", "preview_id") REFERENCES "payment_evidence_recovery_previews" ("tenant_id", "id"),
  CONSTRAINT "payment_evidence_recovery_executions_tenant_source_fk" FOREIGN KEY ("tenant_id", "source_payment_intake_id") REFERENCES "payment_intakes" ("tenant_id", "id"),
  CONSTRAINT "payment_evidence_recovery_executions_tenant_lineage_fk" FOREIGN KEY ("tenant_id", "lineage_id") REFERENCES "payment_replacement_lineages" ("tenant_id", "id"),
  CONSTRAINT "payment_evidence_recovery_executions_tenant_audit_fk" FOREIGN KEY ("tenant_id", "audit_public_id") REFERENCES "audit_logs" ("tenant_id", "public_id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "payment_evidence_recovery_executions_tenant_id_id_unique" ON "payment_evidence_recovery_executions" ("tenant_id", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "payment_evidence_recovery_executions_tenant_idempotency_unique" ON "payment_evidence_recovery_executions" ("tenant_id", "idempotency_key");
CREATE UNIQUE INDEX IF NOT EXISTS "payment_evidence_recovery_executions_tenant_preview_unique" ON "payment_evidence_recovery_executions" ("tenant_id", "preview_id");
