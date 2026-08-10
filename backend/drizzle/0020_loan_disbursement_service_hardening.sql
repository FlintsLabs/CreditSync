ALTER TABLE "loan_disbursement_events" ADD COLUMN "post_idempotency_key" text;--> statement-breakpoint
ALTER TABLE "loan_disbursement_events" ADD COLUMN "reversal_idempotency_key" text;--> statement-breakpoint
ALTER TABLE "loan_disbursement_events" ADD COLUMN "reversal_request_hash" text;--> statement-breakpoint
CREATE UNIQUE INDEX "loan_disbursement_events_tenant_post_idempotency_unique" ON "loan_disbursement_events" USING btree ("tenant_id", "post_idempotency_key") WHERE "post_idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "loan_disbursement_events_tenant_reversal_idempotency_unique" ON "loan_disbursement_events" USING btree ("tenant_id", "reversal_idempotency_key") WHERE "reversal_idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "loan_disbursement_events_tenant_reversed_event_unique" ON "loan_disbursement_events" USING btree ("tenant_id", "reversed_event_id") WHERE "reversed_event_id" IS NOT NULL;--> statement-breakpoint
CREATE TABLE "loan_disbursement_evidence_intents" (
  "id" serial PRIMARY KEY NOT NULL,
  "public_id" uuid DEFAULT uuidv7() NOT NULL,
  "tenant_id" text NOT NULL,
  "loan_disbursement_event_id" integer NOT NULL,
  "file_id" integer NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "evidence_hash" text NOT NULL,
  "mime_type" text NOT NULL,
  "declared_size" integer NOT NULL,
  "upload_expires_at" timestamp,
  "finalized_at" timestamp,
  "created_by_user_id" integer,
  "updated_by_user_id" integer,
  "created_at" timestamp DEFAULT now(),
  "updated_at" timestamp DEFAULT now(),
  CONSTRAINT "loan_disbursement_evidence_intents_public_id_unique" UNIQUE("public_id"),
  CONSTRAINT "loan_disbursement_evidence_intents_status_check" CHECK ("status" IN ('pending', 'ready')),
  CONSTRAINT "loan_disbursement_evidence_intents_tenant_event_fk" FOREIGN KEY ("tenant_id", "loan_disbursement_event_id") REFERENCES "loan_disbursement_events"("tenant_id", "id"),
  CONSTRAINT "loan_disbursement_evidence_intents_tenant_file_fk" FOREIGN KEY ("tenant_id", "file_id") REFERENCES "files"("tenant_id", "id"),
  CONSTRAINT "loan_disbursement_evidence_intents_created_by_user_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id"),
  CONSTRAINT "loan_disbursement_evidence_intents_updated_by_user_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "users"("id")
);--> statement-breakpoint
CREATE UNIQUE INDEX "loan_disbursement_evidence_intents_tenant_hash_unique" ON "loan_disbursement_evidence_intents" USING btree ("tenant_id", "evidence_hash");
