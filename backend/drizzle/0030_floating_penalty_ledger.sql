CREATE TABLE "floating_penalty_ledger_entries" (
	"id" serial PRIMARY KEY NOT NULL,
	"public_id" uuid DEFAULT uuidv7() NOT NULL,
	"tenant_id" text NOT NULL,
	"loan_id" integer NOT NULL,
	"due_date" date NOT NULL,
	"penalty_date" date NOT NULL,
	"entry_type" text NOT NULL,
	"amount" numeric NOT NULL,
	"opening_interest_basis" numeric NOT NULL,
	"late_fee_mode" text NOT NULL,
	"late_fee_value" numeric NOT NULL,
	"grace_period_days" integer NOT NULL,
	"adjusts_entry_id" integer,
	"source_transaction_id" integer,
	"reason" text,
	"idempotency_key" text NOT NULL,
	"audit_public_id" uuid NOT NULL,
	"actor_source" text NOT NULL,
	"request_id" text NOT NULL,
	"correlation_id" text NOT NULL,
	"created_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "floating_penalty_ledger_entries_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "floating_penalty_ledger_entry_type_check" CHECK ("floating_penalty_ledger_entries"."entry_type" IN ('fixed_assessment', 'daily_percent_accrual', 'legacy_cutover', 'legacy_snapshot', 'adjustment')),
	CONSTRAINT "floating_penalty_ledger_money_check" CHECK (
		scale("floating_penalty_ledger_entries"."amount") <= 2
		AND "floating_penalty_ledger_entries"."opening_interest_basis" >= 0
		AND scale("floating_penalty_ledger_entries"."opening_interest_basis") <= 2
		AND "floating_penalty_ledger_entries"."late_fee_value" >= 0
		AND "floating_penalty_ledger_entries"."grace_period_days" >= 0
	),
	CONSTRAINT "floating_penalty_ledger_adjustment_check" CHECK (
		("floating_penalty_ledger_entries"."entry_type" IN ('fixed_assessment', 'daily_percent_accrual')
			AND "floating_penalty_ledger_entries"."amount" > 0
			AND "floating_penalty_ledger_entries"."adjusts_entry_id" IS NULL
			AND "floating_penalty_ledger_entries"."reason" IS NULL)
		OR ("floating_penalty_ledger_entries"."entry_type" = 'legacy_snapshot'
			AND "floating_penalty_ledger_entries"."amount" >= 0
			AND "floating_penalty_ledger_entries"."adjusts_entry_id" IS NULL
			AND "floating_penalty_ledger_entries"."reason" IS NOT NULL
			AND length(trim("floating_penalty_ledger_entries"."reason")) > 0)
		OR ("floating_penalty_ledger_entries"."entry_type" = 'legacy_cutover'
			AND "floating_penalty_ledger_entries"."amount" = 0
			AND "floating_penalty_ledger_entries"."opening_interest_basis" = 0
			AND "floating_penalty_ledger_entries"."late_fee_mode" = 'none'
			AND "floating_penalty_ledger_entries"."late_fee_value" = 0
			AND "floating_penalty_ledger_entries"."grace_period_days" = 0
			AND "floating_penalty_ledger_entries"."adjusts_entry_id" IS NULL
			AND "floating_penalty_ledger_entries"."source_transaction_id" IS NULL
			AND "floating_penalty_ledger_entries"."reason" IS NOT NULL
			AND length(trim("floating_penalty_ledger_entries"."reason")) > 0)
		OR ("floating_penalty_ledger_entries"."entry_type" = 'adjustment'
			AND "floating_penalty_ledger_entries"."amount" <> 0
			AND "floating_penalty_ledger_entries"."adjusts_entry_id" IS NOT NULL
			AND "floating_penalty_ledger_entries"."reason" IS NOT NULL
			AND length(trim("floating_penalty_ledger_entries"."reason")) > 0)
	),
	CONSTRAINT "floating_penalty_ledger_actor_source_check" CHECK ("floating_penalty_ledger_entries"."actor_source" IN ('web', 'mcp', 'system'))
);
--> statement-breakpoint
CREATE TABLE "floating_transaction_allocations" (
	"id" serial PRIMARY KEY NOT NULL,
	"public_id" uuid DEFAULT uuidv7() NOT NULL,
	"tenant_id" text NOT NULL,
	"loan_id" integer NOT NULL,
	"transaction_id" integer NOT NULL,
	"due_date" date NOT NULL,
	"component" text NOT NULL,
	"interest_accrual_id" integer,
	"effective_date" date NOT NULL,
	"allocation_order" integer NOT NULL,
	"entry_type" text NOT NULL,
	"amount" numeric NOT NULL,
	"reversed_allocation_id" integer,
	"reason" text,
	"idempotency_key" text NOT NULL,
	"audit_public_id" uuid NOT NULL,
	"actor_source" text NOT NULL,
	"request_id" text NOT NULL,
	"correlation_id" text NOT NULL,
	"created_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "floating_transaction_allocations_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "floating_transaction_allocations_component_check" CHECK ("floating_transaction_allocations"."component" IN ('interest', 'penalty')),
	CONSTRAINT "floating_transaction_allocations_entry_type_check" CHECK (
		("floating_transaction_allocations"."entry_type" = 'payment'
			AND "floating_transaction_allocations"."amount" > 0
			AND "floating_transaction_allocations"."reversed_allocation_id" IS NULL
			AND "floating_transaction_allocations"."reason" IS NULL)
		OR ("floating_transaction_allocations"."entry_type" = 'reversal'
			AND "floating_transaction_allocations"."amount" < 0
			AND "floating_transaction_allocations"."reversed_allocation_id" IS NOT NULL
			AND "floating_transaction_allocations"."reason" IS NOT NULL
			AND length(trim("floating_transaction_allocations"."reason")) > 0)
	),
	CONSTRAINT "floating_transaction_allocations_money_order_check" CHECK (scale("floating_transaction_allocations"."amount") <= 2 AND "floating_transaction_allocations"."allocation_order" > 0),
	CONSTRAINT "floating_transaction_allocations_interest_target_check" CHECK (
		("floating_transaction_allocations"."component" = 'interest' AND "floating_transaction_allocations"."interest_accrual_id" IS NOT NULL)
		OR ("floating_transaction_allocations"."component" = 'penalty' AND "floating_transaction_allocations"."interest_accrual_id" IS NULL)
	),
	CONSTRAINT "floating_transaction_allocations_actor_source_check" CHECK ("floating_transaction_allocations"."actor_source" IN ('web', 'mcp', 'system'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "transactions_tenant_loan_id_unique" ON "transactions" USING btree ("tenant_id", "loan_id", "id");
--> statement-breakpoint
CREATE UNIQUE INDEX "loan_interest_accruals_tenant_loan_id_unique" ON "loan_interest_accruals" USING btree ("tenant_id", "loan_id", "id");
--> statement-breakpoint
CREATE UNIQUE INDEX "floating_penalty_ledger_tenant_id_id_unique" ON "floating_penalty_ledger_entries" USING btree ("tenant_id", "id");
--> statement-breakpoint
CREATE UNIQUE INDEX "floating_penalty_ledger_tenant_loan_id_unique" ON "floating_penalty_ledger_entries" USING btree ("tenant_id", "loan_id", "id");
--> statement-breakpoint
CREATE UNIQUE INDEX "floating_transaction_allocations_tenant_id_id_unique" ON "floating_transaction_allocations" USING btree ("tenant_id", "id");
--> statement-breakpoint
CREATE UNIQUE INDEX "floating_transaction_allocations_tenant_loan_id_unique" ON "floating_transaction_allocations" USING btree ("tenant_id", "loan_id", "id");
--> statement-breakpoint
ALTER TABLE "floating_penalty_ledger_entries" ADD CONSTRAINT "floating_penalty_ledger_tenant_loan_fk" FOREIGN KEY ("tenant_id", "loan_id") REFERENCES "public"."loans"("tenant_id", "id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "floating_penalty_ledger_entries" ADD CONSTRAINT "floating_penalty_ledger_tenant_loan_adjusts_entry_fk" FOREIGN KEY ("tenant_id", "loan_id", "adjusts_entry_id") REFERENCES "public"."floating_penalty_ledger_entries"("tenant_id", "loan_id", "id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "floating_penalty_ledger_entries" ADD CONSTRAINT "floating_penalty_ledger_tenant_loan_source_transaction_fk" FOREIGN KEY ("tenant_id", "loan_id", "source_transaction_id") REFERENCES "public"."transactions"("tenant_id", "loan_id", "id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "floating_penalty_ledger_entries" ADD CONSTRAINT "floating_penalty_ledger_tenant_audit_fk" FOREIGN KEY ("tenant_id", "audit_public_id") REFERENCES "public"."audit_logs"("tenant_id", "public_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "floating_penalty_ledger_entries" ADD CONSTRAINT "floating_penalty_ledger_tenant_actor_fk" FOREIGN KEY ("tenant_id", "created_by_user_id") REFERENCES "public"."users"("tenant_id", "id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "floating_transaction_allocations" ADD CONSTRAINT "floating_transaction_allocations_tenant_loan_fk" FOREIGN KEY ("tenant_id", "loan_id") REFERENCES "public"."loans"("tenant_id", "id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "floating_transaction_allocations" ADD CONSTRAINT "floating_transaction_allocations_tenant_loan_transaction_fk" FOREIGN KEY ("tenant_id", "loan_id", "transaction_id") REFERENCES "public"."transactions"("tenant_id", "loan_id", "id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "floating_transaction_allocations" ADD CONSTRAINT "floating_transaction_allocations_tenant_loan_interest_accrual_fk" FOREIGN KEY ("tenant_id", "loan_id", "interest_accrual_id") REFERENCES "public"."loan_interest_accruals"("tenant_id", "loan_id", "id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "floating_transaction_allocations" ADD CONSTRAINT "floating_transaction_allocations_tenant_loan_reversed_fk" FOREIGN KEY ("tenant_id", "loan_id", "reversed_allocation_id") REFERENCES "public"."floating_transaction_allocations"("tenant_id", "loan_id", "id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "floating_transaction_allocations" ADD CONSTRAINT "floating_transaction_allocations_tenant_audit_fk" FOREIGN KEY ("tenant_id", "audit_public_id") REFERENCES "public"."audit_logs"("tenant_id", "public_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "floating_transaction_allocations" ADD CONSTRAINT "floating_transaction_allocations_tenant_actor_fk" FOREIGN KEY ("tenant_id", "created_by_user_id") REFERENCES "public"."users"("tenant_id", "id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "floating_penalty_ledger_tenant_idempotency_unique" ON "floating_penalty_ledger_entries" USING btree ("tenant_id", "idempotency_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "floating_penalty_ledger_daily_assessment_unique" ON "floating_penalty_ledger_entries" USING btree ("tenant_id", "loan_id", "due_date", "penalty_date", "entry_type") WHERE "floating_penalty_ledger_entries"."entry_type" = 'daily_percent_accrual';
--> statement-breakpoint
CREATE UNIQUE INDEX "floating_penalty_ledger_fixed_assessment_unique" ON "floating_penalty_ledger_entries" USING btree ("tenant_id", "loan_id", "due_date") WHERE "floating_penalty_ledger_entries"."entry_type" = 'fixed_assessment';
--> statement-breakpoint
CREATE UNIQUE INDEX "floating_penalty_ledger_legacy_snapshot_unique" ON "floating_penalty_ledger_entries" USING btree ("tenant_id", "loan_id", "due_date") WHERE "floating_penalty_ledger_entries"."entry_type" = 'legacy_snapshot';
--> statement-breakpoint
CREATE UNIQUE INDEX "floating_penalty_ledger_legacy_cutover_unique" ON "floating_penalty_ledger_entries" USING btree ("tenant_id", "loan_id") WHERE "floating_penalty_ledger_entries"."entry_type" = 'legacy_cutover';
--> statement-breakpoint
CREATE INDEX "floating_penalty_ledger_tenant_loan_due_date_idx" ON "floating_penalty_ledger_entries" USING btree ("tenant_id", "loan_id", "due_date", "penalty_date");
--> statement-breakpoint
CREATE UNIQUE INDEX "floating_transaction_allocations_tenant_transaction_order_unique" ON "floating_transaction_allocations" USING btree ("tenant_id", "transaction_id", "allocation_order");
--> statement-breakpoint
CREATE UNIQUE INDEX "floating_transaction_allocations_tenant_idempotency_unique" ON "floating_transaction_allocations" USING btree ("tenant_id", "idempotency_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "floating_transaction_allocations_tenant_reversed_unique" ON "floating_transaction_allocations" USING btree ("tenant_id", "reversed_allocation_id") WHERE "floating_transaction_allocations"."reversed_allocation_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "floating_transaction_allocations_tenant_loan_due_idx" ON "floating_transaction_allocations" USING btree ("tenant_id", "loan_id", "due_date", "effective_date");
--> statement-breakpoint

-- Give every pre-existing floating loan a durable, auditable Bangkok cutover
-- checkpoint, including loans that had no accrual or payment rows at cutover.
INSERT INTO "audit_logs" (
	"tenant_id", "entity_type", "entity_id", "action", "actor_source", "request_id", "correlation_id", "payload"
)
SELECT
	loan."tenant_id",
	'loan',
	loan."public_id"::text,
	'floating_penalty_ledger_migrated',
	'system',
	'floating-penalty-ledger-migration-0030',
	'floating-penalty-ledger-migration-0030:' || loan."public_id"::text,
	jsonb_build_object('source', 'legacy_floating_settlement_state')
FROM "loans" loan
WHERE loan."repayment_type" = 'floating';
--> statement-breakpoint

INSERT INTO "floating_penalty_ledger_entries" (
	"tenant_id", "loan_id", "due_date", "penalty_date", "entry_type", "amount",
	"opening_interest_basis", "late_fee_mode", "late_fee_value", "grace_period_days",
	"reason", "idempotency_key", "audit_public_id", "actor_source", "request_id",
	"correlation_id", "created_by_user_id"
)
SELECT
	loan."tenant_id",
	loan."id",
	(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Bangkok')::date,
	(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Bangkok')::date,
	'legacy_cutover',
	0,
	0,
	'none',
	0,
	0,
	'Marks the exact Bangkok cutover from legacy floating penalty state',
	'floating-penalty-cutover-0030:' || loan."public_id"::text,
	audit."public_id",
	'system',
	'floating-penalty-ledger-migration-0030',
	'floating-penalty-ledger-migration-0030:' || loan."public_id"::text,
	NULL
FROM "loans" loan
JOIN "audit_logs" audit
	ON audit."tenant_id" = loan."tenant_id"
	AND audit."correlation_id" = 'floating-penalty-ledger-migration-0030:' || loan."public_id"::text
WHERE loan."repayment_type" = 'floating';
--> statement-breakpoint

-- Reconstruct the legacy runtime value once per due group. A zero-valued row is
-- intentional: it closes the old undated cache even when the group was not yet
-- overdue or no late-fee policy applied.
INSERT INTO "floating_penalty_ledger_entries" (
	"tenant_id", "loan_id", "due_date", "penalty_date", "entry_type", "amount",
	"opening_interest_basis", "late_fee_mode", "late_fee_value", "grace_period_days",
	"reason", "idempotency_key", "audit_public_id", "actor_source", "request_id",
	"correlation_id", "created_by_user_id"
)
WITH grouped AS (
	SELECT
		accrual."tenant_id",
		accrual."loan_id",
		COALESCE(accrual."period_end_date", accrual."accrual_date") AS "due_date",
		SUM(GREATEST(accrual."interest_amount" - accrual."paid_amount", 0)) AS "unpaid_interest",
		SUM(accrual."accrued_penalty") AS "stored_penalty"
	FROM "loan_interest_accruals" accrual
	JOIN "loans" loan
		ON loan."tenant_id" = accrual."tenant_id" AND loan."id" = accrual."loan_id"
	WHERE loan."repayment_type" = 'floating' AND accrual."status" <> 'reversed'
	GROUP BY accrual."tenant_id", accrual."loan_id", COALESCE(accrual."period_end_date", accrual."accrual_date")
), exact_state AS (
	SELECT
		grouped.*,
		loan."public_id" AS "loan_public_id",
		COALESCE(loan."late_fee_mode", 'none') AS "late_fee_mode",
		COALESCE(loan."late_fee_amount", 0) AS "late_fee_value",
		GREATEST(COALESCE(loan."grace_period_days", 0), 0) AS "grace_period_days",
		GREATEST(
			0,
			(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Bangkok')::date
				- grouped."due_date"
				- GREATEST(COALESCE(loan."grace_period_days", 0), 0)
		) AS "overdue_days"
	FROM grouped
	JOIN "loans" loan
		ON loan."tenant_id" = grouped."tenant_id" AND loan."id" = grouped."loan_id"
)
SELECT
	state."tenant_id",
	state."loan_id",
	state."due_date",
	(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Bangkok')::date,
	'legacy_snapshot',
	GREATEST(
		state."stored_penalty",
		ROUND(
			CASE
				WHEN state."unpaid_interest" <= 0 OR state."overdue_days" <= 0 THEN 0
				ELSE
					CASE WHEN state."late_fee_mode" IN ('fixed', 'fixed_plus_percent') THEN state."late_fee_value" ELSE 0 END
					+ CASE WHEN state."late_fee_mode" IN ('daily_percent', 'fixed_plus_percent')
						THEN state."unpaid_interest" * state."late_fee_value" / 100 * state."overdue_days"
						ELSE 0 END
			END,
			2
		)
	),
	state."unpaid_interest",
	state."late_fee_mode",
	state."late_fee_value",
	state."grace_period_days",
	'Migrated exact legacy floating penalty state at the Bangkok cutover',
	'floating-penalty-snapshot-0030:' || state."loan_public_id"::text || ':' || state."due_date"::text,
	audit."public_id",
	'system',
	'floating-penalty-ledger-migration-0030',
	'floating-penalty-ledger-migration-0030:' || state."loan_public_id"::text,
	NULL
FROM exact_state state
JOIN "audit_logs" audit
	ON audit."tenant_id" = state."tenant_id"
	AND audit."correlation_id" = 'floating-penalty-ledger-migration-0030:' || state."loan_public_id"::text;
--> statement-breakpoint

-- Replay active repayment components through the cached paid totals. The
-- canonical payment order is effective timestamp plus id, never insert id alone.
INSERT INTO "floating_transaction_allocations" (
	"tenant_id", "loan_id", "transaction_id", "due_date", "component", "interest_accrual_id", "effective_date",
	"allocation_order", "entry_type", "amount", "reason", "idempotency_key", "audit_public_id",
	"actor_source", "request_id", "correlation_id", "created_by_user_id"
)
WITH active_transactions AS (
	SELECT
		t.*,
		COALESCE(t."transaction_date", t."posted_at", t."created_at") AS "effective_timestamp",
		SUM(t."penalty_component") OVER (
			PARTITION BY t."tenant_id", t."loan_id"
			ORDER BY COALESCE(t."transaction_date", t."posted_at", t."created_at"), t."id" ROWS UNBOUNDED PRECEDING
		) - t."penalty_component" AS "penalty_start",
		SUM(t."penalty_component") OVER (
			PARTITION BY t."tenant_id", t."loan_id"
			ORDER BY COALESCE(t."transaction_date", t."posted_at", t."created_at"), t."id" ROWS UNBOUNDED PRECEDING
		) AS "penalty_end",
		SUM(t."interest_component") OVER (
			PARTITION BY t."tenant_id", t."loan_id"
			ORDER BY COALESCE(t."transaction_date", t."posted_at", t."created_at"), t."id" ROWS UNBOUNDED PRECEDING
		) - t."interest_component" AS "interest_start",
		SUM(t."interest_component") OVER (
			PARTITION BY t."tenant_id", t."loan_id"
			ORDER BY COALESCE(t."transaction_date", t."posted_at", t."created_at"), t."id" ROWS UNBOUNDED PRECEDING
		) AS "interest_end"
	FROM "transactions" t
	JOIN "loans" loan ON loan."tenant_id" = t."tenant_id" AND loan."id" = t."loan_id"
	WHERE loan."repayment_type" = 'floating'
		AND t."entry_type" = 'repayment'
		AND t."reversed_transaction_id" IS NULL
		AND NOT EXISTS (
			SELECT 1 FROM "transactions" reversal
			WHERE reversal."tenant_id" = t."tenant_id" AND reversal."reversed_transaction_id" = t."id"
		)
), penalty_targets AS (
	SELECT
		accrual."tenant_id",
		accrual."loan_id",
		MIN(accrual."id") AS "target_id",
		COALESCE(accrual."period_end_date", accrual."accrual_date") AS "due_date",
		SUM(accrual."paid_penalty") AS "paid_penalty"
	FROM "loan_interest_accruals" accrual
	WHERE accrual."status" <> 'reversed'
	GROUP BY accrual."tenant_id", accrual."loan_id", COALESCE(accrual."period_end_date", accrual."accrual_date")
), ordered_penalty_targets AS (
	SELECT
		penalty_targets.*,
		SUM("paid_penalty") OVER (
			PARTITION BY "tenant_id", "loan_id" ORDER BY "due_date", "target_id" ROWS UNBOUNDED PRECEDING
		) - "paid_penalty" AS "target_start",
		SUM("paid_penalty") OVER (
			PARTITION BY "tenant_id", "loan_id" ORDER BY "due_date", "target_id" ROWS UNBOUNDED PRECEDING
		) AS "target_end"
	FROM penalty_targets
	WHERE "paid_penalty" > 0
), interest_targets AS (
	SELECT
		accrual."tenant_id",
		accrual."loan_id",
		accrual."id" AS "target_id",
		COALESCE(accrual."period_end_date", accrual."accrual_date") AS "due_date",
		accrual."accrual_date",
		accrual."paid_amount"
	FROM "loan_interest_accruals" accrual
	JOIN "loans" loan ON loan."tenant_id" = accrual."tenant_id" AND loan."id" = accrual."loan_id"
	WHERE accrual."status" <> 'reversed' AND accrual."paid_amount" > 0
		AND NOT (
			loan."first_day_treatment" = 'deduct'
			AND (
				(COALESCE(loan."floating_accrual_cycle", 'daily') = 'weekly'
					AND (accrual."period_start_date" = loan."interest_start_date"
						OR (accrual."period_start_date" IS NULL AND accrual."accrual_date" = loan."interest_start_date")))
				OR (COALESCE(loan."floating_accrual_cycle", 'daily') = 'daily'
					AND accrual."accrual_date" = loan."interest_start_date")
			)
		)
), ordered_interest_targets AS (
	SELECT
		interest_targets.*,
		SUM("paid_amount") OVER (
			PARTITION BY "tenant_id", "loan_id" ORDER BY "due_date", "accrual_date", "target_id" ROWS UNBOUNDED PRECEDING
		) - "paid_amount" AS "target_start",
		SUM("paid_amount") OVER (
			PARTITION BY "tenant_id", "loan_id" ORDER BY "due_date", "accrual_date", "target_id" ROWS UNBOUNDED PRECEDING
		) AS "target_end"
	FROM interest_targets
), component_matches AS (
	SELECT
		t."tenant_id", t."loan_id", t."id" AS "transaction_id", t."public_id" AS "transaction_public_id",
		p."due_date", 'penalty'::text AS "component", NULL::integer AS "interest_accrual_id", p."target_id",
		LEAST(t."penalty_end", p."target_end") - GREATEST(t."penalty_start", p."target_start") AS "amount",
		t."effective_timestamp"
	FROM active_transactions t
	JOIN ordered_penalty_targets p
		ON p."tenant_id" = t."tenant_id" AND p."loan_id" = t."loan_id"
		AND LEAST(t."penalty_end", p."target_end") > GREATEST(t."penalty_start", p."target_start")
	WHERE t."penalty_component" > 0
	UNION ALL
	SELECT
		t."tenant_id", t."loan_id", t."id", t."public_id",
		i."due_date", 'interest'::text, i."target_id", i."target_id",
		LEAST(t."interest_end", i."target_end") - GREATEST(t."interest_start", i."target_start"),
		t."effective_timestamp"
	FROM active_transactions t
	JOIN ordered_interest_targets i
		ON i."tenant_id" = t."tenant_id" AND i."loan_id" = t."loan_id"
		AND LEAST(t."interest_end", i."target_end") > GREATEST(t."interest_start", i."target_start")
	WHERE t."interest_component" > 0
), ordered_matches AS (
	SELECT component_matches.*,
		ROW_NUMBER() OVER (
			PARTITION BY "tenant_id", "transaction_id"
			ORDER BY CASE "component" WHEN 'penalty' THEN 0 ELSE 1 END, "due_date", "target_id"
		) AS "allocation_order"
	FROM component_matches
)
SELECT
	match."tenant_id",
	match."loan_id",
	match."transaction_id",
	match."due_date",
	match."component",
	match."interest_accrual_id",
	((match."effective_timestamp" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Bangkok')::date,
	match."allocation_order",
	'payment',
	match."amount",
	NULL,
	'floating-allocation-migration-0030:' || match."transaction_public_id"::text || ':' || match."component" || ':' || match."target_id"::text,
	audit."public_id",
	'system',
	'floating-penalty-ledger-migration-0030',
	'floating-penalty-ledger-migration-0030:' || loan."public_id"::text,
	NULL
FROM ordered_matches match
JOIN "loans" loan ON loan."tenant_id" = match."tenant_id" AND loan."id" = match."loan_id"
JOIN "audit_logs" audit
	ON audit."tenant_id" = match."tenant_id"
	AND audit."correlation_id" = 'floating-penalty-ledger-migration-0030:' || loan."public_id"::text;
--> statement-breakpoint

-- Refuse cutover if the exact provenance cannot reproduce both the active
-- transaction components and the legacy paid caches. Principal is intentionally
-- outside this component ledger.
DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM "transactions" transaction
		JOIN "loans" loan ON loan."tenant_id" = transaction."tenant_id" AND loan."id" = transaction."loan_id"
		WHERE loan."repayment_type" = 'floating'
			AND transaction."entry_type" = 'repayment'
			AND transaction."reversed_transaction_id" IS NULL
			AND NOT EXISTS (
				SELECT 1 FROM "transactions" reversal
				WHERE reversal."tenant_id" = transaction."tenant_id"
					AND reversal."reversed_transaction_id" = transaction."id"
			)
			AND (
				transaction."penalty_component" <> COALESCE((
					SELECT SUM(allocation."amount") FROM "floating_transaction_allocations" allocation
					WHERE allocation."tenant_id" = transaction."tenant_id"
						AND allocation."transaction_id" = transaction."id"
						AND allocation."component" = 'penalty'
				), 0)
				OR transaction."interest_component" <> COALESCE((
					SELECT SUM(allocation."amount") FROM "floating_transaction_allocations" allocation
					WHERE allocation."tenant_id" = transaction."tenant_id"
						AND allocation."transaction_id" = transaction."id"
						AND allocation."component" = 'interest'
				), 0)
			)
	) THEN
		RAISE EXCEPTION 'floating settlement migration requires exact transaction allocation provenance';
	END IF;

	IF EXISTS (
		SELECT 1
		FROM "loans" loan
		WHERE loan."repayment_type" = 'floating'
			AND (
				COALESCE((
					SELECT SUM(accrual."paid_penalty") FROM "loan_interest_accruals" accrual
					WHERE accrual."tenant_id" = loan."tenant_id" AND accrual."loan_id" = loan."id"
						AND accrual."status" <> 'reversed'
				), 0) <> COALESCE((
					SELECT SUM(allocation."amount") FROM "floating_transaction_allocations" allocation
					WHERE allocation."tenant_id" = loan."tenant_id" AND allocation."loan_id" = loan."id"
						AND allocation."component" = 'penalty'
				), 0)
				OR COALESCE((
					SELECT SUM(accrual."paid_amount")
					FROM "loan_interest_accruals" accrual
					WHERE accrual."tenant_id" = loan."tenant_id" AND accrual."loan_id" = loan."id"
						AND accrual."status" <> 'reversed'
						AND NOT (
							loan."first_day_treatment" = 'deduct'
							AND (
								(COALESCE(loan."floating_accrual_cycle", 'daily') = 'weekly'
									AND (accrual."period_start_date" = loan."interest_start_date"
										OR (accrual."period_start_date" IS NULL AND accrual."accrual_date" = loan."interest_start_date")))
								OR (COALESCE(loan."floating_accrual_cycle", 'daily') = 'daily'
									AND accrual."accrual_date" = loan."interest_start_date")
							)
						)
				), 0) <> COALESCE((
					SELECT SUM(allocation."amount") FROM "floating_transaction_allocations" allocation
					WHERE allocation."tenant_id" = loan."tenant_id" AND allocation."loan_id" = loan."id"
						AND allocation."component" = 'interest'
				), 0)
			)
	) THEN
		RAISE EXCEPTION 'floating settlement migration found unmatched paid accrual state';
	END IF;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION validate_floating_penalty_ledger_entry()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	base_entry "floating_penalty_ledger_entries"%ROWTYPE;
BEGIN
	IF NEW."entry_type" = 'adjustment' THEN
		SELECT * INTO base_entry
		FROM "floating_penalty_ledger_entries"
		WHERE "tenant_id" = NEW."tenant_id"
			AND "loan_id" = NEW."loan_id"
			AND "id" = NEW."adjusts_entry_id";

		IF NOT FOUND THEN
			RETURN NEW;
		END IF;
		IF base_entry."entry_type" NOT IN ('fixed_assessment', 'daily_percent_accrual') THEN
			RAISE EXCEPTION 'floating penalty adjustments must reference a dated base assessment';
		END IF;
		IF NEW."due_date" IS DISTINCT FROM base_entry."due_date"
			OR NEW."penalty_date" IS DISTINCT FROM base_entry."penalty_date"
		THEN
			RAISE EXCEPTION 'floating penalty adjustments must use the same assessment coordinates';
		END IF;
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "floating_penalty_ledger_entries_validate"
BEFORE INSERT ON "floating_penalty_ledger_entries"
FOR EACH ROW EXECUTE FUNCTION validate_floating_penalty_ledger_entry();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION validate_floating_transaction_allocation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	transaction_row "transactions"%ROWTYPE;
	original_allocation "floating_transaction_allocations"%ROWTYPE;
BEGIN
	SELECT * INTO transaction_row
	FROM "transactions"
	WHERE "tenant_id" = NEW."tenant_id"
		AND "loan_id" = NEW."loan_id"
		AND "id" = NEW."transaction_id";

	IF NOT FOUND THEN
		RETURN NEW;
	END IF;

	IF NEW."entry_type" = 'payment' THEN
		IF transaction_row."entry_type" <> 'repayment' THEN
			RAISE EXCEPTION 'floating payment allocations require a repayment transaction';
		END IF;
		RETURN NEW;
	END IF;

	SELECT * INTO original_allocation
	FROM "floating_transaction_allocations"
	WHERE "tenant_id" = NEW."tenant_id"
		AND "loan_id" = NEW."loan_id"
		AND "id" = NEW."reversed_allocation_id";

	IF NOT FOUND THEN
		RETURN NEW;
	END IF;
	IF original_allocation."entry_type" <> 'payment'
		OR transaction_row."entry_type" <> 'reversal'
		OR transaction_row."reversed_transaction_id" IS DISTINCT FROM original_allocation."transaction_id"
		OR NEW."component" IS DISTINCT FROM original_allocation."component"
		OR NEW."due_date" IS DISTINCT FROM original_allocation."due_date"
		OR NEW."interest_accrual_id" IS DISTINCT FROM original_allocation."interest_accrual_id"
	THEN
		RAISE EXCEPTION 'floating reversal allocation must match the original allocation coordinates';
	END IF;
	IF NEW."amount" <> -original_allocation."amount" THEN
		RAISE EXCEPTION 'floating reversal allocation amount must be the exact negative of the original allocation';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "floating_transaction_allocations_validate"
BEFORE INSERT ON "floating_transaction_allocations"
FOR EACH ROW EXECUTE FUNCTION validate_floating_transaction_allocation();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION protect_floating_penalty_ledger_history()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	RAISE EXCEPTION 'floating settlement ledger history is append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "floating_penalty_ledger_entries_immutable"
BEFORE UPDATE OR DELETE ON "floating_penalty_ledger_entries"
FOR EACH ROW EXECUTE FUNCTION protect_floating_penalty_ledger_history();
--> statement-breakpoint
CREATE TRIGGER "floating_transaction_allocations_immutable"
BEFORE UPDATE OR DELETE ON "floating_transaction_allocations"
FOR EACH ROW EXECUTE FUNCTION protect_floating_penalty_ledger_history();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION protect_referenced_floating_transaction()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	is_referenced boolean;
BEGIN
	SELECT EXISTS (
		SELECT 1 FROM "floating_transaction_allocations" allocation
		WHERE allocation."tenant_id" = OLD."tenant_id"
			AND allocation."loan_id" = OLD."loan_id"
			AND allocation."transaction_id" = OLD."id"
		UNION ALL
		SELECT 1 FROM "floating_penalty_ledger_entries" ledger
		WHERE ledger."tenant_id" = OLD."tenant_id"
			AND ledger."loan_id" = OLD."loan_id"
			AND ledger."source_transaction_id" = OLD."id"
	) INTO is_referenced;

	IF NOT is_referenced THEN
		RETURN COALESCE(NEW, OLD);
	END IF;
	IF TG_OP = 'DELETE'
		OR NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
		OR NEW."loan_id" IS DISTINCT FROM OLD."loan_id"
		OR NEW."schedule_id" IS DISTINCT FROM OLD."schedule_id"
		OR NEW."amount" IS DISTINCT FROM OLD."amount"
		OR NEW."principal_component" IS DISTINCT FROM OLD."principal_component"
		OR NEW."interest_component" IS DISTINCT FROM OLD."interest_component"
		OR NEW."fee_component" IS DISTINCT FROM OLD."fee_component"
		OR NEW."penalty_component" IS DISTINCT FROM OLD."penalty_component"
		OR NEW."type" IS DISTINCT FROM OLD."type"
		OR NEW."transaction_date" IS DISTINCT FROM OLD."transaction_date"
		OR NEW."payment_intake_id" IS DISTINCT FROM OLD."payment_intake_id"
		OR NEW."entry_type" IS DISTINCT FROM OLD."entry_type"
		OR NEW."reversed_transaction_id" IS DISTINCT FROM OLD."reversed_transaction_id"
		OR NEW."idempotency_key" IS DISTINCT FROM OLD."idempotency_key"
		OR NEW."posted_at" IS DISTINCT FROM OLD."posted_at"
	THEN
		RAISE EXCEPTION 'referenced transaction financial history is immutable';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "transactions_referenced_floating_history_immutable"
BEFORE UPDATE OR DELETE ON "transactions"
FOR EACH ROW EXECUTE FUNCTION protect_referenced_floating_transaction();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION protect_legacy_floating_penalty_cache()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF NEW."accrued_penalty" IS DISTINCT FROM OLD."accrued_penalty"
		OR NEW."paid_penalty" IS DISTINCT FROM OLD."paid_penalty"
	THEN
		RAISE EXCEPTION 'legacy floating penalty cache is immutable';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "loan_interest_accruals_legacy_penalty_immutable"
BEFORE UPDATE ON "loan_interest_accruals"
FOR EACH ROW EXECUTE FUNCTION protect_legacy_floating_penalty_cache();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION validate_floating_interest_paid_cache()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	accrual_row "loan_interest_accruals"%ROWTYPE;
	loan_row "loans"%ROWTYPE;
	advance_amount numeric := 0;
	allocated_amount numeric := 0;
BEGIN
	-- A row can be inserted and updated again in one transaction. Each deferred
	-- event must validate the final live tuple, not its stale event-time image.
	SELECT * INTO accrual_row
	FROM "loan_interest_accruals"
	WHERE "tenant_id" = NEW."tenant_id" AND "id" = NEW."id";
	IF NOT FOUND OR accrual_row."status" = 'reversed' THEN
		RETURN NULL;
	END IF;

	SELECT * INTO loan_row
	FROM "loans"
	WHERE "tenant_id" = accrual_row."tenant_id" AND "id" = accrual_row."loan_id";
	IF NOT FOUND OR loan_row."repayment_type" <> 'floating' THEN
		RETURN NULL;
	END IF;

	IF loan_row."first_day_treatment" = 'deduct'
		AND (
			(COALESCE(loan_row."floating_accrual_cycle", 'daily') = 'weekly'
				AND (accrual_row."period_start_date" = loan_row."interest_start_date"
					OR (accrual_row."period_start_date" IS NULL AND accrual_row."accrual_date" = loan_row."interest_start_date")))
			OR (COALESCE(loan_row."floating_accrual_cycle", 'daily') = 'daily'
				AND accrual_row."accrual_date" = loan_row."interest_start_date")
		)
	THEN
		advance_amount := accrual_row."interest_amount";
	END IF;

	SELECT COALESCE(SUM(allocation."amount"), 0)
	INTO allocated_amount
	FROM "floating_transaction_allocations" allocation
	WHERE allocation."tenant_id" = accrual_row."tenant_id"
		AND allocation."loan_id" = accrual_row."loan_id"
		AND allocation."component" = 'interest'
		AND allocation."interest_accrual_id" = accrual_row."id";

	IF accrual_row."paid_amount" <> advance_amount + allocated_amount THEN
		RAISE EXCEPTION 'paid_amount cache does not match floating interest allocations';
	END IF;
	RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "loan_interest_accruals_floating_paid_cache_consistent"
AFTER INSERT OR UPDATE ON "loan_interest_accruals"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_floating_interest_paid_cache();
