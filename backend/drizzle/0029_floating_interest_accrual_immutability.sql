CREATE FUNCTION enforce_loan_interest_accrual_immutability() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'loan interest accrual financial records are append-only; DELETE is not allowed';
	END IF;

	IF to_jsonb(NEW) - 'status' - 'paid_amount'
		IS DISTINCT FROM to_jsonb(OLD) - 'status' - 'paid_amount' THEN
		RAISE EXCEPTION 'loan interest accrual financial records are append-only; only status and paid_amount may change';
	END IF;

	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER loan_interest_accruals_immutable
BEFORE UPDATE OR DELETE ON loan_interest_accruals
FOR EACH ROW EXECUTE FUNCTION enforce_loan_interest_accrual_immutability();
