ALTER TABLE "loan_replacements"
  ADD COLUMN IF NOT EXISTS "execute_request_hash" text,
  ADD COLUMN IF NOT EXISTS "reversal_request_hash" text,
  ADD COLUMN IF NOT EXISTS "created_actor_source" text NOT NULL DEFAULT 'system',
  ADD COLUMN IF NOT EXISTS "execute_actor_source" text,
  ADD COLUMN IF NOT EXISTS "reversal_actor_source" text,
  ADD COLUMN IF NOT EXISTS "request_id" text,
  ADD COLUMN IF NOT EXISTS "correlation_id" text,
  ADD COLUMN IF NOT EXISTS "executed_audit_public_id" uuid,
  ADD COLUMN IF NOT EXISTS "reversed_audit_public_id" uuid,
  ADD COLUMN IF NOT EXISTS "executed_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "reversed_at" timestamptz;--> statement-breakpoint
ALTER TABLE "loan_replacement_corrections" ADD COLUMN IF NOT EXISTS "reversed_correction_id" integer;--> statement-breakpoint
ALTER TABLE "loan_replacements" DROP CONSTRAINT IF EXISTS "loan_replacements_actor_source_check";--> statement-breakpoint
ALTER TABLE "loan_replacements" ADD CONSTRAINT "loan_replacements_actor_source_check" CHECK (
  "created_actor_source" IN ('web','mcp','system') AND
  ("execute_actor_source" IS NULL OR "execute_actor_source" IN ('web','mcp','system')) AND
  ("reversal_actor_source" IS NULL OR "reversal_actor_source" IN ('web','mcp','system'))
);--> statement-breakpoint
ALTER TABLE "loan_replacements" DROP CONSTRAINT IF EXISTS "loan_replacements_request_key_hash_check";--> statement-breakpoint
ALTER TABLE "loan_replacements" ADD CONSTRAINT "loan_replacements_request_key_hash_check" CHECK (
  ("execute_idempotency_key" IS NULL) = ("execute_request_hash" IS NULL) AND
  ("reversal_idempotency_key" IS NULL) = ("reversal_request_hash" IS NULL)
);--> statement-breakpoint
ALTER TABLE "loan_replacements" DROP CONSTRAINT IF EXISTS "loan_replacements_lifecycle_check";--> statement-breakpoint
ALTER TABLE "loan_replacements" ADD CONSTRAINT "loan_replacements_lifecycle_check" CHECK (
  ("status" IN ('preview','expired') AND "execute_idempotency_key" IS NULL AND "execute_request_hash" IS NULL AND "reversal_idempotency_key" IS NULL AND "reversal_request_hash" IS NULL)
  OR ("status" = 'executed' AND "execute_idempotency_key" IS NOT NULL AND "execute_request_hash" IS NOT NULL AND "executed_audit_public_id" IS NOT NULL AND "executed_at" IS NOT NULL AND "execute_actor_source" IS NOT NULL AND "pre_execution_snapshot" IS NOT NULL AND "reversal_idempotency_key" IS NULL AND "reversal_request_hash" IS NULL)
  OR ("status" = 'reversed' AND "execute_idempotency_key" IS NOT NULL AND "execute_request_hash" IS NOT NULL AND "executed_audit_public_id" IS NOT NULL AND "executed_at" IS NOT NULL AND "reversal_idempotency_key" IS NOT NULL AND "reversal_request_hash" IS NOT NULL AND "reversed_audit_public_id" IS NOT NULL AND "reversed_at" IS NOT NULL AND "reversal_actor_source" IS NOT NULL AND "pre_execution_snapshot" IS NOT NULL)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "loan_replacement_corrections_tenant_reversed_unique" ON "loan_replacement_corrections" ("tenant_id", "reversed_correction_id") WHERE "reversed_correction_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "loan_replacement_corrections" DROP CONSTRAINT IF EXISTS "loan_replacement_corrections_tenant_reversed_correction_fk";--> statement-breakpoint
ALTER TABLE "loan_replacement_corrections" ADD CONSTRAINT "loan_replacement_corrections_tenant_reversed_correction_fk" FOREIGN KEY ("tenant_id", "reversed_correction_id") REFERENCES "loan_replacement_corrections"("tenant_id", "id");--> statement-breakpoint
CREATE OR REPLACE FUNCTION reject_immutable_loan_replacement_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'executed' AND TG_OP = 'UPDATE' AND NEW.status = 'reversed'
    AND (to_jsonb(NEW) - ARRAY['status','reversal_idempotency_key','reversal_request_hash','reversal_actor_source','reversed_audit_public_id','reversed_by_user_id','reversed_at','updated_at'])
      = (to_jsonb(OLD) - ARRAY['status','reversal_idempotency_key','reversal_request_hash','reversal_actor_source','reversed_audit_public_id','reversed_by_user_id','reversed_at','updated_at']) THEN RETURN NEW; END IF;
  IF OLD.status IN ('executed','reversed') THEN RAISE EXCEPTION 'executed and reversed loan replacements are immutable; % is not allowed', TG_OP; END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END; $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS loan_replacements_immutable ON "loan_replacements";--> statement-breakpoint
CREATE TRIGGER loan_replacements_immutable BEFORE UPDATE OR DELETE ON "loan_replacements" FOR EACH ROW EXECUTE FUNCTION reject_immutable_loan_replacement_mutation();--> statement-breakpoint
CREATE OR REPLACE FUNCTION reject_immutable_loan_replacement_correction() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'loan replacement corrections are immutable; % is not allowed', TG_OP; END; $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS loan_replacement_corrections_immutable ON "loan_replacement_corrections";--> statement-breakpoint
CREATE TRIGGER loan_replacement_corrections_immutable BEFORE UPDATE OR DELETE ON "loan_replacement_corrections" FOR EACH ROW EXECUTE FUNCTION reject_immutable_loan_replacement_correction();
