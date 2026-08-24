CREATE TABLE "loan_schedule_deferrals" (
    "id" serial PRIMARY KEY NOT NULL,
    "public_id" uuid DEFAULT uuidv7() NOT NULL,
    "tenant_id" text NOT NULL,
    "loan_id" integer NOT NULL,
    "source_schedule_id" integer NOT NULL,
    "replacement_schedule_id" integer NOT NULL,
    "reason" text NOT NULL,
    "idempotency_key" text NOT NULL,
    "request_id" text NOT NULL,
    "correlation_id" text NOT NULL,
    "actor_source" text DEFAULT 'web' NOT NULL,
    "created_by_user_id" integer NOT NULL,
    "created_at" timestamp DEFAULT now() NOT NULL,
    CONSTRAINT "loan_schedule_deferrals_public_id_unique" UNIQUE("public_id"),
    CONSTRAINT "loan_schedule_deferrals_actor_source_check" CHECK ("actor_source" IN ('web', 'mcp', 'system')),
    CONSTRAINT "loan_schedule_deferrals_reason_check" CHECK (length(btrim("reason")) > 0)
);
--> statement-breakpoint
ALTER TABLE "loan_schedule_deferrals" ADD CONSTRAINT "loan_schedule_deferrals_tenant_loan_fk" FOREIGN KEY ("tenant_id","loan_id") REFERENCES "public"."loans"("tenant_id","id");
--> statement-breakpoint
ALTER TABLE "loan_schedule_deferrals" ADD CONSTRAINT "loan_schedule_deferrals_tenant_source_schedule_fk" FOREIGN KEY ("tenant_id","source_schedule_id") REFERENCES "public"."loan_schedules"("tenant_id","id");
--> statement-breakpoint
ALTER TABLE "loan_schedule_deferrals" ADD CONSTRAINT "loan_schedule_deferrals_tenant_replacement_schedule_fk" FOREIGN KEY ("tenant_id","replacement_schedule_id") REFERENCES "public"."loan_schedules"("tenant_id","id");
--> statement-breakpoint
ALTER TABLE "loan_schedule_deferrals" ADD CONSTRAINT "loan_schedule_deferrals_tenant_actor_fk" FOREIGN KEY ("tenant_id","created_by_user_id") REFERENCES "public"."users"("tenant_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "loan_schedule_deferrals_tenant_id_id_unique" ON "loan_schedule_deferrals" USING btree ("tenant_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "loan_schedule_deferrals_tenant_idempotency_unique" ON "loan_schedule_deferrals" USING btree ("tenant_id","idempotency_key");
--> statement-breakpoint
CREATE FUNCTION reject_loan_schedule_deferral_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'loan schedule deferrals are append-only; UPDATE or DELETE is not allowed';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER loan_schedule_deferrals_append_only
BEFORE UPDATE OR DELETE ON "loan_schedule_deferrals"
FOR EACH ROW EXECUTE FUNCTION reject_loan_schedule_deferral_mutation();
