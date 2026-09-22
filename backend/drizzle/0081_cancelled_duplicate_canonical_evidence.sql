ALTER TABLE "payment_duplicate_review_candidates"
  ADD COLUMN IF NOT EXISTS "uses_canonical_evidence" boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN "payment_duplicate_review_candidates"."uses_canonical_evidence"
  IS 'Explicit audited opt-in to use the review canonical intake evidence for this cancelled, unposted duplicate candidate.';
