CREATE TABLE "loan_waiver_previews" (
	"id" serial PRIMARY KEY NOT NULL,
	"public_id" uuid DEFAULT uuidv7() NOT NULL,
	"tenant_id" text NOT NULL,
	"restructure_id" integer NOT NULL,
	"loan_id" integer NOT NULL,
	"component_kind" text NOT NULL,
	"amount" numeric NOT NULL,
	"reason" text NOT NULL,
	"balance_version" text NOT NULL,
	"preview_hash" text NOT NULL,
	"status" text DEFAULT 'preview' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"actor_source" text NOT NULL,
	"request_id" text NOT NULL,
	"correlation_id" text NOT NULL,
	"created_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loan_waiver_previews_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "loan_waiver_previews_kind_check" CHECK ("loan_waiver_previews"."component_kind" IN ('interest', 'fee', 'penalty')),
	CONSTRAINT "loan_waiver_previews_amount_check" CHECK ("loan_waiver_previews"."amount" > 0 AND scale("loan_waiver_previews"."amount") <= 2),
	CONSTRAINT "loan_waiver_previews_status_check" CHECK ("loan_waiver_previews"."status" IN ('preview', 'consumed', 'expired')),
	CONSTRAINT "loan_waiver_previews_lifecycle_check" CHECK (
        ("loan_waiver_previews"."status" IN ('preview', 'expired') AND "loan_waiver_previews"."consumed_at" IS NULL)
        OR ("loan_waiver_previews"."status" = 'consumed' AND "loan_waiver_previews"."consumed_at" IS NOT NULL)
    ),
	CONSTRAINT "loan_waiver_previews_actor_source_check" CHECK ("loan_waiver_previews"."actor_source" IN ('web', 'mcp', 'system'))
);
--> statement-breakpoint
ALTER TABLE "loan_waiver_previews" ADD CONSTRAINT "loan_waiver_previews_tenant_restructure_fk" FOREIGN KEY ("tenant_id","restructure_id") REFERENCES "public"."loan_restructures"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_waiver_previews" ADD CONSTRAINT "loan_waiver_previews_tenant_loan_fk" FOREIGN KEY ("tenant_id","loan_id") REFERENCES "public"."loans"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_waiver_previews" ADD CONSTRAINT "loan_waiver_previews_tenant_created_by_fk" FOREIGN KEY ("tenant_id","created_by_user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "loan_waiver_previews_tenant_id_id_unique" ON "loan_waiver_previews" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE INDEX "loan_waiver_previews_tenant_loan_status_idx" ON "loan_waiver_previews" USING btree ("tenant_id","loan_id","status");