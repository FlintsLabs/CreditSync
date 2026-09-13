CREATE TABLE "financial_evidence_requirement_attempts" (
    "id" serial PRIMARY KEY NOT NULL,
    "public_id" uuid DEFAULT uuidv7() NOT NULL,
    "tenant_id" text NOT NULL,
    "financial_evidence_requirement_id" integer NOT NULL,
    "attempt_key" text NOT NULL,
    "created_by_user_id" integer,
    "source" text NOT NULL,
    "request_id" text NOT NULL,
    "correlation_id" text NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "financial_evidence_requirement_attempts_public_id_unique" UNIQUE("public_id"),
    CONSTRAINT "financial_evidence_requirement_attempts_key_check" CHECK (length(btrim("attempt_key")) BETWEEN 1 AND 512),
    CONSTRAINT "financial_evidence_requirement_attempts_source_check" CHECK (length(btrim("source")) > 0),
    CONSTRAINT "financial_evidence_requirement_attempts_request_context_check" CHECK (length(btrim("request_id")) > 0 AND length(btrim("correlation_id")) > 0)
);
CREATE UNIQUE INDEX "financial_evidence_requirement_attempts_tenant_id_id_unique" ON "financial_evidence_requirement_attempts" USING btree ("tenant_id","id");
CREATE UNIQUE INDEX "financial_evidence_requirement_attempts_tenant_requirement_key_unique" ON "financial_evidence_requirement_attempts" USING btree ("tenant_id","financial_evidence_requirement_id","attempt_key");
ALTER TABLE "financial_evidence_requirement_attempts" ADD CONSTRAINT "financial_evidence_requirement_attempts_tenant_requirement_fk" FOREIGN KEY ("tenant_id","financial_evidence_requirement_id") REFERENCES "public"."financial_evidence_requirements"("tenant_id","id");
ALTER TABLE "financial_evidence_requirement_attempts" ADD CONSTRAINT "financial_evidence_requirement_attempts_tenant_creator_fk" FOREIGN KEY ("tenant_id","created_by_user_id") REFERENCES "public"."users"("tenant_id","id");

CREATE OR REPLACE FUNCTION creditsync_guard_financial_evidence_requirement_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    parent_status text;
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'financial evidence requirements are append-only';
    END IF;
    IF TG_OP = 'UPDATE' THEN
        IF NEW.expected_count < OLD.expected_count THEN
            RAISE EXCEPTION 'financial evidence requirement count cannot decrease';
        END IF;
        IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
            OR NEW.payment_intake_id IS DISTINCT FROM OLD.payment_intake_id
            OR NEW.loan_disbursement_event_id IS DISTINCT FROM OLD.loan_disbursement_event_id THEN
            RAISE EXCEPTION 'financial evidence requirement target is immutable';
        END IF;
    END IF;
    IF NEW.payment_intake_id IS NOT NULL THEN
        SELECT status INTO parent_status FROM payment_intakes WHERE tenant_id = NEW.tenant_id AND id = NEW.payment_intake_id;
        IF parent_status IN ('posted', 'reversed', 'duplicate', 'cancelled') THEN
            RAISE EXCEPTION 'cannot register evidence requirement for immutable payment intake';
        END IF;
    ELSE
        SELECT status INTO parent_status FROM loan_disbursement_events WHERE tenant_id = NEW.tenant_id AND id = NEW.loan_disbursement_event_id;
        IF parent_status IS DISTINCT FROM 'draft' THEN
            RAISE EXCEPTION 'cannot register evidence requirement for immutable disbursement';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER financial_evidence_requirements_append_only_guard
BEFORE INSERT OR UPDATE OR DELETE ON financial_evidence_requirements
FOR EACH ROW EXECUTE FUNCTION creditsync_guard_financial_evidence_requirement_mutation();

CREATE OR REPLACE FUNCTION creditsync_guard_evidence_attempt_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    parent_status text;
    parent_kind text;
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'financial evidence requirement attempts are append-only';
    END IF;
    SELECT CASE WHEN r.payment_intake_id IS NOT NULL THEN 'payment' ELSE 'disbursement' END,
        CASE
            WHEN r.payment_intake_id IS NOT NULL THEN (SELECT status FROM payment_intakes WHERE tenant_id = r.tenant_id AND id = r.payment_intake_id)
            ELSE (SELECT status FROM loan_disbursement_events WHERE tenant_id = r.tenant_id AND id = r.loan_disbursement_event_id)
        END
    INTO parent_kind, parent_status
    FROM financial_evidence_requirements r
    WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.financial_evidence_requirement_id;
    IF (parent_kind = 'payment' AND parent_status IN ('posted', 'reversed', 'duplicate', 'cancelled'))
        OR (parent_kind = 'disbursement' AND parent_status IS DISTINCT FROM 'draft') THEN
        RAISE EXCEPTION 'cannot add an evidence attempt after the financial target is immutable';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER financial_evidence_requirement_attempts_append_only_guard
BEFORE INSERT OR UPDATE OR DELETE ON financial_evidence_requirement_attempts
FOR EACH ROW EXECUTE FUNCTION creditsync_guard_evidence_attempt_mutation();
