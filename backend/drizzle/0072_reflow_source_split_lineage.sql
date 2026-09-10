DROP INDEX "payment_reconciliation_reflow_entries_source_unique";
--> statement-breakpoint
CREATE UNIQUE INDEX "reflow_entries_source_replacement_unique"
  ON "payment_reconciliation_reflow_entries" ("tenant_id", "group_id", "source_allocation_id", "replacement_allocation_id");
