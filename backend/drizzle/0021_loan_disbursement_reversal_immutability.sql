CREATE OR REPLACE FUNCTION reject_posted_loan_disbursement_event_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Drafts remain mutable so the service can transition a prepared draft to posted.
  -- Every persisted ledger event is immutable after that transition, including
  -- compensating reversal rows created directly with status = 'reversed'.
  IF OLD."status" <> 'draft' THEN
    RAISE EXCEPTION 'loan_disbursement_events non-draft records are immutable; % is not allowed', TG_OP;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  RETURN NEW;
END;
$$;
