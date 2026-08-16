ALTER TABLE "bank_loans" ADD COLUMN IF NOT EXISTS "idempotency_key" text;
ALTER TABLE "bank_loans" ADD COLUMN IF NOT EXISTS "request_id" text;
ALTER TABLE "bank_loans" ADD COLUMN IF NOT EXISTS "correlation_id" text;
ALTER TABLE "bank_loans" ADD COLUMN IF NOT EXISTS "created_by_user_id" integer;
ALTER TABLE "bank_loans" ADD COLUMN IF NOT EXISTS "updated_by_user_id" integer;
ALTER TABLE "bank_loans" ADD COLUMN IF NOT EXISTS "request_hash" text;
ALTER TABLE "bank_loans" ADD COLUMN IF NOT EXISTS "activation_idempotency_key" text;
ALTER TABLE "bank_loans" ADD COLUMN IF NOT EXISTS "activation_request_hash" text;
ALTER TABLE "bank_loans" ADD COLUMN IF NOT EXISTS "activation_result" jsonb;
ALTER TABLE "bank_loans" ALTER COLUMN "status" SET DEFAULT 'draft';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bank_loans_status_check') THEN
    ALTER TABLE "bank_loans" ADD CONSTRAINT "bank_loans_status_check" CHECK ("status" IN ('draft', 'active', 'closed'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bank_loans_created_by_user_id_users_id_fk') THEN
    ALTER TABLE "bank_loans" ADD CONSTRAINT "bank_loans_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bank_loans_updated_by_user_id_users_id_fk') THEN
    ALTER TABLE "bank_loans" ADD CONSTRAINT "bank_loans_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "users"("id");
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "bank_loans_tenant_idempotency_unique" ON "bank_loans" ("tenant_id", "idempotency_key") WHERE "idempotency_key" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "bank_loans_tenant_activation_idempotency_unique" ON "bank_loans" ("tenant_id", "activation_idempotency_key") WHERE "activation_idempotency_key" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "bank_loans_tenant_profile_status_idx" ON "bank_loans" ("tenant_id", "bank_profile_id", "status");
