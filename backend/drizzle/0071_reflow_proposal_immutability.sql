CREATE OR REPLACE FUNCTION reject_payment_reconciliation_reflow_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payment reconciliation reflow provenance is immutable';
  END IF;
  IF TG_TABLE_NAME IN ('payment_reconciliation_reflow_groups', 'payment_reconciliation_reflow_entries') THEN
    RAISE EXCEPTION 'payment reconciliation reflow provenance is immutable';
  END IF;
  IF OLD.status = 'ready'
     AND NEW.status IN ('executed', 'expired')
     AND NEW.id = OLD.id
     AND NEW.public_id = OLD.public_id
     AND NEW.tenant_id = OLD.tenant_id
     AND NEW.reconciliation_group_id = OLD.reconciliation_group_id
     AND NEW.preview_hash = OLD.preview_hash
     AND NEW.expected_balance_version = OLD.expected_balance_version
     AND NEW.source_snapshot = OLD.source_snapshot
     AND NEW.proposed_reflow = OLD.proposed_reflow
     AND NEW.warnings = OLD.warnings
     AND NEW.reason = OLD.reason
     AND NEW.expires_at = OLD.expires_at
     AND NEW.created_by_user_id IS NOT DISTINCT FROM OLD.created_by_user_id
     AND NEW.created_at = OLD.created_at
     AND ((NEW.status = 'executed' AND NEW.executed_by_user_id IS NOT NULL AND NEW.executed_at IS NOT NULL)
       OR (NEW.status = 'expired' AND NEW.executed_by_user_id IS NULL AND NEW.executed_at IS NULL))
  THEN RETURN NEW;
  END IF;
  RAISE EXCEPTION 'payment reconciliation reflow proposal identity/content/lifecycle is immutable';
END;
$$ LANGUAGE plpgsql;
