ALTER TABLE "payment_intakes"
  ADD COLUMN IF NOT EXISTS "repost_of_intake_id" integer;

CREATE UNIQUE INDEX IF NOT EXISTS "payment_intakes_tenant_repost_of_unique"
  ON "payment_intakes" ("tenant_id", "repost_of_intake_id")
  WHERE "repost_of_intake_id" IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'payment_intakes_tenant_repost_of_fk'
  ) THEN
    ALTER TABLE "payment_intakes"
      ADD CONSTRAINT "payment_intakes_tenant_repost_of_fk"
      FOREIGN KEY ("tenant_id", "repost_of_intake_id")
      REFERENCES "payment_intakes"("tenant_id", "id");
  END IF;
END $$;

ALTER TABLE "payment_reconciliation_groups"
  ADD COLUMN IF NOT EXISTS "posted_intake_id" integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'payment_reconciliation_groups_tenant_posted_intake_fk'
  ) THEN
    ALTER TABLE "payment_reconciliation_groups"
      ADD CONSTRAINT "payment_reconciliation_groups_tenant_posted_intake_fk"
      FOREIGN KEY ("tenant_id", "posted_intake_id")
      REFERENCES "payment_intakes"("tenant_id", "id");
  END IF;
END $$;
