CREATE OR REPLACE FUNCTION validate_floating_transaction_allocation_totals()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	transaction_row "transactions"%ROWTYPE;
	allocated_component numeric := 0;
	expected_component numeric := 0;
	assessed_penalty numeric := 0;
	allocated_penalty numeric := 0;
BEGIN
	SELECT * INTO transaction_row
	FROM "transactions"
	WHERE "tenant_id" = NEW."tenant_id"
		AND "loan_id" = NEW."loan_id"
		AND "id" = NEW."transaction_id";

	IF NOT FOUND THEN
		RETURN NULL;
	END IF;

	SELECT COALESCE(SUM(allocation."amount"), 0)
	INTO allocated_component
	FROM "floating_transaction_allocations" allocation
	WHERE allocation."tenant_id" = NEW."tenant_id"
		AND allocation."loan_id" = NEW."loan_id"
		AND allocation."transaction_id" = NEW."transaction_id"
		AND allocation."component" = NEW."component";

	expected_component := CASE NEW."component"
		WHEN 'interest' THEN transaction_row."interest_component"
		WHEN 'penalty' THEN transaction_row."penalty_component"
	END;

	IF allocated_component > expected_component THEN
		RAISE EXCEPTION 'floating allocation total does not match transaction component';
	END IF;

	IF NEW."component" = 'penalty' THEN
		SELECT COALESCE(SUM(ledger."amount"), 0)
		INTO assessed_penalty
		FROM "floating_penalty_ledger_entries" ledger
		WHERE ledger."tenant_id" = NEW."tenant_id"
			AND ledger."loan_id" = NEW."loan_id"
			AND ledger."due_date" = NEW."due_date"
			AND ledger."penalty_date" <= NEW."effective_date";

		SELECT COALESCE(SUM(allocation."amount"), 0)
		INTO allocated_penalty
		FROM "floating_transaction_allocations" allocation
		WHERE allocation."tenant_id" = NEW."tenant_id"
			AND allocation."loan_id" = NEW."loan_id"
			AND allocation."component" = 'penalty'
			AND allocation."due_date" = NEW."due_date"
			AND allocation."effective_date" <= NEW."effective_date";

		IF assessed_penalty <= 0 THEN
			RAISE EXCEPTION 'floating penalty allocation requires an assessed due group';
		END IF;
		IF allocated_penalty < 0 OR allocated_penalty > assessed_penalty THEN
			RAISE EXCEPTION 'floating penalty allocations exceed the assessed due group';
		END IF;
	END IF;

	RETURN NULL;
END;
$$;
