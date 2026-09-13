CREATE TABLE "financial_evidence_requirements" (
    "id" serial PRIMARY KEY NOT NULL,
    "public_id" uuid DEFAULT uuidv7() NOT NULL,
    "tenant_id" text NOT NULL,
    "payment_intake_id" integer,
    "loan_disbursement_event_id" integer,
    "expected_count" integer NOT NULL,
    "created_by_user_id" integer,
    "source" text NOT NULL,
    "request_id" text NOT NULL,
    "correlation_id" text NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "financial_evidence_requirements_public_id_unique" UNIQUE("public_id"),
    CONSTRAINT "financial_evidence_requirements_target_xor_check" CHECK (("payment_intake_id" IS NOT NULL) <> ("loan_disbursement_event_id" IS NOT NULL)),
    CONSTRAINT "financial_evidence_requirements_expected_count_check" CHECK ("expected_count" BETWEEN 1 AND 20),
    CONSTRAINT "financial_evidence_requirements_source_check" CHECK (length(btrim("source")) > 0),
    CONSTRAINT "financial_evidence_requirements_request_context_check" CHECK (length(btrim("request_id")) > 0 AND length(btrim("correlation_id")) > 0)
);
CREATE UNIQUE INDEX "financial_evidence_requirements_tenant_id_id_unique" ON "financial_evidence_requirements" USING btree ("tenant_id","id");
CREATE UNIQUE INDEX "financial_evidence_requirements_tenant_payment_unique" ON "financial_evidence_requirements" USING btree ("tenant_id","payment_intake_id") WHERE "payment_intake_id" IS NOT NULL;
CREATE UNIQUE INDEX "financial_evidence_requirements_tenant_disbursement_unique" ON "financial_evidence_requirements" USING btree ("tenant_id","loan_disbursement_event_id") WHERE "loan_disbursement_event_id" IS NOT NULL;
ALTER TABLE "financial_evidence_requirements" ADD CONSTRAINT "financial_evidence_requirements_tenant_payment_fk" FOREIGN KEY ("tenant_id","payment_intake_id") REFERENCES "public"."payment_intakes"("tenant_id","id");
ALTER TABLE "financial_evidence_requirements" ADD CONSTRAINT "financial_evidence_requirements_tenant_disbursement_fk" FOREIGN KEY ("tenant_id","loan_disbursement_event_id") REFERENCES "public"."loan_disbursement_events"("tenant_id","id");
ALTER TABLE "financial_evidence_requirements" ADD CONSTRAINT "financial_evidence_requirements_tenant_creator_fk" FOREIGN KEY ("tenant_id","created_by_user_id") REFERENCES "public"."users"("tenant_id","id");
