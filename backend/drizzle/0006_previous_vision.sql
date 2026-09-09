ALTER TABLE "audit_logs" ADD COLUMN "public_id" uuid DEFAULT uuidv7() NOT NULL;--> statement-breakpoint
ALTER TABLE "bank_loan_repayments" ADD COLUMN "public_id" uuid DEFAULT uuidv7() NOT NULL;--> statement-breakpoint
ALTER TABLE "bank_loan_schedules" ADD COLUMN "public_id" uuid DEFAULT uuidv7() NOT NULL;--> statement-breakpoint
ALTER TABLE "bank_loans" ADD COLUMN "public_id" uuid DEFAULT uuidv7() NOT NULL;--> statement-breakpoint
ALTER TABLE "bank_profiles" ADD COLUMN "public_id" uuid DEFAULT uuidv7() NOT NULL;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD COLUMN "public_id" uuid DEFAULT uuidv7() NOT NULL;--> statement-breakpoint
ALTER TABLE "borrowers" ADD COLUMN "public_id" uuid DEFAULT uuidv7() NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_uploads" ADD COLUMN "public_id" uuid DEFAULT uuidv7() NOT NULL;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "public_id" uuid DEFAULT uuidv7() NOT NULL;--> statement-breakpoint
ALTER TABLE "fund_ledger_entries" ADD COLUMN "public_id" uuid DEFAULT uuidv7() NOT NULL;--> statement-breakpoint
ALTER TABLE "fund_rollover_entries" ADD COLUMN "public_id" uuid DEFAULT uuidv7() NOT NULL;--> statement-breakpoint
ALTER TABLE "loan_funding_allocations" ADD COLUMN "public_id" uuid DEFAULT uuidv7() NOT NULL;--> statement-breakpoint
ALTER TABLE "loan_schedules" ADD COLUMN "public_id" uuid DEFAULT uuidv7() NOT NULL;--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN "public_id" uuid DEFAULT uuidv7() NOT NULL;--> statement-breakpoint
ALTER TABLE "reconciliation_entries" ADD COLUMN "public_id" uuid DEFAULT uuidv7() NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_configs" ADD COLUMN "public_id" uuid DEFAULT uuidv7() NOT NULL;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "public_id" uuid DEFAULT uuidv7() NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "public_id" uuid DEFAULT uuidv7() NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_public_id_unique" UNIQUE("public_id");--> statement-breakpoint
ALTER TABLE "bank_loan_repayments" ADD CONSTRAINT "bank_loan_repayments_public_id_unique" UNIQUE("public_id");--> statement-breakpoint
ALTER TABLE "bank_loan_schedules" ADD CONSTRAINT "bank_loan_schedules_public_id_unique" UNIQUE("public_id");--> statement-breakpoint
ALTER TABLE "bank_loans" ADD CONSTRAINT "bank_loans_public_id_unique" UNIQUE("public_id");--> statement-breakpoint
ALTER TABLE "bank_profiles" ADD CONSTRAINT "bank_profiles_public_id_unique" UNIQUE("public_id");--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_public_id_unique" UNIQUE("public_id");--> statement-breakpoint
ALTER TABLE "borrowers" ADD CONSTRAINT "borrowers_public_id_unique" UNIQUE("public_id");--> statement-breakpoint
ALTER TABLE "bot_uploads" ADD CONSTRAINT "bot_uploads_public_id_unique" UNIQUE("public_id");--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_public_id_unique" UNIQUE("public_id");--> statement-breakpoint
ALTER TABLE "fund_ledger_entries" ADD CONSTRAINT "fund_ledger_entries_public_id_unique" UNIQUE("public_id");--> statement-breakpoint
ALTER TABLE "fund_rollover_entries" ADD CONSTRAINT "fund_rollover_entries_public_id_unique" UNIQUE("public_id");--> statement-breakpoint
ALTER TABLE "loan_funding_allocations" ADD CONSTRAINT "loan_funding_allocations_public_id_unique" UNIQUE("public_id");--> statement-breakpoint
ALTER TABLE "loan_schedules" ADD CONSTRAINT "loan_schedules_public_id_unique" UNIQUE("public_id");--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loans_public_id_unique" UNIQUE("public_id");--> statement-breakpoint
ALTER TABLE "reconciliation_entries" ADD CONSTRAINT "reconciliation_entries_public_id_unique" UNIQUE("public_id");--> statement-breakpoint
ALTER TABLE "tenant_configs" ADD CONSTRAINT "tenant_configs_public_id_unique" UNIQUE("public_id");--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_public_id_unique" UNIQUE("public_id");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_public_id_unique" UNIQUE("public_id");
