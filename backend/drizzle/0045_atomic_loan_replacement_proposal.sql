ALTER TABLE "loans" DROP CONSTRAINT IF EXISTS "loans_status_check";--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loans_status_check" CHECK ("status" IN ('draft', 'active', 'paid', 'completed', 'defaulted', 'closed', 'renewed', 'restructured', 'cancelled', 'canceled', 'settled', 'reversed', 'replaced'));--> statement-breakpoint
ALTER TABLE "loan_replacements"
  ADD COLUMN IF NOT EXISTS "preview_as_of_date" date,
  ADD COLUMN IF NOT EXISTS "preview_snapshot" jsonb;--> statement-breakpoint
-- PostgreSQL migrations run transactionally. The 0044 trigger must be suspended while
-- legacy terminal rows receive their one-time canonical proposal, then restored before commit.
ALTER TABLE "loan_replacements" DISABLE TRIGGER "loan_replacements_immutable";--> statement-breakpoint
UPDATE "loan_replacements"
SET
  "status" = CASE WHEN "status" = 'preview' THEN 'expired' ELSE "status" END,
  "preview_as_of_date" = ("created_at" AT TIME ZONE 'Asia/Bangkok')::date,
  "preview_snapshot" = jsonb_build_object(
    'schemaVersion', 0,
    'asOfDate', (("created_at" AT TIME ZONE 'Asia/Bangkok')::date)::text,
    'reason', "reason",
    'legacy', true,
    'proposalUnavailable', true
  )
WHERE "preview_as_of_date" IS NULL OR "preview_snapshot" IS NULL;--> statement-breakpoint
ALTER TABLE "loan_replacements" ENABLE TRIGGER "loan_replacements_immutable";--> statement-breakpoint
ALTER TABLE "loan_replacements"
  ALTER COLUMN "preview_as_of_date" SET NOT NULL,
  ALTER COLUMN "preview_snapshot" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "loan_replacements" DROP CONSTRAINT IF EXISTS "loan_replacements_preview_snapshot_check";--> statement-breakpoint
ALTER TABLE "loan_replacements" ADD CONSTRAINT "loan_replacements_preview_snapshot_check" CHECK (
  (
    jsonb_typeof("preview_snapshot") = 'object' AND
    jsonb_typeof("preview_snapshot" -> 'asOfDate') = 'string' AND
    "preview_snapshot" ->> 'asOfDate' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' AND
    "preview_snapshot" ->> 'asOfDate' = "preview_as_of_date"::text AND
    jsonb_typeof("preview_snapshot" -> 'reason') = 'string' AND
    "preview_snapshot" ->> 'reason' = "reason" AND
    (
      (
        jsonb_typeof("preview_snapshot" -> 'schemaVersion') = 'number' AND
        "preview_snapshot" ->> 'schemaVersion' = '1' AND
        jsonb_typeof("preview_snapshot" -> 'oldLoan') = 'object' AND
        "preview_snapshot" -> 'oldLoan' ->> 'loanPublicId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND
        "preview_snapshot" -> 'oldLoan' ->> 'statusBefore' = 'active' AND
        "preview_snapshot" -> 'oldLoan' ->> 'statusAfter' = 'replaced' AND
        "preview_snapshot" -> 'oldLoan' ->> 'principal' ~ '^(0|[1-9][0-9]*)[.][0-9]{2}$' AND
        jsonb_typeof("preview_snapshot" -> 'oldLoan' -> 'collectibleBefore') = 'object' AND
        "preview_snapshot" -> 'oldLoan' -> 'collectibleBefore' ->> 'principal' ~ '^(0|[1-9][0-9]*)[.][0-9]{2}$' AND
        "preview_snapshot" -> 'oldLoan' -> 'collectibleBefore' ->> 'interest' ~ '^(0|[1-9][0-9]*)[.][0-9]{2}$' AND
        "preview_snapshot" -> 'oldLoan' -> 'collectibleBefore' ->> 'fee' ~ '^(0|[1-9][0-9]*)[.][0-9]{2}$' AND
        "preview_snapshot" -> 'oldLoan' -> 'collectibleBefore' ->> 'penalty' ~ '^(0|[1-9][0-9]*)[.][0-9]{2}$' AND
        ("preview_snapshot" -> 'oldLoan' -> 'collectibleBefore') ? 'nextDueDate' AND
        (
          jsonb_typeof("preview_snapshot" -> 'oldLoan' -> 'collectibleBefore' -> 'nextDueDate') = 'null' OR
          (
            jsonb_typeof("preview_snapshot" -> 'oldLoan' -> 'collectibleBefore' -> 'nextDueDate') = 'string' AND
            "preview_snapshot" -> 'oldLoan' -> 'collectibleBefore' ->> 'nextDueDate' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
          )
        ) AND
        jsonb_typeof("preview_snapshot" -> 'oldLoan' -> 'collectibleAfter') = 'object' AND
        "preview_snapshot" -> 'oldLoan' -> 'collectibleAfter' ->> 'principal' = '0.00' AND
        "preview_snapshot" -> 'oldLoan' -> 'collectibleAfter' ->> 'interest' = '0.00' AND
        "preview_snapshot" -> 'oldLoan' -> 'collectibleAfter' ->> 'fee' = '0.00' AND
        "preview_snapshot" -> 'oldLoan' -> 'collectibleAfter' ->> 'penalty' = '0.00' AND
        jsonb_typeof("preview_snapshot" -> 'oldLoan' -> 'collectibleAfter' -> 'nextDueDate') = 'null' AND
        jsonb_typeof("preview_snapshot" -> 'cash') = 'object' AND
        "preview_snapshot" -> 'cash' ->> 'direction' = 'none' AND
        "preview_snapshot" -> 'cash' ->> 'amount' = '0.00' AND
        jsonb_typeof("preview_snapshot" -> 'correction') = 'object' AND
        "preview_snapshot" -> 'correction' ->> 'principal' ~ '^(0|[1-9][0-9]*)[.][0-9]{2}$' AND
        "preview_snapshot" -> 'correction' ->> 'interest' ~ '^(0|[1-9][0-9]*)[.][0-9]{2}$' AND
        "preview_snapshot" -> 'correction' ->> 'fee' ~ '^(0|[1-9][0-9]*)[.][0-9]{2}$' AND
        "preview_snapshot" -> 'correction' ->> 'penalty' ~ '^(0|[1-9][0-9]*)[.][0-9]{2}$' AND
        jsonb_typeof("preview_snapshot" -> 'replacement') = 'object' AND
        "preview_snapshot" -> 'replacement' ->> 'loanPublicId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND
        "preview_snapshot" -> 'replacement' ->> 'statusBefore' = 'draft' AND
        "preview_snapshot" -> 'replacement' ->> 'statusAfter' = 'active' AND
        "preview_snapshot" -> 'replacement' ->> 'principal' ~ '^(0|[1-9][0-9]*)[.][0-9]{2}$' AND
        "preview_snapshot" -> 'replacement' ->> 'interestRate' ~ '^(0|[1-9][0-9]*)[.][0-9]{2}$' AND
        "preview_snapshot" -> 'replacement' ->> 'repaymentType' IN ('daily', 'weekly', 'monthly') AND
        jsonb_typeof("preview_snapshot" -> 'replacement' -> 'termMonths') = 'number' AND
        "preview_snapshot" -> 'replacement' ->> 'termMonths' ~ '^[1-9][0-9]*$' AND
        jsonb_typeof("preview_snapshot" -> 'replacement' -> 'totalInstallments') = 'number' AND
        "preview_snapshot" -> 'replacement' ->> 'totalInstallments' ~ '^[1-9][0-9]*$' AND
        "preview_snapshot" -> 'replacement' ->> 'installmentAmount' ~ '^(0|[1-9][0-9]*)[.][0-9]{2}$' AND
        "preview_snapshot" -> 'replacement' ->> 'startDate' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' AND
        "preview_snapshot" -> 'replacement' ->> 'firstDueDate' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' AND
        "preview_snapshot" -> 'replacement' ->> 'lastDueDate' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' AND
        "preview_snapshot" -> 'replacement' ->> 'totalRepayment' ~ '^(0|[1-9][0-9]*)[.][0-9]{2}$' AND
        "preview_snapshot" -> 'replacement' ->> 'fundingSourceKind' IN ('drawdown', 'own_capital') AND
        "preview_snapshot" -> 'replacement' ->> 'fundingSourcePublicId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND
        jsonb_typeof("preview_snapshot" -> 'warnings') = 'array' AND
        NOT jsonb_path_exists("preview_snapshot", '$.warnings[*] ? (@.type() != "string")')
      )
      OR
      (
        "status" IN ('expired', 'executed', 'reversed') AND
        jsonb_typeof("preview_snapshot" -> 'schemaVersion') = 'number' AND
        "preview_snapshot" ->> 'schemaVersion' = '0' AND
        "preview_snapshot" -> 'legacy' = 'true'::jsonb AND
        "preview_snapshot" -> 'proposalUnavailable' = 'true'::jsonb
      )
    )
  ) IS TRUE
);--> statement-breakpoint
ALTER TABLE "loan_replacements" DROP CONSTRAINT IF EXISTS "loan_replacements_tenant_executed_audit_fk";--> statement-breakpoint
ALTER TABLE "loan_replacements" ADD CONSTRAINT "loan_replacements_tenant_executed_audit_fk"
  FOREIGN KEY ("tenant_id", "executed_audit_public_id")
  REFERENCES "audit_logs"("tenant_id", "public_id");--> statement-breakpoint
ALTER TABLE "loan_replacements" DROP CONSTRAINT IF EXISTS "loan_replacements_tenant_reversed_audit_fk";--> statement-breakpoint
ALTER TABLE "loan_replacements" ADD CONSTRAINT "loan_replacements_tenant_reversed_audit_fk"
  FOREIGN KEY ("tenant_id", "reversed_audit_public_id")
  REFERENCES "audit_logs"("tenant_id", "public_id");
