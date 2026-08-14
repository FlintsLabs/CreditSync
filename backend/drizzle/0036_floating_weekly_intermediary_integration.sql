CREATE TABLE "intermediary_bank_accounts" (
	"id" serial PRIMARY KEY NOT NULL,
	"public_id" uuid DEFAULT uuidv7() NOT NULL,
	"tenant_id" text NOT NULL,
	"intermediary_id" integer NOT NULL,
	"bank_code" text,
	"bank_name" text NOT NULL,
	"account_name" text NOT NULL,
	"account_number_last4" text NOT NULL,
	"account_number_hash" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"note" text,
	"created_by_user_id" integer,
	"updated_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "intermediary_bank_accounts_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "intermediary_bank_accounts_status_check" CHECK ("intermediary_bank_accounts"."status" IN ('active', 'inactive')),
	CONSTRAINT "intermediary_bank_accounts_last4_check" CHECK ("intermediary_bank_accounts"."account_number_last4" ~ '^[0-9]{4}$'),
	CONSTRAINT "intermediary_bank_accounts_identity_check" CHECK ("intermediary_bank_accounts"."bank_name" ~ '[^[:space:]]' AND "intermediary_bank_accounts"."account_name" ~ '[^[:space:]]' AND "intermediary_bank_accounts"."account_number_hash" ~ '[^[:space:]]')
);
--> statement-breakpoint
CREATE TABLE "intermediated_disbursement_group_previews" (
	"id" serial PRIMARY KEY NOT NULL,
	"public_id" uuid DEFAULT uuidv7() NOT NULL,
	"tenant_id" text NOT NULL,
	"group_id" integer NOT NULL,
	"version" integer NOT NULL,
	"status" text NOT NULL,
	"expected_funding_amount" numeric NOT NULL,
	"actual_funding_amount" numeric NOT NULL,
	"expected_borrower_payout_amount" numeric NOT NULL,
	"actual_borrower_payout_amount" numeric NOT NULL,
	"expected_advance_interest_return_amount" numeric NOT NULL,
	"actual_advance_interest_return_amount" numeric NOT NULL,
	"retained_balance_amount" numeric NOT NULL,
	"variance_amount" numeric NOT NULL,
	"evidence_ready" boolean DEFAULT false NOT NULL,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"preview_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "intermediated_disbursement_group_previews_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "intermediated_disbursement_group_previews_version_check" CHECK ("intermediated_disbursement_group_previews"."version" > 0),
	CONSTRAINT "intermediated_disbursement_group_previews_status_check" CHECK ("intermediated_disbursement_group_previews"."status" IN ('needs_review', 'ready', 'stale', 'expired', 'executed')),
	CONSTRAINT "intermediated_disbursement_group_previews_amount_check" CHECK (
        "intermediated_disbursement_group_previews"."expected_funding_amount" >= 0 AND "intermediated_disbursement_group_previews"."actual_funding_amount" >= 0
        AND "intermediated_disbursement_group_previews"."expected_borrower_payout_amount" >= 0 AND "intermediated_disbursement_group_previews"."actual_borrower_payout_amount" >= 0
        AND "intermediated_disbursement_group_previews"."expected_advance_interest_return_amount" >= 0 AND "intermediated_disbursement_group_previews"."actual_advance_interest_return_amount" >= 0
        AND "intermediated_disbursement_group_previews"."retained_balance_amount" >= 0
    ),
	CONSTRAINT "intermediated_disbursement_group_previews_money_scale_check" CHECK (
        scale("intermediated_disbursement_group_previews"."expected_funding_amount") <= 2 AND scale("intermediated_disbursement_group_previews"."actual_funding_amount") <= 2
        AND scale("intermediated_disbursement_group_previews"."expected_borrower_payout_amount") <= 2 AND scale("intermediated_disbursement_group_previews"."actual_borrower_payout_amount") <= 2
        AND scale("intermediated_disbursement_group_previews"."expected_advance_interest_return_amount") <= 2 AND scale("intermediated_disbursement_group_previews"."actual_advance_interest_return_amount") <= 2
        AND scale("intermediated_disbursement_group_previews"."retained_balance_amount") <= 2 AND scale("intermediated_disbursement_group_previews"."variance_amount") <= 2
    ),
	CONSTRAINT "intermediated_disbursement_group_previews_money_finite_check" CHECK (
        "intermediated_disbursement_group_previews"."expected_funding_amount" NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
        AND "intermediated_disbursement_group_previews"."actual_funding_amount" NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
        AND "intermediated_disbursement_group_previews"."expected_borrower_payout_amount" NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
        AND "intermediated_disbursement_group_previews"."actual_borrower_payout_amount" NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
        AND "intermediated_disbursement_group_previews"."expected_advance_interest_return_amount" NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
        AND "intermediated_disbursement_group_previews"."actual_advance_interest_return_amount" NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
        AND "intermediated_disbursement_group_previews"."retained_balance_amount" NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
        AND "intermediated_disbursement_group_previews"."variance_amount" NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
    ),
	CONSTRAINT "intermediated_disbursement_group_previews_expected_balance_check" CHECK (
        "intermediated_disbursement_group_previews"."expected_funding_amount" = "intermediated_disbursement_group_previews"."expected_borrower_payout_amount"
            + "intermediated_disbursement_group_previews"."expected_advance_interest_return_amount" + "intermediated_disbursement_group_previews"."retained_balance_amount"
    ),
	CONSTRAINT "intermediated_disbursement_group_previews_actual_balance_check" CHECK (
        "intermediated_disbursement_group_previews"."variance_amount" = "intermediated_disbursement_group_previews"."actual_funding_amount" - "intermediated_disbursement_group_previews"."actual_borrower_payout_amount"
            - "intermediated_disbursement_group_previews"."actual_advance_interest_return_amount" - "intermediated_disbursement_group_previews"."retained_balance_amount"
    ),
	CONSTRAINT "intermediated_disbursement_group_previews_hash_check" CHECK ("intermediated_disbursement_group_previews"."preview_hash" ~ '[^[:space:]]'),
	CONSTRAINT "intermediated_disbursement_group_previews_expiry_check" CHECK ("intermediated_disbursement_group_previews"."expires_at" > "intermediated_disbursement_group_previews"."created_at"),
	CONSTRAINT "intermediated_disbursement_group_previews_ready_check" CHECK (
        "intermediated_disbursement_group_previews"."status" <> 'ready' OR ("intermediated_disbursement_group_previews"."variance_amount" = 0 AND "intermediated_disbursement_group_previews"."evidence_ready")
    )
);
--> statement-breakpoint
CREATE TABLE "intermediated_disbursement_groups" (
	"id" serial PRIMARY KEY NOT NULL,
	"public_id" uuid DEFAULT uuidv7() NOT NULL,
	"tenant_id" text NOT NULL,
	"loan_id" integer NOT NULL,
	"intermediary_id" integer NOT NULL,
	"expected_funding_amount" numeric NOT NULL,
	"expected_borrower_payout_amount" numeric NOT NULL,
	"expected_advance_interest_return_amount" numeric NOT NULL,
	"retained_balance_amount" numeric DEFAULT '0' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"idempotency_key" text NOT NULL,
	"post_idempotency_key" text,
	"reversed_group_id" integer,
	"reversal_idempotency_key" text,
	"reversal_request_hash" text,
	"reversal_reason" text,
	"note" text,
	"created_by_user_id" integer,
	"updated_by_user_id" integer,
	"posted_by_user_id" integer,
	"reversed_by_user_id" integer,
	"posted_at" timestamp with time zone,
	"reversed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "intermediated_disbursement_groups_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "intermediated_disbursement_groups_status_check" CHECK ("intermediated_disbursement_groups"."status" IN ('draft', 'needs_review', 'ready', 'posted', 'reversed')),
	CONSTRAINT "intermediated_disbursement_groups_money_check" CHECK (
        "intermediated_disbursement_groups"."expected_funding_amount" >= 0
        AND "intermediated_disbursement_groups"."expected_borrower_payout_amount" >= 0
        AND "intermediated_disbursement_groups"."expected_advance_interest_return_amount" >= 0
        AND "intermediated_disbursement_groups"."retained_balance_amount" >= 0
    ),
	CONSTRAINT "intermediated_disbursement_groups_money_scale_check" CHECK (
        scale("intermediated_disbursement_groups"."expected_funding_amount") <= 2
        AND scale("intermediated_disbursement_groups"."expected_borrower_payout_amount") <= 2
        AND scale("intermediated_disbursement_groups"."expected_advance_interest_return_amount") <= 2
        AND scale("intermediated_disbursement_groups"."retained_balance_amount") <= 2
    ),
	CONSTRAINT "intermediated_disbursement_groups_money_finite_check" CHECK (
        "intermediated_disbursement_groups"."expected_funding_amount" NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
        AND "intermediated_disbursement_groups"."expected_borrower_payout_amount" NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
        AND "intermediated_disbursement_groups"."expected_advance_interest_return_amount" NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
        AND "intermediated_disbursement_groups"."retained_balance_amount" NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
    ),
	CONSTRAINT "intermediated_disbursement_groups_command_keys_check" CHECK (
        "intermediated_disbursement_groups"."idempotency_key" ~ '[^[:space:]]'
        AND ("intermediated_disbursement_groups"."post_idempotency_key" IS NULL OR "intermediated_disbursement_groups"."post_idempotency_key" ~ '[^[:space:]]')
        AND ("intermediated_disbursement_groups"."reversal_idempotency_key" IS NULL OR "intermediated_disbursement_groups"."reversal_idempotency_key" ~ '[^[:space:]]')
        AND ("intermediated_disbursement_groups"."reversal_request_hash" IS NULL OR "intermediated_disbursement_groups"."reversal_request_hash" ~ '[^[:space:]]')
    ),
	CONSTRAINT "intermediated_disbursement_groups_expected_balance_check" CHECK (
        "intermediated_disbursement_groups"."expected_funding_amount" = "intermediated_disbursement_groups"."expected_borrower_payout_amount"
            + "intermediated_disbursement_groups"."expected_advance_interest_return_amount" + "intermediated_disbursement_groups"."retained_balance_amount"
    ),
	CONSTRAINT "intermediated_disbursement_groups_lifecycle_check" CHECK (
        ("intermediated_disbursement_groups"."status" IN ('draft', 'needs_review', 'ready')
            AND "intermediated_disbursement_groups"."reversed_group_id" IS NULL AND "intermediated_disbursement_groups"."posted_at" IS NULL AND "intermediated_disbursement_groups"."reversed_at" IS NULL)
        OR ("intermediated_disbursement_groups"."status" = 'posted'
            AND "intermediated_disbursement_groups"."reversed_group_id" IS NULL AND "intermediated_disbursement_groups"."post_idempotency_key" IS NOT NULL
            AND "intermediated_disbursement_groups"."posted_at" IS NOT NULL AND "intermediated_disbursement_groups"."reversed_at" IS NULL)
        OR ("intermediated_disbursement_groups"."status" = 'reversed'
            AND "intermediated_disbursement_groups"."reversed_group_id" IS NOT NULL AND "intermediated_disbursement_groups"."posted_at" IS NOT NULL AND "intermediated_disbursement_groups"."reversed_at" IS NOT NULL
            AND "intermediated_disbursement_groups"."reversal_idempotency_key" IS NOT NULL
            AND "intermediated_disbursement_groups"."reversal_request_hash" IS NOT NULL AND "intermediated_disbursement_groups"."reversal_request_hash" ~ '[^[:space:]]'
            AND "intermediated_disbursement_groups"."reversal_reason" IS NOT NULL AND "intermediated_disbursement_groups"."reversal_reason" ~ '[^[:space:]]')
    )
);
--> statement-breakpoint
CREATE TABLE "intermediated_transfer_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"public_id" uuid DEFAULT uuidv7() NOT NULL,
	"tenant_id" text NOT NULL,
	"group_id" integer NOT NULL,
	"intermediary_bank_account_id" integer,
	"role" text NOT NULL,
	"channel" text NOT NULL,
	"amount" numeric NOT NULL,
	"sender_hint" text,
	"payee_hint" text,
	"bank_reference" text,
	"bank_reference_hash" text,
	"transferred_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"idempotency_key" text NOT NULL,
	"reversed_event_id" integer,
	"reversal_reason" text,
	"note" text,
	"created_by_user_id" integer,
	"updated_by_user_id" integer,
	"posted_at" timestamp with time zone,
	"reversed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "intermediated_transfer_events_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "intermediated_transfer_events_role_check" CHECK ("intermediated_transfer_events"."role" IN ('funding_to_intermediary', 'borrower_net_payout', 'advance_interest_return')),
	CONSTRAINT "intermediated_transfer_events_channel_check" CHECK ("intermediated_transfer_events"."channel" IN ('bank_transfer', 'cash', 'adjustment')),
	CONSTRAINT "intermediated_transfer_events_status_check" CHECK ("intermediated_transfer_events"."status" IN ('draft', 'ready', 'posted', 'reversed')),
	CONSTRAINT "intermediated_transfer_events_money_check" CHECK ("intermediated_transfer_events"."amount" >= 0),
	CONSTRAINT "intermediated_transfer_events_money_scale_check" CHECK (scale("intermediated_transfer_events"."amount") <= 2),
	CONSTRAINT "intermediated_transfer_events_money_finite_check" CHECK ("intermediated_transfer_events"."amount" NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)),
	CONSTRAINT "intermediated_transfer_events_command_keys_check" CHECK (
        "intermediated_transfer_events"."idempotency_key" ~ '[^[:space:]]'
        AND ("intermediated_transfer_events"."bank_reference_hash" IS NULL OR "intermediated_transfer_events"."bank_reference_hash" ~ '[^[:space:]]')
    ),
	CONSTRAINT "intermediated_transfer_events_lifecycle_check" CHECK (
        ("intermediated_transfer_events"."status" IN ('draft', 'ready')
            AND "intermediated_transfer_events"."reversed_event_id" IS NULL AND "intermediated_transfer_events"."posted_at" IS NULL AND "intermediated_transfer_events"."reversed_at" IS NULL)
        OR ("intermediated_transfer_events"."status" = 'posted'
            AND "intermediated_transfer_events"."reversed_event_id" IS NULL AND "intermediated_transfer_events"."posted_at" IS NOT NULL AND "intermediated_transfer_events"."reversed_at" IS NULL)
        OR ("intermediated_transfer_events"."status" = 'reversed'
            AND "intermediated_transfer_events"."reversed_event_id" IS NOT NULL AND "intermediated_transfer_events"."posted_at" IS NOT NULL AND "intermediated_transfer_events"."reversed_at" IS NOT NULL
            AND "intermediated_transfer_events"."reversal_reason" IS NOT NULL AND "intermediated_transfer_events"."reversal_reason" ~ '[^[:space:]]')
    )
);
--> statement-breakpoint
CREATE TABLE "intermediated_transfer_evidence" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"event_id" integer NOT NULL,
	"file_id" integer NOT NULL,
	"created_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "intermediated_transfer_evidence_intents" (
	"id" serial PRIMARY KEY NOT NULL,
	"public_id" uuid DEFAULT uuidv7() NOT NULL,
	"tenant_id" text NOT NULL,
	"event_id" integer NOT NULL,
	"file_id" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"evidence_hash" text NOT NULL,
	"mime_type" text NOT NULL,
	"declared_size" integer NOT NULL,
	"upload_expires_at" timestamp with time zone NOT NULL,
	"finalized_at" timestamp with time zone,
	"created_by_user_id" integer,
	"updated_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "intermediated_transfer_evidence_intents_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "intermediated_transfer_evidence_intents_status_check" CHECK ("intermediated_transfer_evidence_intents"."status" IN ('pending', 'ready')),
	CONSTRAINT "intermediated_transfer_evidence_intents_metadata_check" CHECK ("intermediated_transfer_evidence_intents"."evidence_hash" ~ '[^[:space:]]' AND "intermediated_transfer_evidence_intents"."mime_type" ~ '[^[:space:]]' AND "intermediated_transfer_evidence_intents"."declared_size" > 0),
	CONSTRAINT "intermediated_transfer_evidence_intents_lifecycle_check" CHECK (
        ("intermediated_transfer_evidence_intents"."status" = 'pending' AND "intermediated_transfer_evidence_intents"."finalized_at" IS NULL)
        OR ("intermediated_transfer_evidence_intents"."status" = 'ready' AND "intermediated_transfer_evidence_intents"."finalized_at" IS NOT NULL)
    )
);
--> statement-breakpoint
CREATE TABLE "loan_intermediary_assignments" (
	"id" serial PRIMARY KEY NOT NULL,
	"public_id" uuid DEFAULT uuidv7() NOT NULL,
	"tenant_id" text NOT NULL,
	"loan_id" integer NOT NULL,
	"intermediary_id" integer NOT NULL,
	"role" text NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"status" text DEFAULT 'active' NOT NULL,
	"idempotency_key" text NOT NULL,
	"note" text,
	"created_by_user_id" integer,
	"updated_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loan_intermediary_assignments_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "loan_intermediary_assignments_role_check" CHECK ("loan_intermediary_assignments"."role" IN ('disbursement', 'collection', 'both')),
	CONSTRAINT "loan_intermediary_assignments_status_check" CHECK ("loan_intermediary_assignments"."status" IN ('active', 'ended')),
	CONSTRAINT "loan_intermediary_assignments_idempotency_key_check" CHECK ("loan_intermediary_assignments"."idempotency_key" ~ '[^[:space:]]'),
	CONSTRAINT "loan_intermediary_assignments_date_order_check" CHECK ("loan_intermediary_assignments"."effective_to" IS NULL OR "loan_intermediary_assignments"."effective_to" > "loan_intermediary_assignments"."effective_from"),
	CONSTRAINT "loan_intermediary_assignments_lifecycle_check" CHECK (("loan_intermediary_assignments"."status" = 'active' AND "loan_intermediary_assignments"."effective_to" IS NULL) OR ("loan_intermediary_assignments"."status" = 'ended' AND "loan_intermediary_assignments"."effective_to" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "loan_settlement_previews" (
	"id" serial PRIMARY KEY NOT NULL,
	"public_id" uuid DEFAULT uuidv7() NOT NULL,
	"tenant_id" text NOT NULL,
	"loan_id" integer NOT NULL,
	"as_of_date" date NOT NULL,
	"outstanding_principal" numeric NOT NULL,
	"due_interest" numeric NOT NULL,
	"accrued_not_due_interest" numeric NOT NULL,
	"outstanding_fees" numeric NOT NULL,
	"outstanding_penalties" numeric NOT NULL,
	"original_outstanding_interest" numeric NOT NULL,
	"original_next_due_date" date,
	"non_refundable_advance_interest" numeric NOT NULL,
	"settlement_total" numeric NOT NULL,
	"balance_version" text NOT NULL,
	"preview_hash" text NOT NULL,
	"status" text DEFAULT 'ready' NOT NULL,
	"execute_idempotency_key" text,
	"executed_audit_public_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"executed_at" timestamp with time zone,
	"created_by_user_id" integer,
	"executed_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loan_settlement_previews_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "loan_settlement_previews_status_check" CHECK ("loan_settlement_previews"."status" IN ('ready', 'executed', 'expired')),
	CONSTRAINT "loan_settlement_previews_hash_check" CHECK (length("loan_settlement_previews"."preview_hash") > 0 AND length("loan_settlement_previews"."balance_version") > 0),
	CONSTRAINT "loan_settlement_previews_expiry_check" CHECK ("loan_settlement_previews"."expires_at" > "loan_settlement_previews"."created_at"),
	CONSTRAINT "loan_settlement_previews_amounts_check" CHECK (
        "loan_settlement_previews"."outstanding_principal" >= 0 AND "loan_settlement_previews"."due_interest" >= 0
        AND "loan_settlement_previews"."accrued_not_due_interest" >= 0 AND "loan_settlement_previews"."outstanding_fees" >= 0
        AND "loan_settlement_previews"."outstanding_penalties" >= 0 AND "loan_settlement_previews"."non_refundable_advance_interest" >= 0
        AND "loan_settlement_previews"."settlement_total" >= 0
    ),
	CONSTRAINT "loan_settlement_previews_total_check" CHECK (
        "loan_settlement_previews"."settlement_total" = "loan_settlement_previews"."outstanding_principal" + "loan_settlement_previews"."due_interest"
            + "loan_settlement_previews"."accrued_not_due_interest" + "loan_settlement_previews"."outstanding_fees" + "loan_settlement_previews"."outstanding_penalties"
    )
);
--> statement-breakpoint
ALTER TABLE "loan_interest_accruals" DROP CONSTRAINT "loan_interest_accruals_period_snapshot_check";--> statement-breakpoint
DROP TRIGGER "loan_interest_accruals_history_immutable" ON "loan_interest_accruals";--> statement-breakpoint
ALTER TABLE "loan_interest_accruals" ADD COLUMN "period_unit" text;--> statement-breakpoint
ALTER TABLE "loan_interest_accruals" ADD COLUMN "period_length" integer;--> statement-breakpoint
ALTER TABLE "loan_interest_accruals" ADD COLUMN "contractual_interest_amount" numeric;--> statement-breakpoint
ALTER TABLE "loan_interest_accruals" ADD COLUMN "daily_increment_amount" numeric;--> statement-breakpoint
ALTER TABLE "loan_interest_rate_periods" ADD COLUMN "period_unit" text DEFAULT 'day' NOT NULL;--> statement-breakpoint
ALTER TABLE "loan_interest_rate_periods" ADD COLUMN "period_length" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN "interest_period_unit" text;--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN "interest_period_length" integer;--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN "advance_interest_periods" integer;--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN "advance_interest_refund_policy" text;--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN "interest_period_anchor_date" date;--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN "activation_idempotency_key" text;--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN "activation_result" jsonb;--> statement-breakpoint
UPDATE "loans"
SET "interest_period_unit" = CASE "floating_accrual_cycle"
        WHEN 'weekly' THEN 'week'
        ELSE 'day'
    END,
    "interest_period_length" = 1,
    "advance_interest_periods" = CASE
        WHEN "first_day_treatment" = 'deduct' THEN 1
        ELSE 0
    END,
    "advance_interest_refund_policy" = 'non_refundable',
    "interest_period_anchor_date" = COALESCE("interest_start_date", "start_date")
WHERE "repayment_type" = 'floating'
  AND "daily_interest_mode" IN ('percent', 'per_thousand')
  AND "daily_interest_rate" IS NOT NULL
  AND COALESCE("interest_start_date", "start_date") IS NOT NULL;--> statement-breakpoint
UPDATE "loan_interest_rate_periods" AS "rate_period"
SET "period_unit" = CASE
        WHEN "loan"."floating_accrual_cycle" = 'weekly' THEN 'week'
        ELSE 'day'
    END,
    "period_length" = 1
FROM "loans" AS "loan"
WHERE "rate_period"."tenant_id" = "loan"."tenant_id"
  AND "rate_period"."loan_id" = "loan"."id";--> statement-breakpoint
-- Existing main weekly snapshots and all financial amounts remain authoritative.
-- Only absent legacy period metadata and the newly introduced policy projection
-- are derived. Each accrual row's immutable principal/rate snapshots are the
-- authoritative inputs to the generalized daily/weekly contractual kernel.
UPDATE "loan_interest_accruals" AS "accrual"
SET "period_start_date" = COALESCE("accrual"."period_start_date", "accrual"."accrual_date"),
    "period_end_date" = COALESCE("accrual"."period_end_date", "accrual"."accrual_date" + 1),
    "period_day_index" = COALESCE("accrual"."period_day_index", 1),
    "period_days" = COALESCE("accrual"."period_days", 1),
    "period_unit" = CASE WHEN COALESCE("accrual"."period_days", 1) = 7 THEN 'week' ELSE 'day' END,
    "period_length" = 1,
    "contractual_interest_amount" = CASE "accrual"."rate_mode"
        WHEN 'percent' THEN round("accrual"."opening_principal" * "accrual"."rate" / 100, 2)
        WHEN 'per_thousand' THEN round("accrual"."opening_principal" * "accrual"."rate" / 1000, 2)
        ELSE COALESCE("accrual"."cumulative_interest_amount", "accrual"."interest_amount")
    END,
    "cumulative_interest_amount" = COALESCE("accrual"."cumulative_interest_amount", "accrual"."interest_amount"),
    "daily_increment_amount" = "accrual"."interest_amount";--> statement-breakpoint
CREATE UNIQUE INDEX "intermediary_bank_accounts_tenant_id_id_unique" ON "intermediary_bank_accounts" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "intermediated_disbursement_groups_tenant_id_id_unique" ON "intermediated_disbursement_groups" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "intermediated_transfer_events_tenant_id_id_unique" ON "intermediated_transfer_events" USING btree ("tenant_id","id");--> statement-breakpoint
ALTER TABLE "intermediary_bank_accounts" ADD CONSTRAINT "intermediary_bank_accounts_tenant_intermediary_fk" FOREIGN KEY ("tenant_id","intermediary_id") REFERENCES "public"."intermediaries"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intermediary_bank_accounts" ADD CONSTRAINT "intermediary_bank_accounts_tenant_created_by_fk" FOREIGN KEY ("tenant_id","created_by_user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intermediary_bank_accounts" ADD CONSTRAINT "intermediary_bank_accounts_tenant_updated_by_fk" FOREIGN KEY ("tenant_id","updated_by_user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intermediated_disbursement_group_previews" ADD CONSTRAINT "intermediated_disbursement_group_previews_tenant_group_fk" FOREIGN KEY ("tenant_id","group_id") REFERENCES "public"."intermediated_disbursement_groups"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intermediated_disbursement_group_previews" ADD CONSTRAINT "intermediated_disbursement_group_previews_tenant_created_by_fk" FOREIGN KEY ("tenant_id","created_by_user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intermediated_disbursement_groups" ADD CONSTRAINT "intermediated_disbursement_groups_tenant_loan_fk" FOREIGN KEY ("tenant_id","loan_id") REFERENCES "public"."loans"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intermediated_disbursement_groups" ADD CONSTRAINT "intermediated_disbursement_groups_tenant_intermediary_fk" FOREIGN KEY ("tenant_id","intermediary_id") REFERENCES "public"."intermediaries"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intermediated_disbursement_groups" ADD CONSTRAINT "intermediated_disbursement_groups_tenant_reversed_group_fk" FOREIGN KEY ("tenant_id","reversed_group_id") REFERENCES "public"."intermediated_disbursement_groups"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intermediated_disbursement_groups" ADD CONSTRAINT "intermediated_disbursement_groups_tenant_created_by_fk" FOREIGN KEY ("tenant_id","created_by_user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intermediated_disbursement_groups" ADD CONSTRAINT "intermediated_disbursement_groups_tenant_updated_by_fk" FOREIGN KEY ("tenant_id","updated_by_user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intermediated_disbursement_groups" ADD CONSTRAINT "intermediated_disbursement_groups_tenant_posted_by_fk" FOREIGN KEY ("tenant_id","posted_by_user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intermediated_disbursement_groups" ADD CONSTRAINT "intermediated_disbursement_groups_tenant_reversed_by_fk" FOREIGN KEY ("tenant_id","reversed_by_user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intermediated_transfer_events" ADD CONSTRAINT "intermediated_transfer_events_tenant_group_fk" FOREIGN KEY ("tenant_id","group_id") REFERENCES "public"."intermediated_disbursement_groups"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intermediated_transfer_events" ADD CONSTRAINT "intermediated_transfer_events_tenant_bank_account_fk" FOREIGN KEY ("tenant_id","intermediary_bank_account_id") REFERENCES "public"."intermediary_bank_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intermediated_transfer_events" ADD CONSTRAINT "intermediated_transfer_events_tenant_reversed_event_fk" FOREIGN KEY ("tenant_id","reversed_event_id") REFERENCES "public"."intermediated_transfer_events"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intermediated_transfer_events" ADD CONSTRAINT "intermediated_transfer_events_tenant_created_by_fk" FOREIGN KEY ("tenant_id","created_by_user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intermediated_transfer_events" ADD CONSTRAINT "intermediated_transfer_events_tenant_updated_by_fk" FOREIGN KEY ("tenant_id","updated_by_user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intermediated_transfer_evidence" ADD CONSTRAINT "intermediated_transfer_evidence_tenant_event_fk" FOREIGN KEY ("tenant_id","event_id") REFERENCES "public"."intermediated_transfer_events"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intermediated_transfer_evidence" ADD CONSTRAINT "intermediated_transfer_evidence_tenant_file_fk" FOREIGN KEY ("tenant_id","file_id") REFERENCES "public"."files"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intermediated_transfer_evidence" ADD CONSTRAINT "intermediated_transfer_evidence_tenant_created_by_fk" FOREIGN KEY ("tenant_id","created_by_user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intermediated_transfer_evidence_intents" ADD CONSTRAINT "intermediated_transfer_evidence_intents_tenant_event_fk" FOREIGN KEY ("tenant_id","event_id") REFERENCES "public"."intermediated_transfer_events"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intermediated_transfer_evidence_intents" ADD CONSTRAINT "intermediated_transfer_evidence_intents_tenant_file_fk" FOREIGN KEY ("tenant_id","file_id") REFERENCES "public"."files"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intermediated_transfer_evidence_intents" ADD CONSTRAINT "intermediated_transfer_evidence_intents_tenant_created_by_fk" FOREIGN KEY ("tenant_id","created_by_user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intermediated_transfer_evidence_intents" ADD CONSTRAINT "intermediated_transfer_evidence_intents_tenant_updated_by_fk" FOREIGN KEY ("tenant_id","updated_by_user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_intermediary_assignments" ADD CONSTRAINT "loan_intermediary_assignments_tenant_loan_fk" FOREIGN KEY ("tenant_id","loan_id") REFERENCES "public"."loans"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_intermediary_assignments" ADD CONSTRAINT "loan_intermediary_assignments_tenant_intermediary_fk" FOREIGN KEY ("tenant_id","intermediary_id") REFERENCES "public"."intermediaries"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_intermediary_assignments" ADD CONSTRAINT "loan_intermediary_assignments_tenant_created_by_fk" FOREIGN KEY ("tenant_id","created_by_user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_intermediary_assignments" ADD CONSTRAINT "loan_intermediary_assignments_tenant_updated_by_fk" FOREIGN KEY ("tenant_id","updated_by_user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_settlement_previews" ADD CONSTRAINT "loan_settlement_previews_tenant_loan_fk" FOREIGN KEY ("tenant_id","loan_id") REFERENCES "public"."loans"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_settlement_previews" ADD CONSTRAINT "loan_settlement_previews_tenant_created_by_fk" FOREIGN KEY ("tenant_id","created_by_user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_settlement_previews" ADD CONSTRAINT "loan_settlement_previews_tenant_executed_by_fk" FOREIGN KEY ("tenant_id","executed_by_user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "intermediary_bank_accounts_tenant_hash_unique" ON "intermediary_bank_accounts" USING btree ("tenant_id","account_number_hash");--> statement-breakpoint
CREATE INDEX "intermediary_bank_accounts_tenant_intermediary_status_idx" ON "intermediary_bank_accounts" USING btree ("tenant_id","intermediary_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "intermediated_disbursement_group_previews_tenant_id_id_unique" ON "intermediated_disbursement_group_previews" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "intermediated_disbursement_group_previews_version_unique" ON "intermediated_disbursement_group_previews" USING btree ("tenant_id","group_id","version");--> statement-breakpoint
CREATE INDEX "intermediated_disbursement_group_previews_tenant_group_created_idx" ON "intermediated_disbursement_group_previews" USING btree ("tenant_id","group_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "intermediated_disbursement_groups_tenant_idempotency_unique" ON "intermediated_disbursement_groups" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "intermediated_disbursement_groups_tenant_post_idempotency_unique" ON "intermediated_disbursement_groups" USING btree ("tenant_id","post_idempotency_key") WHERE "intermediated_disbursement_groups"."post_idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "intermediated_disbursement_groups_tenant_reversal_idempotency_unique" ON "intermediated_disbursement_groups" USING btree ("tenant_id","reversal_idempotency_key") WHERE "intermediated_disbursement_groups"."reversal_idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "intermediated_disbursement_groups_tenant_reversed_group_unique" ON "intermediated_disbursement_groups" USING btree ("tenant_id","reversed_group_id") WHERE "intermediated_disbursement_groups"."reversed_group_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "intermediated_disbursement_groups_tenant_loan_status_idx" ON "intermediated_disbursement_groups" USING btree ("tenant_id","loan_id","status");--> statement-breakpoint
CREATE INDEX "intermediated_disbursement_groups_tenant_intermediary_status_idx" ON "intermediated_disbursement_groups" USING btree ("tenant_id","intermediary_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "intermediated_transfer_events_tenant_idempotency_unique" ON "intermediated_transfer_events" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "intermediated_transfer_events_tenant_reference_unique" ON "intermediated_transfer_events" USING btree ("tenant_id","bank_reference_hash") WHERE "intermediated_transfer_events"."bank_reference_hash" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "intermediated_transfer_events_tenant_reversed_event_unique" ON "intermediated_transfer_events" USING btree ("tenant_id","reversed_event_id") WHERE "intermediated_transfer_events"."reversed_event_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "intermediated_transfer_events_tenant_group_role_idx" ON "intermediated_transfer_events" USING btree ("tenant_id","group_id","role");--> statement-breakpoint
CREATE UNIQUE INDEX "intermediated_transfer_evidence_tenant_id_id_unique" ON "intermediated_transfer_evidence" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "intermediated_transfer_evidence_event_file_unique" ON "intermediated_transfer_evidence" USING btree ("event_id","file_id");--> statement-breakpoint
CREATE UNIQUE INDEX "intermediated_transfer_evidence_tenant_file_unique" ON "intermediated_transfer_evidence" USING btree ("tenant_id","file_id");--> statement-breakpoint
CREATE UNIQUE INDEX "intermediated_transfer_evidence_intents_tenant_id_id_unique" ON "intermediated_transfer_evidence_intents" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "intermediated_transfer_evidence_intents_tenant_hash_unique" ON "intermediated_transfer_evidence_intents" USING btree ("tenant_id","evidence_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "intermediated_transfer_evidence_intents_tenant_file_unique" ON "intermediated_transfer_evidence_intents" USING btree ("tenant_id","file_id");--> statement-breakpoint
CREATE UNIQUE INDEX "loan_intermediary_assignments_tenant_id_id_unique" ON "loan_intermediary_assignments" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "loan_intermediary_assignments_tenant_idempotency_unique" ON "loan_intermediary_assignments" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "loan_intermediary_assignments_tenant_loan_effective_idx" ON "loan_intermediary_assignments" USING btree ("tenant_id","loan_id","effective_from");--> statement-breakpoint
CREATE INDEX "loan_intermediary_assignments_tenant_intermediary_status_idx" ON "loan_intermediary_assignments" USING btree ("tenant_id","intermediary_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "loan_settlement_previews_tenant_id_id_unique" ON "loan_settlement_previews" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "loan_settlement_previews_tenant_execute_idempotency_unique" ON "loan_settlement_previews" USING btree ("tenant_id","execute_idempotency_key") WHERE "loan_settlement_previews"."execute_idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "loan_settlement_previews_tenant_loan_created_idx" ON "loan_settlement_previews" USING btree ("tenant_id","loan_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "loans_tenant_activation_idempotency_unique" ON "loans" USING btree ("tenant_id","activation_idempotency_key") WHERE "loans"."activation_idempotency_key" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "loan_interest_accruals" ADD CONSTRAINT "loan_interest_accruals_period_unit_check" CHECK ("loan_interest_accruals"."period_unit" IS NULL OR "loan_interest_accruals"."period_unit" IN ('day', 'week'));--> statement-breakpoint
ALTER TABLE "loan_interest_accruals" ADD CONSTRAINT "loan_interest_accruals_period_length_check" CHECK ("loan_interest_accruals"."period_length" IS NULL OR "loan_interest_accruals"."period_length" = 1);--> statement-breakpoint
ALTER TABLE "loan_interest_accruals" ADD CONSTRAINT "loan_interest_accruals_period_date_order_check" CHECK ("loan_interest_accruals"."period_start_date" IS NULL OR "loan_interest_accruals"."period_end_date" IS NULL OR "loan_interest_accruals"."period_end_date" > "loan_interest_accruals"."period_start_date");--> statement-breakpoint
ALTER TABLE "loan_interest_accruals" ADD CONSTRAINT "loan_interest_accruals_period_day_index_check" CHECK (
        "loan_interest_accruals"."period_day_index" IS NULL OR (
            "loan_interest_accruals"."period_day_index" >= 1
            AND ("loan_interest_accruals"."period_unit" = 'day' AND "loan_interest_accruals"."period_day_index" <= 1
                OR "loan_interest_accruals"."period_unit" = 'week' AND "loan_interest_accruals"."period_day_index" <= 7)
        )
    );--> statement-breakpoint
ALTER TABLE "loan_interest_accruals" ADD CONSTRAINT "loan_interest_accruals_period_snapshot_completeness_check" CHECK (
        ("loan_interest_accruals"."period_start_date" IS NULL AND "loan_interest_accruals"."period_end_date" IS NULL AND "loan_interest_accruals"."period_day_index" IS NULL
            AND "loan_interest_accruals"."period_unit" IS NULL AND "loan_interest_accruals"."period_length" IS NULL
            AND "loan_interest_accruals"."contractual_interest_amount" IS NULL AND "loan_interest_accruals"."cumulative_interest_amount" IS NULL
            AND "loan_interest_accruals"."daily_increment_amount" IS NULL)
        OR
        ("loan_interest_accruals"."period_start_date" IS NOT NULL AND "loan_interest_accruals"."period_end_date" IS NOT NULL AND "loan_interest_accruals"."period_day_index" IS NOT NULL
            AND "loan_interest_accruals"."period_unit" IS NOT NULL AND "loan_interest_accruals"."period_length" IS NOT NULL
            AND "loan_interest_accruals"."contractual_interest_amount" IS NOT NULL AND "loan_interest_accruals"."cumulative_interest_amount" IS NOT NULL
            AND "loan_interest_accruals"."daily_increment_amount" IS NOT NULL)
    );--> statement-breakpoint
ALTER TABLE "loan_interest_accruals" ADD CONSTRAINT "loan_interest_accruals_period_snapshot_check" CHECK (
        ("loan_interest_accruals"."period_start_date" IS NULL AND "loan_interest_accruals"."period_end_date" IS NULL AND "loan_interest_accruals"."period_day_index" IS NULL
            AND "loan_interest_accruals"."period_days" IS NULL AND "loan_interest_accruals"."cumulative_interest_amount" IS NULL)
        OR
        ("loan_interest_accruals"."period_start_date" IS NOT NULL AND "loan_interest_accruals"."period_end_date" > "loan_interest_accruals"."period_start_date"
            AND "loan_interest_accruals"."period_day_index" BETWEEN 1 AND COALESCE(
                "loan_interest_accruals"."period_days",
                CASE "loan_interest_accruals"."period_unit" WHEN 'week' THEN 7 ELSE 1 END
            )
            AND ("loan_interest_accruals"."period_days" IS NULL
                OR ("loan_interest_accruals"."period_unit" = 'day' AND "loan_interest_accruals"."period_days" = 1)
                OR ("loan_interest_accruals"."period_unit" = 'week' AND "loan_interest_accruals"."period_days" = 7))
            AND "loan_interest_accruals"."cumulative_interest_amount" >= 0)
    );--> statement-breakpoint
ALTER TABLE "loan_interest_accruals" ADD CONSTRAINT "loan_interest_accruals_period_amounts_check" CHECK (
        ("loan_interest_accruals"."contractual_interest_amount" IS NULL OR "loan_interest_accruals"."contractual_interest_amount" >= 0)
        AND ("loan_interest_accruals"."cumulative_interest_amount" IS NULL OR "loan_interest_accruals"."cumulative_interest_amount" >= 0)
        AND ("loan_interest_accruals"."daily_increment_amount" IS NULL OR "loan_interest_accruals"."daily_increment_amount" >= 0)
    );--> statement-breakpoint
ALTER TABLE "loan_interest_rate_periods" ADD CONSTRAINT "loan_interest_rate_periods_period_unit_check" CHECK ("loan_interest_rate_periods"."period_unit" IN ('day', 'week'));--> statement-breakpoint
ALTER TABLE "loan_interest_rate_periods" ADD CONSTRAINT "loan_interest_rate_periods_period_length_check" CHECK ("loan_interest_rate_periods"."period_length" = 1);--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loans_interest_period_unit_check" CHECK ("loans"."interest_period_unit" IS NULL OR "loans"."interest_period_unit" IN ('day', 'week'));--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loans_interest_period_length_check" CHECK ("loans"."interest_period_length" IS NULL OR "loans"."interest_period_length" = 1);--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loans_advance_interest_periods_check" CHECK ("loans"."advance_interest_periods" IS NULL OR "loans"."advance_interest_periods" IN (0, 1));--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loans_advance_interest_refund_policy_check" CHECK ("loans"."advance_interest_refund_policy" IS NULL OR "loans"."advance_interest_refund_policy" = 'non_refundable');--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loans_interest_period_policy_completeness_check" CHECK (
        ("loans"."interest_period_unit" IS NULL AND "loans"."interest_period_length" IS NULL
            AND "loans"."advance_interest_periods" IS NULL AND "loans"."advance_interest_refund_policy" IS NULL
            AND "loans"."interest_period_anchor_date" IS NULL)
        OR
        ("loans"."interest_period_unit" IS NOT NULL AND "loans"."interest_period_length" IS NOT NULL
            AND "loans"."advance_interest_periods" IS NOT NULL AND "loans"."advance_interest_refund_policy" IS NOT NULL
            AND "loans"."interest_period_anchor_date" IS NOT NULL)
    );--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loans_activation_command_completeness_check" CHECK (
        ("loans"."activation_idempotency_key" IS NULL AND "loans"."activation_result" IS NULL)
        OR ("loans"."activation_idempotency_key" IS NOT NULL AND "loans"."activation_result" IS NOT NULL)
    );--> statement-breakpoint

CREATE EXTENSION IF NOT EXISTS btree_gist;--> statement-breakpoint
ALTER TABLE "loan_intermediary_assignments"
ADD CONSTRAINT "loan_intermediary_assignments_disbursement_no_overlap"
EXCLUDE USING gist (
    "tenant_id" WITH =,
    "loan_id" WITH =,
    tstzrange("effective_from", "effective_to", '[)') WITH &&
)
WHERE ("role" IN ('disbursement', 'both'));--> statement-breakpoint
ALTER TABLE "loan_intermediary_assignments"
ADD CONSTRAINT "loan_intermediary_assignments_collection_no_overlap"
EXCLUDE USING gist (
    "tenant_id" WITH =,
    "loan_id" WITH =,
    tstzrange("effective_from", "effective_to", '[)') WITH &&
)
WHERE ("role" IN ('collection', 'both'));--> statement-breakpoint

CREATE FUNCTION reject_immutable_intermediated_disbursement_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD."status" IN ('posted', 'reversed') THEN
        RAISE EXCEPTION '% non-draft financial records are immutable; % is not allowed', TG_TABLE_NAME, TG_OP;
    END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;--> statement-breakpoint
CREATE TRIGGER intermediated_disbursement_groups_posted_immutable
BEFORE UPDATE OR DELETE ON "intermediated_disbursement_groups"
FOR EACH ROW EXECUTE FUNCTION reject_immutable_intermediated_disbursement_mutation();--> statement-breakpoint
CREATE TRIGGER intermediated_transfer_events_posted_immutable
BEFORE UPDATE OR DELETE ON "intermediated_transfer_events"
FOR EACH ROW EXECUTE FUNCTION reject_immutable_intermediated_disbursement_mutation();--> statement-breakpoint

CREATE FUNCTION reject_immutable_intermediated_evidence_link_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'finalized intermediated transfer evidence links are immutable; % is not allowed', TG_OP;
END;
$$;--> statement-breakpoint
CREATE TRIGGER intermediated_transfer_evidence_immutable
BEFORE UPDATE OR DELETE ON "intermediated_transfer_evidence"
FOR EACH ROW EXECUTE FUNCTION reject_immutable_intermediated_evidence_link_mutation();--> statement-breakpoint

CREATE FUNCTION reject_ready_intermediated_evidence_intent_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD."status" = 'ready' THEN
        RAISE EXCEPTION 'finalized intermediated transfer evidence intents are immutable; % is not allowed', TG_OP;
    END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;--> statement-breakpoint
CREATE TRIGGER intermediated_transfer_evidence_intents_ready_immutable
BEFORE UPDATE OR DELETE ON "intermediated_transfer_evidence_intents"
FOR EACH ROW EXECUTE FUNCTION reject_ready_intermediated_evidence_intent_mutation();--> statement-breakpoint

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
