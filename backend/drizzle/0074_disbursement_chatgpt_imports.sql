ALTER TABLE "loan_disbursement_evidence_intents" ADD COLUMN "import_idempotency_key" text;
ALTER TABLE "loan_disbursement_evidence_intents" ADD COLUMN "source_file_fingerprint" text;
ALTER TABLE "loan_disbursement_evidence_intents" ADD COLUMN "finalized_audit_public_id" uuid;
CREATE UNIQUE INDEX "loan_disbursement_evidence_intents_tenant_import_key_unique" ON "loan_disbursement_evidence_intents" USING btree ("tenant_id", "import_idempotency_key") WHERE "import_idempotency_key" IS NOT NULL;
