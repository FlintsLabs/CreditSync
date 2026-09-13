ALTER TABLE "financial_evidence_requirement_attempts"
    ADD COLUMN "import_idempotency_key" text,
    ADD COLUMN "source_file_fingerprint" text,
    ADD COLUMN "binding_kind" text;

ALTER TABLE "financial_evidence_requirement_attempts"
    ADD CONSTRAINT "financial_evidence_requirement_attempts_binding_xor_check"
    CHECK (("import_idempotency_key" IS NULL) = ("source_file_fingerprint" IS NULL)
        AND ("import_idempotency_key" IS NULL) = ("binding_kind" IS NULL)),
    ADD CONSTRAINT "financial_evidence_requirement_attempts_import_key_check"
    CHECK ("import_idempotency_key" IS NULL OR length(btrim("import_idempotency_key")) BETWEEN 1 AND 512),
    ADD CONSTRAINT "financial_evidence_requirement_attempts_source_fingerprint_check"
    CHECK ("source_file_fingerprint" IS NULL OR "source_file_fingerprint" ~ '^[0-9a-f]{64}$'),
    ADD CONSTRAINT "financial_evidence_requirement_attempts_binding_kind_check"
    CHECK ("binding_kind" IS NULL OR "binding_kind" IN ('payment', 'disbursement'));

CREATE UNIQUE INDEX "financial_evidence_requirement_attempts_tenant_kind_import_unique"
    ON "financial_evidence_requirement_attempts" USING btree ("tenant_id", "binding_kind", "import_idempotency_key")
    WHERE "import_idempotency_key" IS NOT NULL;
