-- Allow an audited payment-start-date amendment to move only unpaid due dates.
-- All other active-contract schedule mutations remain prohibited at the database boundary.
CREATE OR REPLACE FUNCTION reject_activated_loan_schedule_contract_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    loan_status text;
    amendment_audit_public_id text;
BEGIN
    SELECT "status" INTO loan_status
    FROM "loans"
    WHERE "tenant_id" = OLD."tenant_id" AND "id" = OLD."loan_id";

    IF loan_status IS DISTINCT FROM 'draft' THEN
        IF TG_OP = 'DELETE' THEN
            RAISE EXCEPTION 'activated loan schedules are immutable; DELETE is not allowed';
        END IF;
        IF ROW(
            OLD."tenant_id", OLD."loan_id", OLD."installment_no", OLD."due_date",
            OLD."scheduled_principal", OLD."scheduled_interest", OLD."scheduled_fee", OLD."scheduled_total"
        ) IS DISTINCT FROM ROW(
            NEW."tenant_id", NEW."loan_id", NEW."installment_no", NEW."due_date",
            NEW."scheduled_principal", NEW."scheduled_interest", NEW."scheduled_fee", NEW."scheduled_total"
        ) THEN
            amendment_audit_public_id := NULLIF(current_setting('creditsync.payment_start_date_amendment_audit_public_id', true), '');
            IF OLD."due_date" IS DISTINCT FROM NEW."due_date"
                AND OLD."tenant_id" = NEW."tenant_id"
                AND OLD."loan_id" = NEW."loan_id"
                AND OLD."installment_no" = NEW."installment_no"
                AND OLD."scheduled_principal" = NEW."scheduled_principal"
                AND OLD."scheduled_interest" = NEW."scheduled_interest"
                AND OLD."scheduled_fee" = NEW."scheduled_fee"
                AND OLD."scheduled_total" = NEW."scheduled_total"
                AND OLD."paid_total" = 0
                AND NEW."paid_total" = 0
                AND amendment_audit_public_id IS NOT NULL
                AND EXISTS (
                    SELECT 1
                    FROM "audit_logs" audit
                    JOIN "loans" loan ON loan."tenant_id" = audit."tenant_id" AND loan."public_id"::text = audit."entity_id"
                    WHERE audit."tenant_id" = OLD."tenant_id"
                      AND loan."id" = OLD."loan_id"
                      AND audit."public_id"::text = amendment_audit_public_id
                      AND audit."entity_type" = 'loan'
                      AND audit."action" = 'payment_start_date_changed'
                )
            THEN
                RETURN NEW;
            END IF;
            RAISE EXCEPTION 'activated loan schedule contractual fields are immutable';
        END IF;
    END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
