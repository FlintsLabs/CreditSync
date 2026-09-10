ALTER TABLE "payment_batch_previews" ADD COLUMN "allocation_snapshot_hash" text;
--> statement-breakpoint
ALTER TABLE "payment_batches" ADD COLUMN "cancel_idempotency_key" text;
--> statement-breakpoint
ALTER TABLE "payment_batches" ADD COLUMN "cancel_request_hash" text;
--> statement-breakpoint
ALTER TABLE "payment_batches" ADD COLUMN "cancel_reason" text;
--> statement-breakpoint
ALTER TABLE "payment_batches" ADD COLUMN "cancel_revision" integer;
--> statement-breakpoint
ALTER TABLE "payment_batches" ADD CONSTRAINT "payment_batches_cancel_lifecycle_check" CHECK ((status = 'cancelled' AND cancel_idempotency_key IS NOT NULL AND cancel_request_hash IS NOT NULL AND cancel_reason IS NOT NULL AND length(trim(cancel_reason)) > 0 AND cancel_revision IS NOT NULL) OR (status <> 'cancelled' AND cancel_idempotency_key IS NULL AND cancel_request_hash IS NULL AND cancel_reason IS NULL AND cancel_revision IS NULL)) NOT VALID;
--> statement-breakpoint
ALTER TABLE "payment_batch_previews" ADD COLUMN "posting_sequence" jsonb;
--> statement-breakpoint
ALTER TABLE "payment_batch_allocations" ADD COLUMN "target_kind" text DEFAULT 'scheduled' NOT NULL;
--> statement-breakpoint
ALTER TABLE "payment_batch_allocations" ADD COLUMN "floating_plan" jsonb;
--> statement-breakpoint
ALTER TABLE "payment_batch_allocations" ADD CONSTRAINT "payment_batch_allocations_target_check" CHECK ((
    (target_kind = 'scheduled' AND schedule_id IS NOT NULL AND floating_plan IS NULL)
    OR (target_kind = 'floating' AND schedule_id IS NULL AND floating_plan IS NOT NULL
        AND jsonb_typeof(floating_plan) = 'object'
        AND floating_plan ? 'throughDate'
        AND jsonb_typeof(floating_plan->'allocations') = 'array')
) IS TRUE);
--> statement-breakpoint
CREATE INDEX "payment_intakes_chronology_pending_idx" ON "payment_intakes" ("tenant_id", "received_at", "origin_loan_id") WHERE status NOT IN ('posted', 'reversed', 'cancelled', 'rejected');
--> statement-breakpoint
CREATE INDEX "payment_batch_borrower_pending_idx" ON "payment_batches" ("tenant_id", "borrower_id") WHERE status NOT IN ('posted', 'cancelled');
--> statement-breakpoint
CREATE TABLE "payment_batch_decisions" (
    "id" serial PRIMARY KEY,
    "public_id" uuid DEFAULT uuidv7() NOT NULL UNIQUE,
    "tenant_id" text NOT NULL,
    "batch_id" integer NOT NULL,
    "preview_id" integer NOT NULL,
    "revision" integer NOT NULL,
    "action" text NOT NULL CHECK (action = 'confirm_no_older_pending'),
    "reason" text NOT NULL,
    "from_date" date NOT NULL,
    "to_date" date NOT NULL,
    "preview_hash" text NOT NULL,
    "created_by_user_id" integer,
    "created_at" timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT "payment_batch_decisions_reason_range_check" CHECK (length(trim(reason)) > 0 AND from_date <= to_date),
    CONSTRAINT "payment_batch_decisions_tenant_batch_fk" FOREIGN KEY (tenant_id, batch_id) REFERENCES payment_batches(tenant_id, id),
    CONSTRAINT "payment_batch_decisions_tenant_preview_fk" FOREIGN KEY (tenant_id, preview_id) REFERENCES payment_batch_previews(tenant_id, id),
    CONSTRAINT "payment_batch_decisions_tenant_actor_fk" FOREIGN KEY (tenant_id, created_by_user_id) REFERENCES users(tenant_id, id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "payment_batch_decisions_tenant_id_id_unique" ON "payment_batch_decisions" (tenant_id, id);
--> statement-breakpoint
CREATE TRIGGER "payment_batch_decisions_immutable" BEFORE UPDATE OR DELETE ON "payment_batch_decisions" FOR EACH ROW EXECUTE FUNCTION reject_payment_batch_receipt_mutation();
