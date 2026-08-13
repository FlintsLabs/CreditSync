ALTER TABLE "loans" ADD COLUMN "single_payment_due_date" date;--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN "single_payment_fixed_agreed_interest" numeric;--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN "single_payment_interest_policy" text;--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN "single_payment_retroactive_rate_type" text;--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN "single_payment_retroactive_rate" numeric;--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN "floating_accrual_cycle" text;--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN "single_payment_late_penalty_mode" text;--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN "single_payment_late_penalty_amount_per_day" numeric;--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN "single_payment_late_penalty_grace_days" integer;--> statement-breakpoint

-- Preserve existing floating behavior explicitly. No historical loan is inferred
-- to be single-payment from schedule shape or any other legacy column.
UPDATE "loans"
SET "floating_accrual_cycle" = 'daily'
WHERE "repayment_type" = 'floating';--> statement-breakpoint

ALTER TABLE "loans" ADD CONSTRAINT "loans_single_payment_terms_check" CHECK (
    ("repayment_type" <> 'single_payment' AND
        "single_payment_due_date" IS NULL AND
        "single_payment_fixed_agreed_interest" IS NULL AND
        "single_payment_interest_policy" IS NULL AND
        "single_payment_retroactive_rate_type" IS NULL AND
        "single_payment_retroactive_rate" IS NULL AND
        "single_payment_late_penalty_mode" IS NULL AND
        "single_payment_late_penalty_amount_per_day" IS NULL AND
        "single_payment_late_penalty_grace_days" IS NULL)
    OR
    ("repayment_type" = 'single_payment' AND
        "start_date" IS NOT NULL AND
        "single_payment_due_date" > "start_date" AND
        "single_payment_fixed_agreed_interest" IS NOT NULL AND
        (("single_payment_interest_policy" = 'fixed_only' AND
            "single_payment_retroactive_rate_type" IS NULL AND
            "single_payment_retroactive_rate" IS NULL)
         OR
         ("single_payment_interest_policy" = 'greater_of_fixed_or_retroactive' AND
            "single_payment_retroactive_rate_type" IN ('percent_per_day', 'per_thousand_per_day') AND
            "single_payment_retroactive_rate" IS NOT NULL)) AND
        (("single_payment_late_penalty_mode" = 'none' AND
            "single_payment_late_penalty_amount_per_day" IS NULL AND
            "single_payment_late_penalty_grace_days" IS NULL)
         OR
         ("single_payment_late_penalty_mode" = 'fixed_amount_per_day' AND
            "single_payment_late_penalty_amount_per_day" IS NOT NULL AND
            "single_payment_late_penalty_grace_days" >= 0)))
);--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loans_floating_accrual_cycle_check" CHECK (
    ("repayment_type" = 'floating' AND "floating_accrual_cycle" IN ('daily', 'weekly'))
    OR ("repayment_type" <> 'floating' AND "floating_accrual_cycle" IS NULL)
);--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loans_single_payment_money_check" CHECK (
    ("single_payment_fixed_agreed_interest" IS NULL OR
        ("single_payment_fixed_agreed_interest" >= 0 AND scale("single_payment_fixed_agreed_interest") <= 2)) AND
    ("single_payment_retroactive_rate" IS NULL OR
        ("single_payment_retroactive_rate" >= 0 AND scale("single_payment_retroactive_rate") <= 4)) AND
    ("single_payment_late_penalty_amount_per_day" IS NULL OR
        ("single_payment_late_penalty_amount_per_day" >= 0 AND scale("single_payment_late_penalty_amount_per_day") <= 2))
);--> statement-breakpoint

CREATE TABLE "loan_restructures" (
    "id" serial PRIMARY KEY NOT NULL,
    "public_id" uuid DEFAULT uuidv7() NOT NULL UNIQUE,
    "tenant_id" text NOT NULL,
    "old_loan_id" integer NOT NULL,
    "new_loan_id" integer,
    "settlement_date" date NOT NULL,
    "old_balance_version" text NOT NULL,
    "status" text DEFAULT 'preview' NOT NULL,
    "preview_hash" text NOT NULL,
    "request_hash" text NOT NULL,
    "requested_replacement_terms" jsonb NOT NULL,
    "gross_principal" numeric NOT NULL,
    "gross_interest" numeric NOT NULL,
    "gross_fees" numeric NOT NULL,
    "gross_penalty" numeric NOT NULL,
    "waived_interest" numeric DEFAULT 0 NOT NULL,
    "waived_fees" numeric DEFAULT 0 NOT NULL,
    "waived_penalty" numeric DEFAULT 0 NOT NULL,
    "net_principal" numeric NOT NULL,
    "net_interest" numeric NOT NULL,
    "net_fees" numeric NOT NULL,
    "net_penalty" numeric NOT NULL,
    "external_settlement_credits" numeric DEFAULT 0 NOT NULL,
    "additional_principal" numeric DEFAULT 0 NOT NULL,
    "cash_direction" text NOT NULL,
    "cash_amount" numeric DEFAULT 0 NOT NULL,
    "reason" text NOT NULL,
    "actor_source" text NOT NULL,
    "request_id" text,
    "correlation_id" text NOT NULL,
    "execute_idempotency_key" text,
    "execute_request_hash" text,
    "reversal_idempotency_key" text,
    "reversal_request_hash" text,
    "executed_audit_public_id" uuid,
    "reversed_audit_public_id" uuid,
    "pre_execution_old_loan_state" jsonb,
    "expires_at" timestamp with time zone NOT NULL,
    "executed_at" timestamp with time zone,
    "reversed_at" timestamp with time zone,
    "created_by_user_id" integer,
    "updated_by_user_id" integer,
    "executed_by_user_id" integer,
    "reversed_by_user_id" integer,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "loan_restructures_status_check" CHECK ("status" IN ('preview', 'executed', 'reversed', 'expired')),
    CONSTRAINT "loan_restructures_cash_direction_check" CHECK (
        ("cash_direction" = 'none' AND "cash_amount" = 0)
        OR ("cash_direction" IN ('payout', 'collection') AND "cash_amount" > 0)
    ),
    CONSTRAINT "loan_restructures_actor_source_check" CHECK ("actor_source" IN ('web', 'mcp', 'system')),
    CONSTRAINT "loan_restructures_amounts_check" CHECK (
        "gross_principal" >= 0 AND "gross_interest" >= 0 AND "gross_fees" >= 0 AND "gross_penalty" >= 0 AND
        "waived_interest" >= 0 AND "waived_fees" >= 0 AND "waived_penalty" >= 0 AND
        "net_principal" >= 0 AND "net_interest" >= 0 AND "net_fees" >= 0 AND "net_penalty" >= 0 AND
        "external_settlement_credits" >= 0 AND "additional_principal" >= 0 AND "cash_amount" >= 0 AND
        "waived_interest" <= "gross_interest" AND "waived_fees" <= "gross_fees" AND "waived_penalty" <= "gross_penalty" AND
        "net_principal" = "gross_principal" AND
        "net_interest" = "gross_interest" - "waived_interest" AND
        "net_fees" = "gross_fees" - "waived_fees" AND
        "net_penalty" = "gross_penalty" - "waived_penalty"
    ),
    CONSTRAINT "loan_restructures_amount_scale_check" CHECK (
        scale("gross_principal") <= 2 AND scale("gross_interest") <= 2 AND
        scale("gross_fees") <= 2 AND scale("gross_penalty") <= 2 AND
        scale("waived_interest") <= 2 AND scale("waived_fees") <= 2 AND scale("waived_penalty") <= 2 AND
        scale("net_principal") <= 2 AND scale("net_interest") <= 2 AND
        scale("net_fees") <= 2 AND scale("net_penalty") <= 2 AND
        scale("external_settlement_credits") <= 2 AND scale("additional_principal") <= 2 AND scale("cash_amount") <= 2
    ),
    CONSTRAINT "loan_restructures_request_key_hash_check" CHECK (
        ("execute_idempotency_key" IS NULL) = ("execute_request_hash" IS NULL) AND
        ("reversal_idempotency_key" IS NULL) = ("reversal_request_hash" IS NULL)
    ),
    CONSTRAINT "loan_restructures_lifecycle_check" CHECK (
        ("status" NOT IN ('executed', 'reversed') OR (
            "new_loan_id" IS NOT NULL AND "old_loan_id" <> "new_loan_id" AND
            "execute_idempotency_key" IS NOT NULL AND "execute_request_hash" IS NOT NULL AND
            "executed_audit_public_id" IS NOT NULL AND "pre_execution_old_loan_state" IS NOT NULL AND
            "executed_at" IS NOT NULL AND "created_by_user_id" IS NOT NULL AND "executed_by_user_id" IS NOT NULL
        )) AND
        ("status" <> 'executed' OR (
            "reversal_idempotency_key" IS NULL AND "reversal_request_hash" IS NULL AND
            "reversed_audit_public_id" IS NULL AND "reversed_at" IS NULL AND "reversed_by_user_id" IS NULL
        )) AND
        ("status" <> 'reversed' OR (
            "reversal_idempotency_key" IS NOT NULL AND
            "reversal_request_hash" IS NOT NULL AND "reversed_audit_public_id" IS NOT NULL AND
            "reversed_at" IS NOT NULL AND "reversed_by_user_id" IS NOT NULL
        )) AND
        ("status" NOT IN ('preview', 'expired') OR (
            "new_loan_id" IS NULL AND "execute_idempotency_key" IS NULL AND "execute_request_hash" IS NULL AND
            "executed_audit_public_id" IS NULL AND "pre_execution_old_loan_state" IS NULL AND "executed_at" IS NULL AND
            "executed_by_user_id" IS NULL AND "reversal_idempotency_key" IS NULL AND "reversal_request_hash" IS NULL AND
            "reversed_audit_public_id" IS NULL AND "reversed_at" IS NULL AND "reversed_by_user_id" IS NULL
        ))
    )
);--> statement-breakpoint

ALTER TABLE "loan_restructures" ADD CONSTRAINT "loan_restructures_pre_execution_snapshot_check" CHECK (
    "status" NOT IN ('executed', 'reversed') OR (
        jsonb_typeof("pre_execution_old_loan_state") = 'object' AND
        "pre_execution_old_loan_state" ->> 'status' IS NOT NULL AND
        "pre_execution_old_loan_state" ->> 'outstandingPrincipal' IS NOT NULL AND
        "pre_execution_old_loan_state" ->> 'outstandingInterest' IS NOT NULL AND
        "pre_execution_old_loan_state" ->> 'outstandingFees' IS NOT NULL AND
        jsonb_path_exists("pre_execution_old_loan_state", '$.nextDueDate')
    )
);--> statement-breakpoint

CREATE TABLE "loan_opening_balance_components" (
    "id" serial PRIMARY KEY NOT NULL,
    "public_id" uuid DEFAULT uuidv7() NOT NULL UNIQUE,
    "tenant_id" text NOT NULL,
    "restructure_id" integer NOT NULL,
    "loan_id" integer NOT NULL,
    "component_kind" text NOT NULL,
    "amount" numeric NOT NULL,
    "source_type" text NOT NULL,
    "source_public_id" uuid NOT NULL,
    "status" text DEFAULT 'executed' NOT NULL,
    "created_by_user_id" integer,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "loan_opening_balance_components_kind_check" CHECK ("component_kind" IN ('carried_principal', 'carried_interest', 'carried_fee', 'carried_penalty', 'additional_principal', 'new_contract_interest')),
    CONSTRAINT "loan_opening_balance_components_status_check" CHECK ("status" IN ('executed', 'reversed')),
    CONSTRAINT "loan_opening_balance_components_amount_check" CHECK ("amount" >= 0 AND scale("amount") <= 2),
    CONSTRAINT "loan_opening_balance_components_source_type_check" CHECK ("source_type" IN ('loan', 'loan_restructure', 'loan_restructure_waiver'))
);--> statement-breakpoint

CREATE TABLE "loan_restructure_waivers" (
    "id" serial PRIMARY KEY NOT NULL,
    "public_id" uuid DEFAULT uuidv7() NOT NULL UNIQUE,
    "tenant_id" text NOT NULL,
    "restructure_id" integer NOT NULL,
    "loan_id" integer NOT NULL,
    "component_kind" text NOT NULL,
    "amount" numeric NOT NULL,
    "reason" text NOT NULL,
    "status" text NOT NULL,
    "reversed_waiver_id" integer,
    "actor_source" text NOT NULL,
    "request_id" text,
    "correlation_id" text NOT NULL,
    "execute_idempotency_key" text NOT NULL,
    "execute_request_hash" text NOT NULL,
    "reversal_idempotency_key" text,
    "reversal_request_hash" text,
    "audit_public_id" uuid,
    "created_by_user_id" integer,
    "reversed_by_user_id" integer,
    "executed_at" timestamp with time zone NOT NULL,
    "reversed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "loan_restructure_waivers_status_check" CHECK ("status" IN ('executed', 'reversed')),
    CONSTRAINT "loan_restructure_waivers_kind_check" CHECK ("component_kind" IN ('interest', 'fee', 'penalty')),
    CONSTRAINT "loan_restructure_waivers_amount_check" CHECK ("amount" > 0 AND scale("amount") <= 2),
    CONSTRAINT "loan_restructure_waivers_actor_source_check" CHECK ("actor_source" IN ('web', 'mcp', 'system')),
    CONSTRAINT "loan_restructure_waivers_reversal_check" CHECK (
        ("status" = 'executed' AND "audit_public_id" IS NOT NULL AND "created_by_user_id" IS NOT NULL AND
            "reversed_waiver_id" IS NULL AND "reversal_idempotency_key" IS NULL AND "reversal_request_hash" IS NULL AND
            "reversed_by_user_id" IS NULL AND "reversed_at" IS NULL)
        OR
        ("status" = 'reversed' AND "audit_public_id" IS NOT NULL AND "created_by_user_id" IS NOT NULL AND
            "reversed_waiver_id" IS NOT NULL AND "reversal_idempotency_key" IS NOT NULL AND "reversal_request_hash" IS NOT NULL AND
            "reversed_by_user_id" IS NOT NULL AND "reversed_at" IS NOT NULL)
    )
);--> statement-breakpoint

CREATE UNIQUE INDEX "audit_logs_tenant_public_id_unique" ON "audit_logs" ("tenant_id", "public_id");--> statement-breakpoint
CREATE UNIQUE INDEX "loan_restructures_tenant_id_id_unique" ON "loan_restructures" ("tenant_id", "id");--> statement-breakpoint
CREATE UNIQUE INDEX "loan_restructures_tenant_id_new_loan_unique" ON "loan_restructures" ("tenant_id", "id", "new_loan_id");--> statement-breakpoint
CREATE UNIQUE INDEX "loan_restructures_tenant_execute_key_unique" ON "loan_restructures" ("tenant_id", "execute_idempotency_key") WHERE "execute_idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "loan_restructures_tenant_reversal_key_unique" ON "loan_restructures" ("tenant_id", "reversal_idempotency_key") WHERE "reversal_idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "loan_restructures_tenant_old_loan_status_idx" ON "loan_restructures" ("tenant_id", "old_loan_id", "status");--> statement-breakpoint
CREATE UNIQUE INDEX "loan_opening_balance_components_tenant_id_id_unique" ON "loan_opening_balance_components" ("tenant_id", "id");--> statement-breakpoint
CREATE INDEX "loan_opening_balance_components_tenant_loan_idx" ON "loan_opening_balance_components" ("tenant_id", "loan_id");--> statement-breakpoint
CREATE UNIQUE INDEX "loan_restructure_waivers_tenant_id_id_unique" ON "loan_restructure_waivers" ("tenant_id", "id");--> statement-breakpoint
CREATE UNIQUE INDEX "loan_restructure_waivers_tenant_execute_key_unique" ON "loan_restructure_waivers" ("tenant_id", "execute_idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "loan_restructure_waivers_tenant_reversal_key_unique" ON "loan_restructure_waivers" ("tenant_id", "reversal_idempotency_key") WHERE "reversal_idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "loan_restructure_waivers_tenant_reversed_waiver_unique" ON "loan_restructure_waivers" ("tenant_id", "reversed_waiver_id") WHERE "reversed_waiver_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "loan_restructure_waivers_tenant_loan_idx" ON "loan_restructure_waivers" ("tenant_id", "loan_id");--> statement-breakpoint

ALTER TABLE "loan_restructures" ADD CONSTRAINT "loan_restructures_tenant_old_loan_fk" FOREIGN KEY ("tenant_id", "old_loan_id") REFERENCES "loans"("tenant_id", "id");--> statement-breakpoint
ALTER TABLE "loan_restructures" ADD CONSTRAINT "loan_restructures_tenant_new_loan_fk" FOREIGN KEY ("tenant_id", "new_loan_id") REFERENCES "loans"("tenant_id", "id");--> statement-breakpoint
ALTER TABLE "loan_restructures" ADD CONSTRAINT "loan_restructures_tenant_created_by_fk" FOREIGN KEY ("tenant_id", "created_by_user_id") REFERENCES "users"("tenant_id", "id");--> statement-breakpoint
ALTER TABLE "loan_restructures" ADD CONSTRAINT "loan_restructures_tenant_updated_by_fk" FOREIGN KEY ("tenant_id", "updated_by_user_id") REFERENCES "users"("tenant_id", "id");--> statement-breakpoint
ALTER TABLE "loan_restructures" ADD CONSTRAINT "loan_restructures_tenant_executed_by_fk" FOREIGN KEY ("tenant_id", "executed_by_user_id") REFERENCES "users"("tenant_id", "id");--> statement-breakpoint
ALTER TABLE "loan_restructures" ADD CONSTRAINT "loan_restructures_tenant_reversed_by_fk" FOREIGN KEY ("tenant_id", "reversed_by_user_id") REFERENCES "users"("tenant_id", "id");--> statement-breakpoint
ALTER TABLE "loan_restructures" ADD CONSTRAINT "loan_restructures_tenant_executed_audit_fk" FOREIGN KEY ("tenant_id", "executed_audit_public_id") REFERENCES "audit_logs"("tenant_id", "public_id");--> statement-breakpoint
ALTER TABLE "loan_restructures" ADD CONSTRAINT "loan_restructures_tenant_reversed_audit_fk" FOREIGN KEY ("tenant_id", "reversed_audit_public_id") REFERENCES "audit_logs"("tenant_id", "public_id");--> statement-breakpoint
ALTER TABLE "loan_opening_balance_components" ADD CONSTRAINT "loan_opening_balance_components_tenant_restructure_fk" FOREIGN KEY ("tenant_id", "restructure_id") REFERENCES "loan_restructures"("tenant_id", "id");--> statement-breakpoint
ALTER TABLE "loan_opening_balance_components" ADD CONSTRAINT "loan_opening_balance_components_tenant_replacement_fk" FOREIGN KEY ("tenant_id", "restructure_id", "loan_id") REFERENCES "loan_restructures"("tenant_id", "id", "new_loan_id");--> statement-breakpoint
ALTER TABLE "loan_opening_balance_components" ADD CONSTRAINT "loan_opening_balance_components_tenant_loan_fk" FOREIGN KEY ("tenant_id", "loan_id") REFERENCES "loans"("tenant_id", "id");--> statement-breakpoint
ALTER TABLE "loan_opening_balance_components" ADD CONSTRAINT "loan_opening_balance_components_tenant_created_by_fk" FOREIGN KEY ("tenant_id", "created_by_user_id") REFERENCES "users"("tenant_id", "id");--> statement-breakpoint
ALTER TABLE "loan_restructure_waivers" ADD CONSTRAINT "loan_restructure_waivers_tenant_restructure_fk" FOREIGN KEY ("tenant_id", "restructure_id") REFERENCES "loan_restructures"("tenant_id", "id");--> statement-breakpoint
ALTER TABLE "loan_restructure_waivers" ADD CONSTRAINT "loan_restructure_waivers_tenant_loan_fk" FOREIGN KEY ("tenant_id", "loan_id") REFERENCES "loans"("tenant_id", "id");--> statement-breakpoint
ALTER TABLE "loan_restructure_waivers" ADD CONSTRAINT "loan_restructure_waivers_tenant_reversed_waiver_fk" FOREIGN KEY ("tenant_id", "reversed_waiver_id") REFERENCES "loan_restructure_waivers"("tenant_id", "id");--> statement-breakpoint
ALTER TABLE "loan_restructure_waivers" ADD CONSTRAINT "loan_restructure_waivers_tenant_created_by_fk" FOREIGN KEY ("tenant_id", "created_by_user_id") REFERENCES "users"("tenant_id", "id");--> statement-breakpoint
ALTER TABLE "loan_restructure_waivers" ADD CONSTRAINT "loan_restructure_waivers_tenant_reversed_by_fk" FOREIGN KEY ("tenant_id", "reversed_by_user_id") REFERENCES "users"("tenant_id", "id");--> statement-breakpoint
ALTER TABLE "loan_restructure_waivers" ADD CONSTRAINT "loan_restructure_waivers_tenant_audit_fk" FOREIGN KEY ("tenant_id", "audit_public_id") REFERENCES "audit_logs"("tenant_id", "public_id");--> statement-breakpoint

CREATE FUNCTION reject_activated_loan_contract_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD."status" IS DISTINCT FROM 'draft' THEN
        IF TG_OP = 'DELETE' THEN
            RAISE EXCEPTION 'activated loans are immutable; DELETE is not allowed';
        END IF;
        IF ROW(
            OLD."borrower_id", OLD."bank_loan_id", OLD."funding_bank_profile_id",
            OLD."daily_interest_mode", OLD."daily_interest_rate", OLD."first_day_treatment", OLD."interest_start_date",
            OLD."daily_term_unit", OLD."daily_term_value", OLD."daily_entry_mode", OLD."daily_interest_input_mode",
            OLD."daily_interest_input_value", OLD."daily_flat_rate_percent",
            OLD."single_payment_due_date", OLD."single_payment_fixed_agreed_interest", OLD."single_payment_interest_policy",
            OLD."single_payment_retroactive_rate_type", OLD."single_payment_retroactive_rate", OLD."floating_accrual_cycle",
            OLD."single_payment_late_penalty_mode", OLD."single_payment_late_penalty_amount_per_day", OLD."single_payment_late_penalty_grace_days",
            OLD."principal_amount", OLD."interest_rate", OLD."repayment_type", OLD."term_months", OLD."installment_amount",
            OLD."total_installments", OLD."grace_period_days", OLD."late_fee_mode", OLD."late_fee_amount",
            OLD."start_date", OLD."cloned_from_loan_id"
        ) IS DISTINCT FROM ROW(
            NEW."borrower_id", NEW."bank_loan_id", NEW."funding_bank_profile_id",
            NEW."daily_interest_mode", NEW."daily_interest_rate", NEW."first_day_treatment", NEW."interest_start_date",
            NEW."daily_term_unit", NEW."daily_term_value", NEW."daily_entry_mode", NEW."daily_interest_input_mode",
            NEW."daily_interest_input_value", NEW."daily_flat_rate_percent",
            NEW."single_payment_due_date", NEW."single_payment_fixed_agreed_interest", NEW."single_payment_interest_policy",
            NEW."single_payment_retroactive_rate_type", NEW."single_payment_retroactive_rate", NEW."floating_accrual_cycle",
            NEW."single_payment_late_penalty_mode", NEW."single_payment_late_penalty_amount_per_day", NEW."single_payment_late_penalty_grace_days",
            NEW."principal_amount", NEW."interest_rate", NEW."repayment_type", NEW."term_months", NEW."installment_amount",
            NEW."total_installments", NEW."grace_period_days", NEW."late_fee_mode", NEW."late_fee_amount",
            NEW."start_date", NEW."cloned_from_loan_id"
        ) THEN
            RAISE EXCEPTION 'activated loan contractual terms are immutable';
        END IF;
    END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;--> statement-breakpoint
CREATE TRIGGER loans_activated_contract_immutable
BEFORE UPDATE OR DELETE ON "loans"
FOR EACH ROW EXECUTE FUNCTION reject_activated_loan_contract_mutation();--> statement-breakpoint

CREATE FUNCTION reject_activated_loan_schedule_contract_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    loan_status text;
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
            RAISE EXCEPTION 'activated loan schedule contractual fields are immutable';
        END IF;
    END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;--> statement-breakpoint
CREATE TRIGGER loan_schedules_activated_contract_immutable
BEFORE UPDATE OR DELETE ON "loan_schedules"
FOR EACH ROW EXECUTE FUNCTION reject_activated_loan_schedule_contract_mutation();--> statement-breakpoint

CREATE FUNCTION validate_loan_opening_balance_source() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW."source_type" = 'loan' AND NOT EXISTS (
        SELECT 1 FROM "loans" WHERE "tenant_id" = NEW."tenant_id" AND "public_id" = NEW."source_public_id"
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'loan opening balance source loan does not exist in tenant';
    ELSIF NEW."source_type" = 'loan_restructure' AND NOT EXISTS (
        SELECT 1 FROM "loan_restructures" WHERE "tenant_id" = NEW."tenant_id" AND "public_id" = NEW."source_public_id"
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'loan opening balance source restructure does not exist in tenant';
    ELSIF NEW."source_type" = 'loan_restructure_waiver' AND NOT EXISTS (
        SELECT 1 FROM "loan_restructure_waivers" WHERE "tenant_id" = NEW."tenant_id" AND "public_id" = NEW."source_public_id"
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'loan opening balance source waiver does not exist in tenant';
    END IF;
    RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER loan_opening_balance_components_source_valid
BEFORE INSERT ON "loan_opening_balance_components"
FOR EACH ROW EXECUTE FUNCTION validate_loan_opening_balance_source();--> statement-breakpoint

CREATE FUNCTION reject_immutable_loan_restructure_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD."status" = 'executed' AND TG_OP = 'UPDATE'
        AND NEW."status" = 'reversed'
        AND (to_jsonb(NEW) - ARRAY['status', 'reversal_idempotency_key', 'reversal_request_hash', 'reversed_audit_public_id', 'reversed_at', 'reversed_by_user_id', 'updated_by_user_id', 'updated_at'])
            = (to_jsonb(OLD) - ARRAY['status', 'reversal_idempotency_key', 'reversal_request_hash', 'reversed_audit_public_id', 'reversed_at', 'reversed_by_user_id', 'updated_by_user_id', 'updated_at']) THEN
        RETURN NEW;
    END IF;
    IF OLD."status" IN ('executed', 'reversed') THEN
        RAISE EXCEPTION 'executed and reversed loan restructures are immutable; % is not allowed', TG_OP;
    END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;--> statement-breakpoint
CREATE TRIGGER loan_restructures_immutable
BEFORE UPDATE OR DELETE ON "loan_restructures"
FOR EACH ROW EXECUTE FUNCTION reject_immutable_loan_restructure_mutation();--> statement-breakpoint

CREATE FUNCTION reject_loan_opening_balance_component_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'loan opening balance components are immutable; % is not allowed', TG_OP;
END;
$$;--> statement-breakpoint
CREATE TRIGGER loan_opening_balance_components_immutable
BEFORE UPDATE OR DELETE ON "loan_opening_balance_components"
FOR EACH ROW EXECUTE FUNCTION reject_loan_opening_balance_component_mutation();--> statement-breakpoint

CREATE FUNCTION reject_loan_restructure_waiver_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'executed and reversed loan restructure waivers are immutable; % is not allowed', TG_OP;
END;
$$;--> statement-breakpoint
CREATE TRIGGER loan_restructure_waivers_immutable
BEFORE UPDATE OR DELETE ON "loan_restructure_waivers"
FOR EACH ROW EXECUTE FUNCTION reject_loan_restructure_waiver_mutation();
