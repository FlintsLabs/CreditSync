DROP INDEX IF EXISTS "payment_intakes_tenant_repost_of_unique";

CREATE UNIQUE INDEX "payment_intakes_tenant_repost_of_unique"
  ON "payment_intakes" ("tenant_id", "repost_of_intake_id")
  WHERE "repost_of_intake_id" IS NOT NULL AND "status" <> 'cancelled';
