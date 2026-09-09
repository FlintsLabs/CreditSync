ALTER TABLE "loan_funding_allocations" ADD COLUMN IF NOT EXISTS "idempotency_key" text;
ALTER TABLE "loan_funding_allocations" ADD COLUMN IF NOT EXISTS "request_hash" text;
CREATE UNIQUE INDEX IF NOT EXISTS "loan_funding_allocations_tenant_idempotency_unique" ON "loan_funding_allocations" ("tenant_id", "idempotency_key") WHERE "idempotency_key" IS NOT NULL;
