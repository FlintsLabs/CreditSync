CREATE TABLE "borrower_aliases" (
	"id" serial PRIMARY KEY NOT NULL,
	"public_id" uuid DEFAULT uuidv7() NOT NULL,
	"tenant_id" text NOT NULL,
	"borrower_id" integer NOT NULL,
	"alias" text NOT NULL,
	"normalized_alias" text NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"confirmed_at" timestamp,
	"created_by_user_id" integer,
	"updated_by_user_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "borrower_aliases_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "borrower_aliases_status_check" CHECK ("status" IN ('pending', 'confirmed', 'inactive'))
);
--> statement-breakpoint
CREATE TABLE "payment_intakes" (
	"id" serial PRIMARY KEY NOT NULL,
	"public_id" uuid DEFAULT uuidv7() NOT NULL,
	"tenant_id" text NOT NULL,
	"owner_user_id" integer,
	"source" text DEFAULT 'web' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"amount" numeric NOT NULL,
	"received_at" timestamp DEFAULT now() NOT NULL,
	"payer_name" text,
	"bank_reference" text,
	"bank_reference_hash" text,
	"qr_payload_hash" text,
	"idempotency_key" text,
	"duplicate_of_intake_id" integer,
	"notes" text,
	"posted_at" timestamp,
	"created_by_user_id" integer,
	"updated_by_user_id" integer,
	"posted_by_user_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "payment_intakes_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "payment_intakes_status_check" CHECK ("status" IN ('draft', 'needs_review', 'ready', 'posted', 'reversed', 'duplicate'))
);
--> statement-breakpoint
CREATE TABLE "payment_evidence" (
	"id" serial PRIMARY KEY NOT NULL,
	"public_id" uuid DEFAULT uuidv7() NOT NULL,
	"tenant_id" text NOT NULL,
	"payment_intake_id" integer NOT NULL,
	"file_id" integer,
	"evidence_type" text DEFAULT 'slip' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"evidence_hash" text,
	"mime_type" text,
	"declared_size" integer,
	"legacy_reference" text,
	"finalized_at" timestamp,
	"created_by_user_id" integer,
	"updated_by_user_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "payment_evidence_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "payment_evidence_status_check" CHECK ("status" IN ('pending', 'ready', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE "payment_match_proposals" (
	"id" serial PRIMARY KEY NOT NULL,
	"public_id" uuid DEFAULT uuidv7() NOT NULL,
	"tenant_id" text NOT NULL,
	"payment_intake_id" integer NOT NULL,
	"version" integer NOT NULL,
	"proposal_hash" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"warnings" jsonb,
	"expires_at" timestamp,
	"created_by_user_id" integer,
	"updated_by_user_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "payment_match_proposals_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "payment_match_proposals_status_check" CHECK ("status" IN ('draft', 'needs_review', 'ready', 'posted', 'stale'))
);
--> statement-breakpoint
CREATE TABLE "payment_match_allocations" (
	"id" serial PRIMARY KEY NOT NULL,
	"public_id" uuid DEFAULT uuidv7() NOT NULL,
	"tenant_id" text NOT NULL,
	"proposal_id" integer NOT NULL,
	"allocation_order" integer NOT NULL,
	"borrower_id" integer NOT NULL,
	"loan_id" integer NOT NULL,
	"schedule_id" integer,
	"amount" numeric NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"match_reason" text,
	"created_by_user_id" integer,
	"updated_by_user_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "payment_match_allocations_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "payment_match_allocations_status_check" CHECK ("status" IN ('proposed', 'posted', 'reversed'))
);
--> statement-breakpoint
CREATE TABLE "loan_renewals" (
	"id" serial PRIMARY KEY NOT NULL,
	"public_id" uuid DEFAULT uuidv7() NOT NULL,
	"tenant_id" text NOT NULL,
	"old_loan_id" integer NOT NULL,
	"new_loan_id" integer,
	"status" text DEFAULT 'preview' NOT NULL,
	"preview_hash" text NOT NULL,
	"requested_principal" numeric NOT NULL,
	"outstanding_principal" numeric NOT NULL,
	"due_charges" numeric DEFAULT '0' NOT NULL,
	"waived_charges" numeric DEFAULT '0' NOT NULL,
	"cash_direction" text,
	"cash_amount" numeric DEFAULT '0' NOT NULL,
	"reason" text,
	"idempotency_key" text,
	"expires_at" timestamp NOT NULL,
	"executed_at" timestamp,
	"reversed_at" timestamp,
	"created_by_user_id" integer,
	"updated_by_user_id" integer,
	"executed_by_user_id" integer,
	"reversed_by_user_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "loan_renewals_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "loan_renewals_status_check" CHECK ("status" IN ('preview', 'executed', 'reversed', 'expired')),
	CONSTRAINT "loan_renewals_cash_direction_check" CHECK ("cash_direction" IS NULL OR "cash_direction" IN ('payout', 'collection', 'none'))
);
--> statement-breakpoint
CREATE TABLE "loan_adjustments" (
	"id" serial PRIMARY KEY NOT NULL,
	"public_id" uuid DEFAULT uuidv7() NOT NULL,
	"tenant_id" text NOT NULL,
	"loan_id" integer NOT NULL,
	"renewal_id" integer,
	"adjustment_type" text NOT NULL,
	"amount" numeric NOT NULL,
	"status" text DEFAULT 'posted' NOT NULL,
	"idempotency_key" text,
	"reversed_adjustment_id" integer,
	"reason" text,
	"effective_at" timestamp DEFAULT now() NOT NULL,
	"created_by_user_id" integer,
	"updated_by_user_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "loan_adjustments_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "loan_adjustments_status_check" CHECK ("status" IN ('posted', 'reversed'))
);
--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "payment_intake_id" integer;
--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "entry_type" text DEFAULT 'repayment' NOT NULL;
--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "reversed_transaction_id" integer;
--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "idempotency_key" text;
--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "posted_at" timestamp;
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "actor_source" text DEFAULT 'system' NOT NULL;
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "request_id" text;
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "correlation_id" text;
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_source_check" CHECK ("actor_source" IN ('web', 'mcp', 'system'));
--> statement-breakpoint
ALTER TABLE "borrower_aliases" ADD CONSTRAINT "borrower_aliases_borrower_id_borrowers_id_fk" FOREIGN KEY ("borrower_id") REFERENCES "public"."borrowers"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "borrower_aliases" ADD CONSTRAINT "borrower_aliases_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "borrower_aliases" ADD CONSTRAINT "borrower_aliases_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payment_intakes" ADD CONSTRAINT "payment_intakes_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payment_intakes" ADD CONSTRAINT "payment_intakes_duplicate_of_intake_id_payment_intakes_id_fk" FOREIGN KEY ("duplicate_of_intake_id") REFERENCES "public"."payment_intakes"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payment_intakes" ADD CONSTRAINT "payment_intakes_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payment_intakes" ADD CONSTRAINT "payment_intakes_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payment_intakes" ADD CONSTRAINT "payment_intakes_posted_by_user_id_users_id_fk" FOREIGN KEY ("posted_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payment_evidence" ADD CONSTRAINT "payment_evidence_payment_intake_id_payment_intakes_id_fk" FOREIGN KEY ("payment_intake_id") REFERENCES "public"."payment_intakes"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payment_evidence" ADD CONSTRAINT "payment_evidence_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payment_evidence" ADD CONSTRAINT "payment_evidence_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payment_evidence" ADD CONSTRAINT "payment_evidence_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payment_match_proposals" ADD CONSTRAINT "payment_match_proposals_payment_intake_id_payment_intakes_id_fk" FOREIGN KEY ("payment_intake_id") REFERENCES "public"."payment_intakes"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payment_match_proposals" ADD CONSTRAINT "payment_match_proposals_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payment_match_proposals" ADD CONSTRAINT "payment_match_proposals_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payment_match_allocations" ADD CONSTRAINT "payment_match_allocations_proposal_id_payment_match_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."payment_match_proposals"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payment_match_allocations" ADD CONSTRAINT "payment_match_allocations_borrower_id_borrowers_id_fk" FOREIGN KEY ("borrower_id") REFERENCES "public"."borrowers"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payment_match_allocations" ADD CONSTRAINT "payment_match_allocations_loan_id_loans_id_fk" FOREIGN KEY ("loan_id") REFERENCES "public"."loans"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payment_match_allocations" ADD CONSTRAINT "payment_match_allocations_schedule_id_loan_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."loan_schedules"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payment_match_allocations" ADD CONSTRAINT "payment_match_allocations_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payment_match_allocations" ADD CONSTRAINT "payment_match_allocations_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "loan_renewals" ADD CONSTRAINT "loan_renewals_old_loan_id_loans_id_fk" FOREIGN KEY ("old_loan_id") REFERENCES "public"."loans"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "loan_renewals" ADD CONSTRAINT "loan_renewals_new_loan_id_loans_id_fk" FOREIGN KEY ("new_loan_id") REFERENCES "public"."loans"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "loan_renewals" ADD CONSTRAINT "loan_renewals_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "loan_renewals" ADD CONSTRAINT "loan_renewals_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "loan_renewals" ADD CONSTRAINT "loan_renewals_executed_by_user_id_users_id_fk" FOREIGN KEY ("executed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "loan_renewals" ADD CONSTRAINT "loan_renewals_reversed_by_user_id_users_id_fk" FOREIGN KEY ("reversed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "loan_adjustments" ADD CONSTRAINT "loan_adjustments_loan_id_loans_id_fk" FOREIGN KEY ("loan_id") REFERENCES "public"."loans"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "loan_adjustments" ADD CONSTRAINT "loan_adjustments_renewal_id_loan_renewals_id_fk" FOREIGN KEY ("renewal_id") REFERENCES "public"."loan_renewals"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "loan_adjustments" ADD CONSTRAINT "loan_adjustments_reversed_adjustment_id_loan_adjustments_id_fk" FOREIGN KEY ("reversed_adjustment_id") REFERENCES "public"."loan_adjustments"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "loan_adjustments" ADD CONSTRAINT "loan_adjustments_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "loan_adjustments" ADD CONSTRAINT "loan_adjustments_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_payment_intake_id_payment_intakes_id_fk" FOREIGN KEY ("payment_intake_id") REFERENCES "public"."payment_intakes"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_reversed_transaction_id_transactions_id_fk" FOREIGN KEY ("reversed_transaction_id") REFERENCES "public"."transactions"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "borrower_aliases_tenant_borrower_normalized_unique" ON "borrower_aliases" USING btree ("tenant_id", "borrower_id", "normalized_alias");
--> statement-breakpoint
CREATE UNIQUE INDEX "payment_intakes_tenant_idempotency_unique" ON "payment_intakes" USING btree ("tenant_id", "idempotency_key") WHERE "idempotency_key" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "payment_intakes_tenant_bank_reference_hash_unique" ON "payment_intakes" USING btree ("tenant_id", "bank_reference_hash") WHERE "bank_reference_hash" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "payment_intakes_tenant_qr_payload_hash_unique" ON "payment_intakes" USING btree ("tenant_id", "qr_payload_hash") WHERE "qr_payload_hash" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "payment_evidence_tenant_evidence_hash_unique" ON "payment_evidence" USING btree ("tenant_id", "evidence_hash") WHERE "evidence_hash" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "payment_match_proposals_tenant_intake_version_unique" ON "payment_match_proposals" USING btree ("tenant_id", "payment_intake_id", "version");
--> statement-breakpoint
CREATE UNIQUE INDEX "payment_match_allocations_tenant_proposal_order_unique" ON "payment_match_allocations" USING btree ("tenant_id", "proposal_id", "allocation_order");
--> statement-breakpoint
CREATE UNIQUE INDEX "loan_renewals_tenant_idempotency_unique" ON "loan_renewals" USING btree ("tenant_id", "idempotency_key") WHERE "idempotency_key" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "loan_adjustments_tenant_idempotency_unique" ON "loan_adjustments" USING btree ("tenant_id", "idempotency_key") WHERE "idempotency_key" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "loan_adjustments_tenant_reversed_adjustment_unique" ON "loan_adjustments" USING btree ("tenant_id", "reversed_adjustment_id") WHERE "reversed_adjustment_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "transactions_tenant_idempotency_unique" ON "transactions" USING btree ("tenant_id", "idempotency_key") WHERE "idempotency_key" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "transactions_tenant_reversed_transaction_unique" ON "transactions" USING btree ("tenant_id", "reversed_transaction_id") WHERE "reversed_transaction_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_entry_type_reference_check" CHECK (("entry_type" = 'repayment' AND "reversed_transaction_id" IS NULL) OR ("entry_type" = 'reversal' AND "reversed_transaction_id" IS NOT NULL));
--> statement-breakpoint
INSERT INTO "payment_intakes" (
	"tenant_id",
	"owner_user_id",
	"source",
	"status",
	"amount",
	"received_at",
	"idempotency_key",
	"posted_at",
	"created_by_user_id",
	"updated_by_user_id",
	"posted_by_user_id",
	"created_at",
	"updated_at"
)
SELECT
	t."tenant_id",
	t."owner_user_id",
	'legacy' AS "source",
	'posted' AS "status",
	t."amount",
	COALESCE(t."transaction_date", t."created_at", now()),
	'legacy-transaction:' || t."public_id"::text,
	COALESCE(t."transaction_date", t."created_at", now()),
	t."recorded_by_user_id",
	t."recorded_by_user_id",
	t."recorded_by_user_id",
	COALESCE(t."created_at", now()),
	COALESCE(t."updated_at", t."created_at", now())
FROM "transactions" AS t;
--> statement-breakpoint
UPDATE "transactions" AS t
SET
	"payment_intake_id" = pi."id",
	"entry_type" = 'repayment',
	"idempotency_key" = pi."idempotency_key",
	"posted_at" = pi."posted_at"
FROM "payment_intakes" AS pi
WHERE pi."tenant_id" = t."tenant_id"
  AND pi."idempotency_key" = 'legacy-transaction:' || t."public_id"::text;
--> statement-breakpoint
ALTER TABLE "transactions"
	ALTER COLUMN "posted_at" SET DEFAULT now(),
	ALTER COLUMN "posted_at" SET NOT NULL;
--> statement-breakpoint
INSERT INTO "payment_evidence" (
	"tenant_id",
	"payment_intake_id",
	"evidence_type",
	"status",
	"evidence_hash",
	"legacy_reference",
	"finalized_at",
	"created_by_user_id",
	"updated_by_user_id",
	"created_at",
	"updated_at"
)
SELECT
	t."tenant_id",
	t."payment_intake_id",
	'legacy_slip',
	'ready',
	'legacy:' || t."public_id"::text,
	t."slip_url",
	COALESCE(t."transaction_date", t."created_at", now()),
	t."recorded_by_user_id",
	t."recorded_by_user_id",
	COALESCE(t."created_at", now()),
	COALESCE(t."updated_at", t."created_at", now())
FROM "transactions" AS t
WHERE t."slip_url" IS NOT NULL
  AND btrim(t."slip_url") <> '';
--> statement-breakpoint
CREATE FUNCTION reject_audit_log_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	RAISE EXCEPTION 'audit_logs is append-only; % is not allowed', TG_OP;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER audit_logs_append_only
BEFORE UPDATE OR DELETE ON "audit_logs"
FOR EACH ROW EXECUTE FUNCTION reject_audit_log_mutation();
