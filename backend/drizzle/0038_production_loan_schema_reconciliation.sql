DO $$
DECLARE
    target record;
    actual_type text;
    expected_type text;
    actual_definition text;
    expected_definition text;
    actual_predicate text;
    actual_access_method text;
    actual_keys text[];
    actual_is_unique boolean;
    actual_key_count integer;
BEGIN
    CREATE TEMP TABLE _0038_expected_loans (
        term_months integer,
        bank_loan_id integer,
        funding_bank_profile_id integer,
        repayment_type text,
        start_date date,
        interest_period_unit text,
        interest_period_length integer,
        advance_interest_periods integer,
        advance_interest_refund_policy text,
        interest_period_anchor_date date,
        single_payment_due_date date,
        single_payment_fixed_agreed_interest numeric,
        single_payment_interest_policy text,
        single_payment_retroactive_rate_type text,
        single_payment_retroactive_rate numeric,
        single_payment_late_penalty_mode text,
        single_payment_late_penalty_amount_per_day numeric,
        single_payment_late_penalty_grace_days integer,
        floating_accrual_cycle text,
        activation_idempotency_key text,
        activation_result jsonb
    ) ON COMMIT DROP;

    ALTER TABLE _0038_expected_loans
        ADD CONSTRAINT _0038_term_months_check CHECK (term_months IS NULL OR term_months > 0),
        ADD CONSTRAINT _0038_one_funding_source_check CHECK (bank_loan_id IS NULL OR funding_bank_profile_id IS NULL),
        ADD CONSTRAINT _0038_single_payment_terms_check CHECK ((repayment_type <> 'single_payment' AND single_payment_due_date IS NULL AND single_payment_fixed_agreed_interest IS NULL AND single_payment_interest_policy IS NULL AND single_payment_retroactive_rate_type IS NULL AND single_payment_retroactive_rate IS NULL AND single_payment_late_penalty_mode IS NULL AND single_payment_late_penalty_amount_per_day IS NULL AND single_payment_late_penalty_grace_days IS NULL) OR (repayment_type = 'single_payment' AND start_date IS NOT NULL AND single_payment_due_date > start_date AND single_payment_fixed_agreed_interest IS NOT NULL AND ((single_payment_interest_policy = 'fixed_only' AND single_payment_retroactive_rate_type IS NULL AND single_payment_retroactive_rate IS NULL) OR (single_payment_interest_policy = 'greater_of_fixed_or_retroactive' AND single_payment_retroactive_rate_type IN ('percent_per_day', 'per_thousand_per_day') AND single_payment_retroactive_rate IS NOT NULL)) AND ((single_payment_late_penalty_mode = 'none' AND single_payment_late_penalty_amount_per_day IS NULL AND single_payment_late_penalty_grace_days IS NULL) OR (single_payment_late_penalty_mode = 'fixed_amount_per_day' AND single_payment_late_penalty_amount_per_day IS NOT NULL AND single_payment_late_penalty_grace_days >= 0)))),
        ADD CONSTRAINT _0038_floating_accrual_cycle_check CHECK ((repayment_type = 'floating' AND floating_accrual_cycle IN ('daily', 'weekly')) OR (repayment_type <> 'floating' AND floating_accrual_cycle IS NULL)),
        ADD CONSTRAINT _0038_single_payment_money_check CHECK ((single_payment_fixed_agreed_interest IS NULL OR (single_payment_fixed_agreed_interest >= 0 AND scale(single_payment_fixed_agreed_interest) <= 2)) AND (single_payment_retroactive_rate IS NULL OR (single_payment_retroactive_rate >= 0 AND scale(single_payment_retroactive_rate) <= 4)) AND (single_payment_late_penalty_amount_per_day IS NULL OR (single_payment_late_penalty_amount_per_day >= 0 AND scale(single_payment_late_penalty_amount_per_day) <= 2))),
        ADD CONSTRAINT _0038_interest_period_unit_check CHECK (interest_period_unit IS NULL OR interest_period_unit IN ('day', 'week')),
        ADD CONSTRAINT _0038_interest_period_length_check CHECK (interest_period_length IS NULL OR interest_period_length = 1),
        ADD CONSTRAINT _0038_advance_interest_periods_check CHECK (advance_interest_periods IS NULL OR advance_interest_periods IN (0, 1)),
        ADD CONSTRAINT _0038_advance_interest_refund_policy_check CHECK (advance_interest_refund_policy IS NULL OR advance_interest_refund_policy = 'non_refundable'),
        ADD CONSTRAINT _0038_interest_period_policy_completeness_check CHECK ((interest_period_unit IS NULL AND interest_period_length IS NULL AND advance_interest_periods IS NULL AND advance_interest_refund_policy IS NULL AND interest_period_anchor_date IS NULL) OR (interest_period_unit IS NOT NULL AND interest_period_length IS NOT NULL AND advance_interest_periods IS NOT NULL AND advance_interest_refund_policy IS NOT NULL AND interest_period_anchor_date IS NOT NULL)),
        ADD CONSTRAINT _0038_activation_command_completeness_check CHECK ((activation_idempotency_key IS NULL AND activation_result IS NULL) OR (activation_idempotency_key IS NOT NULL AND activation_result IS NOT NULL));

    FOR target IN
        SELECT * FROM (VALUES
            ('interest_period_unit', 'text'), ('interest_period_length', 'integer'),
            ('advance_interest_periods', 'integer'), ('advance_interest_refund_policy', 'text'),
            ('interest_period_anchor_date', 'date'), ('single_payment_due_date', 'date'),
            ('single_payment_fixed_agreed_interest', 'numeric'), ('single_payment_interest_policy', 'text'),
            ('single_payment_retroactive_rate_type', 'text'), ('single_payment_retroactive_rate', 'numeric'),
            ('single_payment_late_penalty_mode', 'text'), ('single_payment_late_penalty_amount_per_day', 'numeric'),
            ('single_payment_late_penalty_grace_days', 'integer'), ('floating_accrual_cycle', 'text'),
            ('activation_idempotency_key', 'text'), ('activation_result', 'jsonb')
        ) AS columns(name, type)
    LOOP
        SELECT format_type(a.atttypid, a.atttypmod)
        INTO actual_type
        FROM pg_attribute a
        WHERE a.attrelid = 'public.loans'::regclass AND a.attname = target.name AND NOT a.attisdropped;
        expected_type := target.type;
        IF actual_type IS NOT NULL AND (actual_type <> expected_type OR EXISTS (
            SELECT 1 FROM pg_attribute a
            WHERE a.attrelid = 'public.loans'::regclass AND a.attname = target.name
              AND NOT a.attisdropped AND a.attnotnull
        )) THEN
            RAISE EXCEPTION '0038 incompatible loans.% column contract: expected %, nullable, found %, %', target.name, expected_type, actual_type,
                CASE WHEN EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = 'public.loans'::regclass AND a.attname = target.name AND NOT a.attisdropped AND a.attnotnull) THEN 'not null' ELSE 'nullable' END;
        END IF;
    END LOOP;

    FOR target IN
        SELECT * FROM (VALUES
            ('loans_term_months_check', '_0038_term_months_check'), ('loans_one_funding_source_check', '_0038_one_funding_source_check'),
            ('loans_single_payment_terms_check', '_0038_single_payment_terms_check'), ('loans_floating_accrual_cycle_check', '_0038_floating_accrual_cycle_check'),
            ('loans_single_payment_money_check', '_0038_single_payment_money_check'), ('loans_interest_period_unit_check', '_0038_interest_period_unit_check'),
            ('loans_interest_period_length_check', '_0038_interest_period_length_check'), ('loans_advance_interest_periods_check', '_0038_advance_interest_periods_check'),
            ('loans_advance_interest_refund_policy_check', '_0038_advance_interest_refund_policy_check'), ('loans_interest_period_policy_completeness_check', '_0038_interest_period_policy_completeness_check'),
            ('loans_activation_command_completeness_check', '_0038_activation_command_completeness_check')
        ) AS constraints(name, expected_name)
    LOOP
        SELECT pg_get_constraintdef(c.oid) INTO actual_definition
        FROM pg_constraint c
        WHERE c.conrelid = 'public.loans'::regclass AND c.conname = target.name;
        SELECT pg_get_constraintdef(c.oid) INTO expected_definition
        FROM pg_constraint c
        WHERE c.conrelid = '_0038_expected_loans'::regclass AND c.conname = target.expected_name;
        IF actual_definition IS NOT NULL AND regexp_replace(replace(actual_definition, '"', ''), '\s+', ' ', 'g') <> regexp_replace(replace(expected_definition, '"', ''), '\s+', ' ', 'g') THEN
            RAISE EXCEPTION '0038 incompatible constraint %: expected %, found %', target.name, expected_definition, actual_definition;
        END IF;
    END LOOP;

    SELECT i.indisunique, i.indnkeyatts, am.amname, pg_get_expr(i.indpred, i.indrelid, true),
        (SELECT array_agg(a.attname ORDER BY k.ord)
         FROM unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum)
    INTO actual_is_unique, actual_key_count, actual_access_method, actual_predicate, actual_keys
    FROM pg_index i
    JOIN pg_class idx ON idx.oid = i.indexrelid
    JOIN pg_am am ON am.oid = idx.relam
    WHERE i.indrelid = 'public.loans'::regclass AND idx.relname = 'loans_tenant_activation_idempotency_unique'
    LIMIT 1;
    IF actual_is_unique IS NOT NULL AND (NOT actual_is_unique OR actual_key_count <> 2 OR actual_access_method <> 'btree' OR actual_keys <> ARRAY['tenant_id', 'activation_idempotency_key'] OR actual_predicate <> 'activation_idempotency_key IS NOT NULL') THEN
        RAISE EXCEPTION '0038 incompatible index loans_tenant_activation_idempotency_unique: expected unique btree (tenant_id, activation_idempotency_key) WHERE (activation_idempotency_key IS NOT NULL), found % % % % WHERE %', actual_is_unique, actual_key_count, actual_access_method, actual_keys, actual_predicate;
    END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN IF NOT EXISTS "interest_period_unit" text;
--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN IF NOT EXISTS "interest_period_length" integer;
--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN IF NOT EXISTS "advance_interest_periods" integer;
--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN IF NOT EXISTS "advance_interest_refund_policy" text;
--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN IF NOT EXISTS "interest_period_anchor_date" date;
--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN IF NOT EXISTS "single_payment_due_date" date;
--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN IF NOT EXISTS "single_payment_fixed_agreed_interest" numeric;
--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN IF NOT EXISTS "single_payment_interest_policy" text;
--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN IF NOT EXISTS "single_payment_retroactive_rate_type" text;
--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN IF NOT EXISTS "single_payment_retroactive_rate" numeric;
--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN IF NOT EXISTS "single_payment_late_penalty_mode" text;
--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN IF NOT EXISTS "single_payment_late_penalty_amount_per_day" numeric;
--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN IF NOT EXISTS "single_payment_late_penalty_grace_days" integer;
--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN IF NOT EXISTS "floating_accrual_cycle" text;
--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN IF NOT EXISTS "activation_idempotency_key" text;
--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN IF NOT EXISTS "activation_result" jsonb;
--> statement-breakpoint
DO $$
DECLARE
    target record;
    violation_count bigint;
BEGIN
    FOR target IN
        SELECT * FROM (VALUES
            ('loans_term_months_check', 'term_months IS NULL OR term_months > 0'),
            ('loans_one_funding_source_check', 'bank_loan_id IS NULL OR funding_bank_profile_id IS NULL'),
            ('loans_single_payment_terms_check', '(repayment_type <> ''single_payment'' AND single_payment_due_date IS NULL AND single_payment_fixed_agreed_interest IS NULL AND single_payment_interest_policy IS NULL AND single_payment_retroactive_rate_type IS NULL AND single_payment_retroactive_rate IS NULL AND single_payment_late_penalty_mode IS NULL AND single_payment_late_penalty_amount_per_day IS NULL AND single_payment_late_penalty_grace_days IS NULL) OR (repayment_type = ''single_payment'' AND start_date IS NOT NULL AND single_payment_due_date > start_date AND single_payment_fixed_agreed_interest IS NOT NULL AND ((single_payment_interest_policy = ''fixed_only'' AND single_payment_retroactive_rate_type IS NULL AND single_payment_retroactive_rate IS NULL) OR (single_payment_interest_policy = ''greater_of_fixed_or_retroactive'' AND single_payment_retroactive_rate_type IN (''percent_per_day'', ''per_thousand_per_day'') AND single_payment_retroactive_rate IS NOT NULL)) AND ((single_payment_late_penalty_mode = ''none'' AND single_payment_late_penalty_amount_per_day IS NULL AND single_payment_late_penalty_grace_days IS NULL) OR (single_payment_late_penalty_mode = ''fixed_amount_per_day'' AND single_payment_late_penalty_amount_per_day IS NOT NULL AND single_payment_late_penalty_grace_days >= 0)))'),
            ('loans_floating_accrual_cycle_check', '(repayment_type = ''floating'' AND floating_accrual_cycle IN (''daily'', ''weekly'')) OR (repayment_type <> ''floating'' AND floating_accrual_cycle IS NULL)'),
            ('loans_single_payment_money_check', '(single_payment_fixed_agreed_interest IS NULL OR (single_payment_fixed_agreed_interest >= 0 AND scale(single_payment_fixed_agreed_interest) <= 2)) AND (single_payment_retroactive_rate IS NULL OR (single_payment_retroactive_rate >= 0 AND scale(single_payment_retroactive_rate) <= 4)) AND (single_payment_late_penalty_amount_per_day IS NULL OR (single_payment_late_penalty_amount_per_day >= 0 AND scale(single_payment_late_penalty_amount_per_day) <= 2))'),
            ('loans_interest_period_unit_check', 'interest_period_unit IS NULL OR interest_period_unit IN (''day'', ''week'')'),
            ('loans_interest_period_length_check', 'interest_period_length IS NULL OR interest_period_length = 1'),
            ('loans_advance_interest_periods_check', 'advance_interest_periods IS NULL OR advance_interest_periods IN (0, 1)'),
            ('loans_advance_interest_refund_policy_check', 'advance_interest_refund_policy IS NULL OR advance_interest_refund_policy = ''non_refundable'''),
            ('loans_interest_period_policy_completeness_check', '(interest_period_unit IS NULL AND interest_period_length IS NULL AND advance_interest_periods IS NULL AND advance_interest_refund_policy IS NULL AND interest_period_anchor_date IS NULL) OR (interest_period_unit IS NOT NULL AND interest_period_length IS NOT NULL AND advance_interest_periods IS NOT NULL AND advance_interest_refund_policy IS NOT NULL AND interest_period_anchor_date IS NOT NULL)'),
            ('loans_activation_command_completeness_check', '(activation_idempotency_key IS NULL AND activation_result IS NULL) OR (activation_idempotency_key IS NOT NULL AND activation_result IS NOT NULL)')
        ) AS constraints(name, expression)
    LOOP
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.loans'::regclass AND conname = target.name) THEN
            EXECUTE format('ALTER TABLE public.loans ADD CONSTRAINT %I CHECK (%s) NOT VALID', target.name, target.expression);
        END IF;
        EXECUTE format('SELECT count(*) FROM public.loans WHERE NOT (%s)', target.expression) INTO violation_count;
        IF violation_count <> 0 THEN
            RAISE EXCEPTION '0038 zero-violation gate failed for %: % rows', target.name, violation_count;
        END IF;
        EXECUTE format('ALTER TABLE public.loans VALIDATE CONSTRAINT %I', target.name);
    END LOOP;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "loans_tenant_activation_idempotency_unique"
ON "loans" ("tenant_id", "activation_idempotency_key")
WHERE "activation_idempotency_key" IS NOT NULL;
