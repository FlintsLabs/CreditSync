ALTER TABLE "payment_intakes" ADD COLUMN "evidence_required" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "payment_evidence" ADD COLUMN "import_idempotency_key" text;
--> statement-breakpoint
ALTER TABLE "payment_evidence" ADD COLUMN "source_file_fingerprint" text;
--> statement-breakpoint
CREATE UNIQUE INDEX "payment_evidence_tenant_import_idempotency_unique" ON "payment_evidence" USING btree ("tenant_id","import_idempotency_key") WHERE "import_idempotency_key" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE "payment_evidence_supplements" (
	"id" serial PRIMARY KEY NOT NULL,
	"public_id" uuid DEFAULT uuidv7() NOT NULL,
	"tenant_id" text NOT NULL,
	"payment_intake_id" integer NOT NULL,
	"file_id" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"evidence_hash" text,
	"mime_type" text,
	"declared_size" integer,
	"reason" text,
	"note" text,
	"import_idempotency_key" text NOT NULL,
	"source_file_fingerprint" text NOT NULL,
	"record_idempotency_key" text,
	"audit_public_id" uuid,
	"correlation_id" text NOT NULL,
	"created_by_user_id" integer NOT NULL,
	"recorded_by_user_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"ready_at" timestamp,
	"recorded_at" timestamp,
	CONSTRAINT "payment_evidence_supplements_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "payment_evidence_supplements_status_check" CHECK ("status" IN ('draft', 'ready', 'recorded')),
	CONSTRAINT "payment_evidence_supplements_reason_check" CHECK ("reason" IS NULL OR "reason" IN ('upload_channel_unavailable', 'operator_omission', 'evidence_recovered', 'other')),
	CONSTRAINT "payment_evidence_supplements_other_note_check" CHECK ("reason" <> 'other' OR length(btrim("note")) > 0),
	CONSTRAINT "payment_evidence_supplements_ready_fields_check" CHECK (
		("status" = 'draft' AND "evidence_hash" IS NULL AND "mime_type" IS NULL AND "declared_size" IS NULL AND "ready_at" IS NULL)
		OR ("status" IN ('ready', 'recorded') AND "evidence_hash" IS NOT NULL AND "mime_type" IS NOT NULL AND "declared_size" > 0 AND "ready_at" IS NOT NULL)
	),
	CONSTRAINT "payment_evidence_supplements_recorded_fields_check" CHECK (
		("status" <> 'recorded' AND "record_idempotency_key" IS NULL AND "audit_public_id" IS NULL AND "recorded_by_user_id" IS NULL AND "recorded_at" IS NULL)
		OR ("status" = 'recorded' AND "reason" IS NOT NULL AND "record_idempotency_key" IS NOT NULL AND "audit_public_id" IS NOT NULL AND "recorded_by_user_id" IS NOT NULL AND "recorded_at" IS NOT NULL)
	)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "payment_evidence_supplements_tenant_id_id_unique" ON "payment_evidence_supplements" USING btree ("tenant_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "payment_evidence_supplements_tenant_import_idempotency_unique" ON "payment_evidence_supplements" USING btree ("tenant_id","import_idempotency_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "payment_evidence_supplements_tenant_idempotency_unique" ON "payment_evidence_supplements" USING btree ("tenant_id","record_idempotency_key") WHERE "record_idempotency_key" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "payment_evidence_supplements_tenant_intake_status_idx" ON "payment_evidence_supplements" USING btree ("tenant_id","payment_intake_id","status");
--> statement-breakpoint
ALTER TABLE "payment_evidence_supplements" ADD CONSTRAINT "payment_evidence_supplements_tenant_intake_fk" FOREIGN KEY ("tenant_id","payment_intake_id") REFERENCES "public"."payment_intakes"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payment_evidence_supplements" ADD CONSTRAINT "payment_evidence_supplements_tenant_file_fk" FOREIGN KEY ("tenant_id","file_id") REFERENCES "public"."files"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payment_evidence_supplements" ADD CONSTRAINT "payment_evidence_supplements_tenant_created_by_fk" FOREIGN KEY ("tenant_id","created_by_user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payment_evidence_supplements" ADD CONSTRAINT "payment_evidence_supplements_tenant_recorded_by_fk" FOREIGN KEY ("tenant_id","recorded_by_user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payment_evidence_supplements" ADD CONSTRAINT "payment_evidence_supplements_tenant_audit_fk" FOREIGN KEY ("tenant_id","audit_public_id") REFERENCES "public"."audit_logs"("tenant_id","public_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION reject_recorded_payment_evidence_supplement_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF OLD."status" = 'recorded' THEN
		RAISE EXCEPTION 'recorded payment evidence supplements are immutable';
	END IF;
	RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "payment_evidence_supplements_recorded_immutable" BEFORE UPDATE OR DELETE ON "payment_evidence_supplements" FOR EACH ROW EXECUTE FUNCTION reject_recorded_payment_evidence_supplement_mutation();
