ALTER TABLE "payment_identity_decisions"
  ADD COLUMN IF NOT EXISTS "request_hash" text NOT NULL DEFAULT '';
ALTER TABLE "payment_identity_decision_previews"
  ADD COLUMN IF NOT EXISTS "request_hash" text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "audit_public_id" uuid;
DO $$
DECLARE r record;
DECLARE audit_id uuid;
BEGIN
  FOR r IN SELECT p."tenant_id", p."id" FROM "payment_identity_decision_previews" p WHERE p."audit_public_id" IS NULL LOOP
    INSERT INTO "audit_logs" ("tenant_id", "actor_source", "entity_type", "entity_id", "action", "payload")
    VALUES (r."tenant_id", 'system', 'payment_identity_decision_preview', r."id"::text, 'legacy_receipt', jsonb_build_object('legacy', true))
    RETURNING "public_id" INTO audit_id;
    UPDATE "payment_identity_decision_previews" SET "audit_public_id" = audit_id WHERE "tenant_id" = r."tenant_id" AND "id" = r."id";
  END LOOP;
END $$;
ALTER TABLE "payment_identity_decision_previews" ALTER COLUMN "audit_public_id" SET NOT NULL;
ALTER TABLE "payment_identity_decision_previews"
  ADD CONSTRAINT "payment_identity_decision_previews_tenant_audit_fk"
  FOREIGN KEY ("tenant_id", "audit_public_id") REFERENCES "audit_logs" ("tenant_id", "public_id");
