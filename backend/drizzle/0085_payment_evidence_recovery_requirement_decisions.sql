ALTER TABLE "payment_evidence_recovery_previews"
  ADD COLUMN IF NOT EXISTS "requirement_decision_reason" text;
