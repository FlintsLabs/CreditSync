CREATE TABLE "loan_cancellation_previews" (
	"id" serial PRIMARY KEY NOT NULL,
	"public_id" uuid DEFAULT uuidv7() NOT NULL,
	"tenant_id" text NOT NULL,
	"loan_id" integer NOT NULL,
	"reason" text NOT NULL,
	"eligibility" text DEFAULT 'unfunded' NOT NULL,
	"before_snapshot" jsonb NOT NULL,
	"balance_version" text NOT NULL,
	"preview_hash" text NOT NULL,
	"status" text DEFAULT 'ready' NOT NULL,
	"execute_idempotency_key" text,
	"executed_audit_public_id" uuid,
	"correlation_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"executed_at" timestamp with time zone,
	"created_by_user_id" integer,
	"executed_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loan_cancellation_previews_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "loan_cancellation_previews_status_check" CHECK ("loan_cancellation_previews"."status" IN ('ready', 'executed', 'expired')),
	CONSTRAINT "loan_cancellation_previews_eligibility_check" CHECK ("loan_cancellation_previews"."eligibility" = 'unfunded'),
	CONSTRAINT "loan_cancellation_previews_hash_check" CHECK (length("loan_cancellation_previews"."balance_version") > 0 AND length("loan_cancellation_previews"."preview_hash") > 0),
	CONSTRAINT "loan_cancellation_previews_expiry_check" CHECK ("loan_cancellation_previews"."expires_at" > "loan_cancellation_previews"."created_at")
);
--> statement-breakpoint
ALTER TABLE "loan_cancellation_previews" ADD CONSTRAINT "loan_cancellation_previews_tenant_loan_fk" FOREIGN KEY ("tenant_id","loan_id") REFERENCES "public"."loans"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_cancellation_previews" ADD CONSTRAINT "loan_cancellation_previews_tenant_created_by_fk" FOREIGN KEY ("tenant_id","created_by_user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_cancellation_previews" ADD CONSTRAINT "loan_cancellation_previews_tenant_executed_by_fk" FOREIGN KEY ("tenant_id","executed_by_user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "loan_cancellation_previews_tenant_id_id_unique" ON "loan_cancellation_previews" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "loan_cancellation_previews_tenant_execute_idempotency_unique" ON "loan_cancellation_previews" USING btree ("tenant_id","execute_idempotency_key") WHERE "loan_cancellation_previews"."execute_idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "loan_cancellation_previews_tenant_loan_created_idx" ON "loan_cancellation_previews" USING btree ("tenant_id","loan_id","created_at");
