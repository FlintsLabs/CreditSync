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
ALTER TABLE "loan_interest_accruals" ADD COLUMN "period_start_date" date;--> statement-breakpoint
ALTER TABLE "loan_interest_accruals" ADD COLUMN "period_end_date" date;--> statement-breakpoint
ALTER TABLE "loan_interest_accruals" ADD COLUMN "period_day_index" integer;--> statement-breakpoint
ALTER TABLE "loan_interest_accruals" ADD COLUMN "period_unit" text;--> statement-breakpoint
ALTER TABLE "loan_interest_accruals" ADD COLUMN "period_length" integer;--> statement-breakpoint
ALTER TABLE "loan_interest_accruals" ADD COLUMN "contractual_interest_amount" numeric;--> statement-breakpoint
ALTER TABLE "loan_interest_accruals" ADD COLUMN "cumulative_interest_amount" numeric;--> statement-breakpoint
ALTER TABLE "loan_interest_accruals" ADD COLUMN "daily_increment_amount" numeric;--> statement-breakpoint
ALTER TABLE "loan_interest_rate_periods" ADD COLUMN "period_unit" text DEFAULT 'day' NOT NULL;--> statement-breakpoint
ALTER TABLE "loan_interest_rate_periods" ADD COLUMN "period_length" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN "interest_period_unit" text;--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN "interest_period_length" integer;--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN "advance_interest_periods" integer;--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN "advance_interest_refund_policy" text;--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN "interest_period_anchor_date" date;--> statement-breakpoint
UPDATE "loans"
SET "interest_period_unit" = 'day',
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
-- Existing accruals were daily snapshots. These values are derivable from their
-- authoritative rows, so populate only additive metadata and never rewrite amounts.
UPDATE "loan_interest_accruals"
SET "period_start_date" = "accrual_date",
    "period_end_date" = "accrual_date" + 1,
    "period_day_index" = 1,
    "period_unit" = 'day',
    "period_length" = 1,
    "contractual_interest_amount" = "interest_amount",
    "cumulative_interest_amount" = "interest_amount",
    "daily_increment_amount" = "interest_amount";--> statement-breakpoint
ALTER TABLE "loan_settlement_previews" ADD CONSTRAINT "loan_settlement_previews_tenant_loan_fk" FOREIGN KEY ("tenant_id","loan_id") REFERENCES "public"."loans"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_settlement_previews" ADD CONSTRAINT "loan_settlement_previews_tenant_created_by_fk" FOREIGN KEY ("tenant_id","created_by_user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_settlement_previews" ADD CONSTRAINT "loan_settlement_previews_tenant_executed_by_fk" FOREIGN KEY ("tenant_id","executed_by_user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "loan_settlement_previews_tenant_id_id_unique" ON "loan_settlement_previews" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "loan_settlement_previews_tenant_execute_idempotency_unique" ON "loan_settlement_previews" USING btree ("tenant_id","execute_idempotency_key") WHERE "loan_settlement_previews"."execute_idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "loan_settlement_previews_tenant_loan_created_idx" ON "loan_settlement_previews" USING btree ("tenant_id","loan_id","created_at");--> statement-breakpoint
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
ALTER TABLE "loans" ADD COLUMN "activation_idempotency_key" text;--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN "activation_result" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "loans_tenant_activation_idempotency_unique" ON "loans" USING btree ("tenant_id","activation_idempotency_key") WHERE "loans"."activation_idempotency_key" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loans_activation_command_completeness_check" CHECK (
        ("loans"."activation_idempotency_key" IS NULL AND "loans"."activation_result" IS NULL)
        OR ("loans"."activation_idempotency_key" IS NOT NULL AND "loans"."activation_result" IS NOT NULL)
    );
