CREATE TABLE "payment_batch_allocations" (
	"id" serial PRIMARY KEY NOT NULL,
	"public_id" uuid DEFAULT uuidv7() NOT NULL,
	"tenant_id" text NOT NULL,
	"preview_id" integer NOT NULL,
	"item_id" integer NOT NULL,
	"allocation_order" integer NOT NULL,
	"borrower_id" integer NOT NULL,
	"loan_id" integer NOT NULL,
	"schedule_id" integer NOT NULL,
	"amount" numeric NOT NULL,
	"target_due_date" date NOT NULL,
	"intent" text NOT NULL,
	"calculated_components" jsonb NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	CONSTRAINT "payment_batch_allocations_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "payment_batch_allocations_status_check" CHECK ("payment_batch_allocations"."status" IN ('proposed', 'posted')),
	CONSTRAINT "payment_batch_allocations_intent_check" CHECK ("payment_batch_allocations"."intent" IN ('on_time', 'advance', 'backdated')),
	CONSTRAINT "payment_batch_allocations_amount_check" CHECK ("payment_batch_allocations"."amount" >= 0 AND scale("payment_batch_allocations"."amount") <= 2 AND "payment_batch_allocations"."amount" NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric))
);
--> statement-breakpoint
--> statement-breakpoint
CREATE TABLE "payment_batch_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"public_id" uuid DEFAULT uuidv7() NOT NULL,
	"tenant_id" text NOT NULL,
	"batch_id" integer NOT NULL,
	"payment_intake_id" integer NOT NULL,
	"item_order" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_batch_items_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "payment_batch_items_order_check" CHECK ("payment_batch_items"."item_order" > 0)
);
--> statement-breakpoint
CREATE TABLE "payment_batch_previews" (
	"id" serial PRIMARY KEY NOT NULL,
	"public_id" uuid DEFAULT uuidv7() NOT NULL,
	"tenant_id" text NOT NULL,
	"batch_id" integer NOT NULL,
	"version" integer NOT NULL,
	"status" text NOT NULL,
	"state_hash" text NOT NULL,
	"preview_hash" text NOT NULL,
	"confirmation_hash" text NOT NULL,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"candidates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"evidence_ready" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_batch_previews_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "payment_batch_previews_version_check" CHECK ("payment_batch_previews"."version" > 0),
	CONSTRAINT "payment_batch_previews_status_check" CHECK ("payment_batch_previews"."status" IN ('needs_review', 'ready', 'stale', 'posted'))
);
--> statement-breakpoint
CREATE TABLE "payment_batches" (
	"id" serial PRIMARY KEY NOT NULL,
	"public_id" uuid DEFAULT uuidv7() NOT NULL,
	"tenant_id" text NOT NULL,
	"borrower_id" integer,
	"status" text DEFAULT 'draft' NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"state_hash" text NOT NULL,
	"confirmation_hash" text,
	"confirmed_version" integer,
	"create_idempotency_key" text NOT NULL,
	"execute_idempotency_key" text,
	"execute_request_hash" text,
	"notes" text,
	"posted_at" timestamp with time zone,
	"created_by_user_id" integer,
	"updated_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_batches_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "payment_batches_status_check" CHECK ("payment_batches"."status" IN ('draft', 'needs_review', 'ready', 'confirmed', 'posted', 'stale', 'cancelled')),
	CONSTRAINT "payment_batches_version_check" CHECK ("payment_batches"."version" >= 0),
	CONSTRAINT "payment_batches_command_keys_check" CHECK ("payment_batches"."create_idempotency_key" ~ '[^[:space:]]' AND ("payment_batches"."execute_idempotency_key" IS NULL OR "payment_batches"."execute_idempotency_key" ~ '[^[:space:]]')),
	CONSTRAINT "payment_batches_posted_lifecycle_check" CHECK (("payment_batches"."status" = 'posted' AND "payment_batches"."posted_at" IS NOT NULL AND "payment_batches"."execute_idempotency_key" IS NOT NULL) OR ("payment_batches"."status" <> 'posted' AND "payment_batches"."posted_at" IS NULL))
);
CREATE UNIQUE INDEX "payment_batch_allocations_tenant_id_id_unique" ON "payment_batch_allocations" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_batch_items_tenant_id_id_unique" ON "payment_batch_items" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_batch_previews_tenant_id_id_unique" ON "payment_batch_previews" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_batches_tenant_id_id_unique" ON "payment_batches" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_batch_previews_tenant_batch_version_unique" ON "payment_batch_previews" USING btree ("tenant_id","batch_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_batch_items_tenant_batch_order_unique" ON "payment_batch_items" USING btree ("tenant_id","batch_id","item_order");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_batch_items_tenant_intake_unique" ON "payment_batch_items" USING btree ("tenant_id","payment_intake_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_batch_allocations_tenant_preview_order_unique" ON "payment_batch_allocations" USING btree ("tenant_id","preview_id","allocation_order");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_batches_tenant_idempotency_unique" ON "payment_batches" USING btree ("tenant_id","create_idempotency_key");--> statement-breakpoint
ALTER TABLE "payment_batch_allocations" ADD CONSTRAINT "payment_batch_allocations_tenant_preview_fk" FOREIGN KEY ("tenant_id","preview_id") REFERENCES "public"."payment_batch_previews"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_batch_allocations" ADD CONSTRAINT "payment_batch_allocations_tenant_item_fk" FOREIGN KEY ("tenant_id","item_id") REFERENCES "public"."payment_batch_items"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_batch_allocations" ADD CONSTRAINT "payment_batch_allocations_tenant_borrower_fk" FOREIGN KEY ("tenant_id","borrower_id") REFERENCES "public"."borrowers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_batch_allocations" ADD CONSTRAINT "payment_batch_allocations_tenant_loan_fk" FOREIGN KEY ("tenant_id","loan_id") REFERENCES "public"."loans"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_batch_allocations" ADD CONSTRAINT "payment_batch_allocations_tenant_schedule_fk" FOREIGN KEY ("tenant_id","schedule_id") REFERENCES "public"."loan_schedules"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "payment_batch_posted_immutable_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_TABLE_NAME = 'payment_batches' AND OLD."status" = 'posted' THEN
        RAISE EXCEPTION 'posted payment batch is immutable' USING ERRCODE = '23514';
    ELSIF TG_TABLE_NAME = 'payment_batch_items' AND EXISTS (
        SELECT 1 FROM "payment_batches" b WHERE b."tenant_id" = OLD."tenant_id" AND b."id" = OLD."batch_id" AND b."status" = 'posted'
    ) THEN
        RAISE EXCEPTION 'posted payment batch item is immutable' USING ERRCODE = '23514';
    ELSIF TG_TABLE_NAME = 'payment_batch_previews' AND EXISTS (
        SELECT 1 FROM "payment_batches" b WHERE b."tenant_id" = OLD."tenant_id" AND b."id" = OLD."batch_id" AND b."status" = 'posted'
    ) THEN
        RAISE EXCEPTION 'posted payment batch preview is immutable' USING ERRCODE = '23514';
    ELSIF TG_TABLE_NAME = 'payment_batch_allocations' AND EXISTS (
        SELECT 1 FROM "payment_batch_previews" p JOIN "payment_batches" b ON b."tenant_id" = p."tenant_id" AND b."id" = p."batch_id"
        WHERE p."tenant_id" = OLD."tenant_id" AND p."id" = OLD."preview_id" AND b."status" = 'posted'
    ) THEN
        RAISE EXCEPTION 'posted payment batch allocation is immutable' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "payment_batch_posted_immutable" BEFORE UPDATE OR DELETE ON "payment_batches" FOR EACH ROW EXECUTE FUNCTION "payment_batch_posted_immutable_guard"();--> statement-breakpoint
CREATE TRIGGER "payment_batch_item_posted_immutable" BEFORE UPDATE OR DELETE ON "payment_batch_items" FOR EACH ROW EXECUTE FUNCTION "payment_batch_posted_immutable_guard"();--> statement-breakpoint
CREATE TRIGGER "payment_batch_preview_posted_immutable" BEFORE UPDATE OR DELETE ON "payment_batch_previews" FOR EACH ROW EXECUTE FUNCTION "payment_batch_posted_immutable_guard"();--> statement-breakpoint
CREATE TRIGGER "payment_batch_allocation_posted_immutable" BEFORE UPDATE OR DELETE ON "payment_batch_allocations" FOR EACH ROW EXECUTE FUNCTION "payment_batch_posted_immutable_guard"();
ALTER TABLE "payment_batch_items" ADD CONSTRAINT "payment_batch_items_tenant_batch_fk" FOREIGN KEY ("tenant_id","batch_id") REFERENCES "public"."payment_batches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_batch_items" ADD CONSTRAINT "payment_batch_items_tenant_intake_fk" FOREIGN KEY ("tenant_id","payment_intake_id") REFERENCES "public"."payment_intakes"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_batch_previews" ADD CONSTRAINT "payment_batch_previews_tenant_batch_fk" FOREIGN KEY ("tenant_id","batch_id") REFERENCES "public"."payment_batches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_batch_previews" ADD CONSTRAINT "payment_batch_previews_tenant_created_by_fk" FOREIGN KEY ("tenant_id","created_by_user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_batches" ADD CONSTRAINT "payment_batches_tenant_borrower_fk" FOREIGN KEY ("tenant_id","borrower_id") REFERENCES "public"."borrowers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_batches" ADD CONSTRAINT "payment_batches_tenant_created_by_fk" FOREIGN KEY ("tenant_id","created_by_user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_batches" ADD CONSTRAINT "payment_batches_tenant_updated_by_fk" FOREIGN KEY ("tenant_id","updated_by_user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
