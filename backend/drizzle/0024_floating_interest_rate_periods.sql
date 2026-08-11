CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint
CREATE TABLE "loan_interest_rate_periods" (
	"id" serial PRIMARY KEY NOT NULL,
	"public_id" uuid DEFAULT uuidv7() NOT NULL,
	"tenant_id" text NOT NULL,
	"loan_id" integer NOT NULL,
	"effective_date" date NOT NULL,
	"expiry_date" date,
	"rate_type" text NOT NULL,
	"rate" numeric NOT NULL,
	"created_by_user_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "loan_interest_rate_periods_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "loan_interest_rate_periods_rate_positive_check" CHECK ("loan_interest_rate_periods"."rate" > 0),
	CONSTRAINT "loan_interest_rate_periods_rate_scale_check" CHECK (scale("loan_interest_rate_periods"."rate") <= 4),
	CONSTRAINT "loan_interest_rate_periods_rate_type_check" CHECK ("loan_interest_rate_periods"."rate_type" IN ('percent', 'per_thousand')),
	CONSTRAINT "loan_interest_rate_periods_date_order_check" CHECK ("loan_interest_rate_periods"."expiry_date" IS NULL OR "loan_interest_rate_periods"."expiry_date" >= "loan_interest_rate_periods"."effective_date")
);
--> statement-breakpoint
CREATE TABLE "loan_interest_rate_previews" (
	"id" serial PRIMARY KEY NOT NULL,
	"public_id" uuid DEFAULT uuidv7() NOT NULL,
	"tenant_id" text NOT NULL,
	"loan_id" integer NOT NULL,
	"created_by_user_id" integer,
	"request" jsonb NOT NULL,
	"request_hash" text NOT NULL,
	"preview_hash" text NOT NULL,
	"before_timeline" jsonb NOT NULL,
	"after_timeline" jsonb NOT NULL,
	"timeline_version" text NOT NULL,
	"status" text DEFAULT 'ready' NOT NULL,
	"execute_idempotency_key" text,
	"executed_audit_public_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"executed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loan_interest_rate_previews_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "loan_interest_rate_previews_status_check" CHECK ("loan_interest_rate_previews"."status" IN ('ready', 'executed', 'expired'))
);
--> statement-breakpoint
ALTER TABLE "loan_interest_accruals" ADD COLUMN "interest_rate_period_id" integer;--> statement-breakpoint
ALTER TABLE "loan_interest_rate_periods" ADD CONSTRAINT "loan_interest_rate_periods_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_interest_rate_periods" ADD CONSTRAINT "loan_interest_rate_periods_tenant_loan_fk" FOREIGN KEY ("tenant_id","loan_id") REFERENCES "public"."loans"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_interest_rate_previews" ADD CONSTRAINT "loan_interest_rate_previews_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_interest_rate_previews" ADD CONSTRAINT "loan_interest_rate_previews_tenant_loan_fk" FOREIGN KEY ("tenant_id","loan_id") REFERENCES "public"."loans"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "loan_interest_rate_periods_tenant_id_id_unique" ON "loan_interest_rate_periods" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE INDEX "loan_interest_rate_periods_tenant_loan_effective_idx" ON "loan_interest_rate_periods" USING btree ("tenant_id","loan_id","effective_date");--> statement-breakpoint
CREATE UNIQUE INDEX "loan_interest_rate_previews_tenant_id_id_unique" ON "loan_interest_rate_previews" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "loan_interest_rate_previews_tenant_execute_idempotency_unique" ON "loan_interest_rate_previews" USING btree ("tenant_id","execute_idempotency_key") WHERE "loan_interest_rate_previews"."execute_idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "loan_interest_rate_previews_tenant_loan_created_idx" ON "loan_interest_rate_previews" USING btree ("tenant_id","loan_id","created_at");--> statement-breakpoint
ALTER TABLE "loan_interest_accruals" ADD CONSTRAINT "loan_interest_accruals_tenant_rate_period_fk" FOREIGN KEY ("tenant_id","interest_rate_period_id") REFERENCES "public"."loan_interest_rate_periods"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
INSERT INTO "loan_interest_rate_periods" (
    "tenant_id", "loan_id", "effective_date", "expiry_date", "rate_type", "rate", "created_by_user_id", "created_at", "updated_at"
)
SELECT
    "tenant_id", "id", "interest_start_date", NULL, "daily_interest_mode", "daily_interest_rate", "owner_user_id", NOW(), NOW()
FROM "loans"
WHERE "repayment_type" = 'floating'
  AND "interest_start_date" IS NOT NULL
  AND "daily_interest_mode" IN ('percent', 'per_thousand')
  AND "daily_interest_rate" > 0
  AND NOT EXISTS (
      SELECT 1
      FROM "loan_interest_rate_periods" AS "period"
      WHERE "period"."tenant_id" = "loans"."tenant_id"
        AND "period"."loan_id" = "loans"."id"
  );
--> statement-breakpoint
ALTER TABLE "loan_interest_rate_periods"
ADD CONSTRAINT "loan_interest_rate_periods_no_overlap"
EXCLUDE USING gist (
    "tenant_id" WITH =,
    "loan_id" WITH =,
    daterange("effective_date", "expiry_date", '[]') WITH &&
);
