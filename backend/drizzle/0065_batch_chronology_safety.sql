CREATE TABLE "payment_batch_staging_items" (
  "id" serial PRIMARY KEY NOT NULL,
  "public_id" uuid DEFAULT uuidv7() NOT NULL,
  "tenant_id" text NOT NULL,
  "batch_id" integer NOT NULL,
  "client_item_key" text NOT NULL,
  "payload_fingerprint" text NOT NULL,
  "amount" numeric,
  "received_at" timestamp with time zone,
  "payer_name" text,
  "bank_reference_hash" text,
  "status" text DEFAULT 'staged' NOT NULL,
  "revision" integer DEFAULT 1 NOT NULL,
  "payment_intake_id" integer,
  "batch_item_id" integer,
  "reviewed_range_from" date,
  "reviewed_range_to" date,
  "reviewed_reason" text,
  "operation_key" text,
  "operation_request_hash" text,
  "operation_result" jsonb,
  "created_by_user_id" integer,
  "updated_by_user_id" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "payment_batch_staging_items_public_id_unique" UNIQUE("public_id"),
  CONSTRAINT "payment_batch_staging_status_check" CHECK ("status" IN ('staged', 'needs_review', 'validated', 'failed')),
  CONSTRAINT "payment_batch_staging_tenant_batch_fk" FOREIGN KEY ("tenant_id", "batch_id") REFERENCES "payment_batches"("tenant_id", "id"),
  CONSTRAINT "payment_batch_staging_tenant_intake_fk" FOREIGN KEY ("tenant_id", "payment_intake_id") REFERENCES "payment_intakes"("tenant_id", "id"),
  CONSTRAINT "payment_batch_staging_tenant_created_by_fk" FOREIGN KEY ("tenant_id", "created_by_user_id") REFERENCES "users"("tenant_id", "id"),
  CONSTRAINT "payment_batch_staging_tenant_updated_by_fk" FOREIGN KEY ("tenant_id", "updated_by_user_id") REFERENCES "users"("tenant_id", "id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "payment_batch_staging_tenant_id_id_unique" ON "payment_batch_staging_items" ("tenant_id", "id");
--> statement-breakpoint
CREATE UNIQUE INDEX "payment_batch_staging_tenant_batch_client_key_unique" ON "payment_batch_staging_items" ("tenant_id", "batch_id", "client_item_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "payment_batch_staging_tenant_batch_operation_unique" ON "payment_batch_staging_items" ("tenant_id", "batch_id", "operation_key") WHERE "operation_key" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "payment_batch_items" ADD COLUMN "staging_item_id" integer;
--> statement-breakpoint
ALTER TABLE "payment_batch_items" ADD CONSTRAINT "payment_batch_items_tenant_staging_fk" FOREIGN KEY ("tenant_id", "staging_item_id") REFERENCES "payment_batch_staging_items"("tenant_id", "id");
--> statement-breakpoint
CREATE INDEX "payment_batch_staging_tenant_batch_received_idx" ON "payment_batch_staging_items" ("tenant_id", "batch_id", "received_at");
--> statement-breakpoint
CREATE TABLE "payment_batch_staging_evidence" (
  "id" serial PRIMARY KEY NOT NULL,
  "public_id" uuid DEFAULT uuidv7() NOT NULL,
  "tenant_id" text NOT NULL,
  "staging_item_id" integer NOT NULL,
  "file_id" integer NOT NULL,
  "evidence_hash" text NOT NULL,
  "mime_type" text NOT NULL,
  "declared_size" integer NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "upload_expires_at" timestamp with time zone,
  "finalized_at" timestamp with time zone,
  "created_by_user_id" integer,
  "updated_by_user_id" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "payment_batch_staging_evidence_public_id_unique" UNIQUE("public_id"),
  CONSTRAINT "payment_batch_staging_evidence_status_check" CHECK ("status" IN ('pending', 'ready', 'rejected')),
  CONSTRAINT "payment_batch_staging_evidence_tenant_item_fk" FOREIGN KEY ("tenant_id", "staging_item_id") REFERENCES "payment_batch_staging_items"("tenant_id", "id"),
  CONSTRAINT "payment_batch_staging_evidence_tenant_file_fk" FOREIGN KEY ("tenant_id", "file_id") REFERENCES "files"("tenant_id", "id"),
  CONSTRAINT "payment_batch_staging_evidence_tenant_created_by_fk" FOREIGN KEY ("tenant_id", "created_by_user_id") REFERENCES "users"("tenant_id", "id"),
  CONSTRAINT "payment_batch_staging_evidence_tenant_updated_by_fk" FOREIGN KEY ("tenant_id", "updated_by_user_id") REFERENCES "users"("tenant_id", "id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "payment_batch_staging_evidence_tenant_id_id_unique" ON "payment_batch_staging_evidence" ("tenant_id", "id");
--> statement-breakpoint
CREATE UNIQUE INDEX "payment_batch_staging_evidence_tenant_hash_unique" ON "payment_batch_staging_evidence" ("tenant_id", "evidence_hash");
--> statement-breakpoint
CREATE UNIQUE INDEX "payment_batch_staging_evidence_item_unique" ON "payment_batch_staging_evidence" ("tenant_id", "staging_item_id");
--> statement-breakpoint
ALTER TABLE "payment_batch_allocations" ALTER COLUMN "schedule_id" DROP NOT NULL;
--> statement-breakpoint
CREATE TABLE "payment_batch_operation_receipts" (
  "id" serial PRIMARY KEY NOT NULL,
  "public_id" uuid DEFAULT uuidv7() NOT NULL,
  "tenant_id" text NOT NULL,
  "batch_id" integer NOT NULL,
  "staging_item_id" integer,
  "operation_type" text NOT NULL,
  "operation_key" text NOT NULL,
  "request_hash" text NOT NULL,
  "result" jsonb NOT NULL,
  "created_by_user_id" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "payment_batch_operation_receipts_public_id_unique" UNIQUE("public_id"),
  CONSTRAINT "payment_batch_operation_receipts_tenant_batch_fk" FOREIGN KEY ("tenant_id", "batch_id") REFERENCES "payment_batches"("tenant_id", "id"),
  CONSTRAINT "payment_batch_operation_receipts_tenant_staging_fk" FOREIGN KEY ("tenant_id", "staging_item_id") REFERENCES "payment_batch_staging_items"("tenant_id", "id"),
  CONSTRAINT "payment_batch_operation_receipts_tenant_created_by_fk" FOREIGN KEY ("tenant_id", "created_by_user_id") REFERENCES "users"("tenant_id", "id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "payment_batch_operation_receipts_tenant_id_id_unique" ON "payment_batch_operation_receipts" ("tenant_id", "id");
--> statement-breakpoint
CREATE UNIQUE INDEX "payment_batch_operation_receipts_tenant_operation_unique" ON "payment_batch_operation_receipts" ("tenant_id", "operation_type", "operation_key");
--> statement-breakpoint
CREATE FUNCTION reject_payment_batch_receipt_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
    RAISE EXCEPTION 'payment batch operation receipts are append-only' USING ERRCODE = '23514';
END; $$;
--> statement-breakpoint
CREATE TRIGGER payment_batch_receipts_immutable BEFORE UPDATE OR DELETE ON payment_batch_operation_receipts
FOR EACH ROW EXECUTE FUNCTION reject_payment_batch_receipt_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION reject_ready_payment_batch_staging_evidence_mutation() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'ready' THEN
    RAISE EXCEPTION 'ready payment batch staging evidence is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER payment_batch_staging_evidence_ready_immutable
BEFORE UPDATE ON "payment_batch_staging_evidence"
FOR EACH ROW EXECUTE FUNCTION reject_ready_payment_batch_staging_evidence_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION reject_ready_payment_batch_staging_evidence_delete() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'ready' THEN
    RAISE EXCEPTION 'ready payment batch staging evidence is immutable';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER payment_batch_staging_evidence_ready_delete_immutable
BEFORE DELETE ON "payment_batch_staging_evidence"
FOR EACH ROW EXECUTE FUNCTION reject_ready_payment_batch_staging_evidence_delete();
--> statement-breakpoint
-- Prior guards returned OLD for permitted updates, silently discarding lifecycle changes.
-- Preserve the posted boundary while returning the proposed row for permitted updates.
CREATE OR REPLACE FUNCTION payment_batch_posted_immutable_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE old_row jsonb := to_jsonb(OLD);
BEGIN
    IF TG_TABLE_NAME = 'payment_batches' AND TG_OP <> 'INSERT' AND old_row->>'status' = 'posted' THEN
        RAISE EXCEPTION 'posted payment batch is immutable' USING ERRCODE = '23514';
    ELSIF TG_TABLE_NAME IN ('payment_batch_items', 'payment_batch_previews') AND EXISTS (
        SELECT 1 FROM payment_batches b WHERE b.tenant_id = COALESCE(NEW.tenant_id, OLD.tenant_id)
        AND b.id IN (
            CASE WHEN TG_OP <> 'INSERT' THEN (old_row->>'batch_id')::integer END,
            CASE WHEN TG_OP <> 'DELETE' THEN (to_jsonb(NEW)->>'batch_id')::integer END
        ) AND b.status = 'posted'
    ) THEN
        RAISE EXCEPTION 'posted payment batch member is immutable' USING ERRCODE = '23514';
    ELSIF TG_TABLE_NAME = 'payment_batch_allocations' AND EXISTS (
        SELECT 1 FROM payment_batch_previews p JOIN payment_batches b ON b.tenant_id = p.tenant_id AND b.id = p.batch_id
        WHERE p.tenant_id = COALESCE(NEW.tenant_id, OLD.tenant_id) AND p.id IN (
            CASE WHEN TG_OP <> 'INSERT' THEN (old_row->>'preview_id')::integer END,
            CASE WHEN TG_OP <> 'DELETE' THEN (to_jsonb(NEW)->>'preview_id')::integer END
        ) AND b.status = 'posted'
    ) THEN
        RAISE EXCEPTION 'posted payment batch allocation is immutable' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS payment_batch_item_posted_immutable ON payment_batch_items;
DROP TRIGGER IF EXISTS payment_batch_preview_posted_immutable ON payment_batch_previews;
DROP TRIGGER IF EXISTS payment_batch_allocation_posted_immutable ON payment_batch_allocations;
CREATE TRIGGER payment_batch_item_posted_immutable BEFORE INSERT OR UPDATE OR DELETE ON payment_batch_items
FOR EACH ROW EXECUTE FUNCTION payment_batch_posted_immutable_guard();
CREATE TRIGGER payment_batch_preview_posted_immutable BEFORE INSERT OR UPDATE OR DELETE ON payment_batch_previews
FOR EACH ROW EXECUTE FUNCTION payment_batch_posted_immutable_guard();
CREATE TRIGGER payment_batch_allocation_posted_immutable BEFORE INSERT OR UPDATE OR DELETE ON payment_batch_allocations
FOR EACH ROW EXECUTE FUNCTION payment_batch_posted_immutable_guard();
