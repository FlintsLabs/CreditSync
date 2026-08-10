CREATE TABLE "intermediaries" (
    "id" serial PRIMARY KEY NOT NULL,
    "public_id" uuid DEFAULT uuidv7() NOT NULL UNIQUE,
    "tenant_id" text NOT NULL,
    "owner_user_id" integer,
    "name" text NOT NULL,
    "normalized_name" text NOT NULL,
    "aliases" jsonb DEFAULT '[]'::jsonb NOT NULL,
    "notes" text,
    "status" text DEFAULT 'active' NOT NULL,
    "created_by_user_id" integer,
    "updated_by_user_id" integer,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL,
    CONSTRAINT "intermediaries_status_check" CHECK ("status" IN ('active', 'inactive'))
);--> statement-breakpoint
CREATE TABLE "intermediary_collections" (
    "id" serial PRIMARY KEY NOT NULL,
    "public_id" uuid DEFAULT uuidv7() NOT NULL UNIQUE,
    "tenant_id" text NOT NULL,
    "owner_user_id" integer,
    "intermediary_id" integer NOT NULL,
    "borrower_id" integer NOT NULL,
    "loan_id" integer NOT NULL,
    "amount" numeric NOT NULL,
    "borrower_paid_at" timestamp NOT NULL,
    "status" text DEFAULT 'pending_remittance' NOT NULL,
    "idempotency_key" text NOT NULL,
    "bank_reference" text,
    "bank_reference_hash" text,
    "note" text,
    "manual_approval_reason" text,
    "posted_payment_intake_id" integer,
    "created_by_user_id" integer,
    "updated_by_user_id" integer,
    "approved_by_user_id" integer,
    "settled_at" timestamp,
    "reversed_at" timestamp,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL,
    CONSTRAINT "intermediary_collections_status_check" CHECK ("status" IN ('pending_remittance', 'allocated', 'settled', 'manual_approved', 'reversed')),
    CONSTRAINT "intermediary_collections_amount_check" CHECK ("amount" > 0)
);--> statement-breakpoint
CREATE TABLE "intermediary_remittances" (
    "id" serial PRIMARY KEY NOT NULL,
    "public_id" uuid DEFAULT uuidv7() NOT NULL UNIQUE,
    "tenant_id" text NOT NULL,
    "owner_user_id" integer,
    "intermediary_id" integer NOT NULL,
    "gross_amount" numeric NOT NULL,
    "received_at" timestamp NOT NULL,
    "bank_reference" text,
    "bank_reference_hash" text,
    "destination_hint" text,
    "note" text,
    "status" text DEFAULT 'draft' NOT NULL,
    "idempotency_key" text NOT NULL,
    "post_idempotency_key" text,
    "reversal_idempotency_key" text,
    "reversal_reason" text,
    "created_by_user_id" integer,
    "updated_by_user_id" integer,
    "posted_by_user_id" integer,
    "reversed_by_user_id" integer,
    "posted_at" timestamp,
    "reversed_at" timestamp,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL,
    CONSTRAINT "intermediary_remittances_status_check" CHECK ("status" IN ('draft', 'needs_review', 'ready', 'posted', 'reversed')),
    CONSTRAINT "intermediary_remittances_amount_check" CHECK ("gross_amount" > 0)
);--> statement-breakpoint
CREATE TABLE "intermediary_remittance_allocations" (
    "id" serial PRIMARY KEY NOT NULL,
    "public_id" uuid DEFAULT uuidv7() NOT NULL UNIQUE,
    "tenant_id" text NOT NULL,
    "remittance_id" integer NOT NULL,
    "collection_id" integer NOT NULL,
    "allocation_order" integer NOT NULL,
    "released_at" timestamp,
    "created_by_user_id" integer,
    "created_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "intermediary_remittance_proposals" (
    "id" serial PRIMARY KEY NOT NULL,
    "public_id" uuid DEFAULT uuidv7() NOT NULL UNIQUE,
    "tenant_id" text NOT NULL,
    "remittance_id" integer NOT NULL,
    "version" integer NOT NULL,
    "status" text NOT NULL,
    "selected_total" numeric NOT NULL,
    "remaining_balance" numeric NOT NULL,
    "state_hash" text NOT NULL,
    "warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
    "expires_at" timestamp NOT NULL,
    "created_by_user_id" integer,
    "created_at" timestamp DEFAULT now() NOT NULL,
    CONSTRAINT "intermediary_remittance_proposals_status_check" CHECK ("status" IN ('needs_review', 'ready', 'stale', 'expired'))
);--> statement-breakpoint

-- Referenced composite keys must exist before PostgreSQL accepts the tenant-safe foreign keys below.
CREATE UNIQUE INDEX "intermediaries_tenant_id_id_unique" ON "intermediaries" ("tenant_id", "id");--> statement-breakpoint
CREATE UNIQUE INDEX "intermediary_collections_tenant_id_id_unique" ON "intermediary_collections" ("tenant_id", "id");--> statement-breakpoint
CREATE UNIQUE INDEX "intermediary_remittances_tenant_id_id_unique" ON "intermediary_remittances" ("tenant_id", "id");--> statement-breakpoint

ALTER TABLE "intermediaries" ADD CONSTRAINT "intermediaries_tenant_owner_fk" FOREIGN KEY ("tenant_id", "owner_user_id") REFERENCES "users"("tenant_id", "id");--> statement-breakpoint
ALTER TABLE "intermediaries" ADD CONSTRAINT "intermediaries_tenant_created_by_fk" FOREIGN KEY ("tenant_id", "created_by_user_id") REFERENCES "users"("tenant_id", "id");--> statement-breakpoint
ALTER TABLE "intermediaries" ADD CONSTRAINT "intermediaries_tenant_updated_by_fk" FOREIGN KEY ("tenant_id", "updated_by_user_id") REFERENCES "users"("tenant_id", "id");--> statement-breakpoint
ALTER TABLE "intermediary_collections" ADD CONSTRAINT "intermediary_collections_tenant_owner_fk" FOREIGN KEY ("tenant_id", "owner_user_id") REFERENCES "users"("tenant_id", "id");--> statement-breakpoint
ALTER TABLE "intermediary_collections" ADD CONSTRAINT "intermediary_collections_tenant_intermediary_fk" FOREIGN KEY ("tenant_id", "intermediary_id") REFERENCES "intermediaries"("tenant_id", "id");--> statement-breakpoint
ALTER TABLE "intermediary_collections" ADD CONSTRAINT "intermediary_collections_tenant_borrower_fk" FOREIGN KEY ("tenant_id", "borrower_id") REFERENCES "borrowers"("tenant_id", "id");--> statement-breakpoint
ALTER TABLE "intermediary_collections" ADD CONSTRAINT "intermediary_collections_tenant_loan_fk" FOREIGN KEY ("tenant_id", "loan_id") REFERENCES "loans"("tenant_id", "id");--> statement-breakpoint
ALTER TABLE "intermediary_collections" ADD CONSTRAINT "intermediary_collections_tenant_payment_intake_fk" FOREIGN KEY ("tenant_id", "posted_payment_intake_id") REFERENCES "payment_intakes"("tenant_id", "id");--> statement-breakpoint
ALTER TABLE "intermediary_collections" ADD CONSTRAINT "intermediary_collections_tenant_created_by_fk" FOREIGN KEY ("tenant_id", "created_by_user_id") REFERENCES "users"("tenant_id", "id");--> statement-breakpoint
ALTER TABLE "intermediary_collections" ADD CONSTRAINT "intermediary_collections_tenant_updated_by_fk" FOREIGN KEY ("tenant_id", "updated_by_user_id") REFERENCES "users"("tenant_id", "id");--> statement-breakpoint
ALTER TABLE "intermediary_collections" ADD CONSTRAINT "intermediary_collections_tenant_approved_by_fk" FOREIGN KEY ("tenant_id", "approved_by_user_id") REFERENCES "users"("tenant_id", "id");--> statement-breakpoint
ALTER TABLE "intermediary_remittances" ADD CONSTRAINT "intermediary_remittances_tenant_owner_fk" FOREIGN KEY ("tenant_id", "owner_user_id") REFERENCES "users"("tenant_id", "id");--> statement-breakpoint
ALTER TABLE "intermediary_remittances" ADD CONSTRAINT "intermediary_remittances_tenant_intermediary_fk" FOREIGN KEY ("tenant_id", "intermediary_id") REFERENCES "intermediaries"("tenant_id", "id");--> statement-breakpoint
ALTER TABLE "intermediary_remittances" ADD CONSTRAINT "intermediary_remittances_tenant_created_by_fk" FOREIGN KEY ("tenant_id", "created_by_user_id") REFERENCES "users"("tenant_id", "id");--> statement-breakpoint
ALTER TABLE "intermediary_remittances" ADD CONSTRAINT "intermediary_remittances_tenant_updated_by_fk" FOREIGN KEY ("tenant_id", "updated_by_user_id") REFERENCES "users"("tenant_id", "id");--> statement-breakpoint
ALTER TABLE "intermediary_remittances" ADD CONSTRAINT "intermediary_remittances_tenant_posted_by_fk" FOREIGN KEY ("tenant_id", "posted_by_user_id") REFERENCES "users"("tenant_id", "id");--> statement-breakpoint
ALTER TABLE "intermediary_remittances" ADD CONSTRAINT "intermediary_remittances_tenant_reversed_by_fk" FOREIGN KEY ("tenant_id", "reversed_by_user_id") REFERENCES "users"("tenant_id", "id");--> statement-breakpoint
ALTER TABLE "intermediary_remittance_allocations" ADD CONSTRAINT "intermediary_allocations_tenant_remittance_fk" FOREIGN KEY ("tenant_id", "remittance_id") REFERENCES "intermediary_remittances"("tenant_id", "id");--> statement-breakpoint
ALTER TABLE "intermediary_remittance_allocations" ADD CONSTRAINT "intermediary_allocations_tenant_collection_fk" FOREIGN KEY ("tenant_id", "collection_id") REFERENCES "intermediary_collections"("tenant_id", "id");--> statement-breakpoint
ALTER TABLE "intermediary_remittance_allocations" ADD CONSTRAINT "intermediary_allocations_tenant_created_by_fk" FOREIGN KEY ("tenant_id", "created_by_user_id") REFERENCES "users"("tenant_id", "id");--> statement-breakpoint
ALTER TABLE "intermediary_remittance_proposals" ADD CONSTRAINT "intermediary_proposals_tenant_remittance_fk" FOREIGN KEY ("tenant_id", "remittance_id") REFERENCES "intermediary_remittances"("tenant_id", "id");--> statement-breakpoint
ALTER TABLE "intermediary_remittance_proposals" ADD CONSTRAINT "intermediary_proposals_tenant_created_by_fk" FOREIGN KEY ("tenant_id", "created_by_user_id") REFERENCES "users"("tenant_id", "id");--> statement-breakpoint

CREATE UNIQUE INDEX "intermediaries_tenant_normalized_name_unique" ON "intermediaries" ("tenant_id", "normalized_name");--> statement-breakpoint
CREATE UNIQUE INDEX "intermediary_collections_tenant_idempotency_unique" ON "intermediary_collections" ("tenant_id", "idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "intermediary_collections_tenant_bank_reference_unique" ON "intermediary_collections" ("tenant_id", "bank_reference_hash") WHERE "bank_reference_hash" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "intermediary_collections_tenant_intermediary_status_idx" ON "intermediary_collections" ("tenant_id", "intermediary_id", "status");--> statement-breakpoint
CREATE UNIQUE INDEX "intermediary_remittances_tenant_idempotency_unique" ON "intermediary_remittances" ("tenant_id", "idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "intermediary_remittances_tenant_bank_reference_unique" ON "intermediary_remittances" ("tenant_id", "bank_reference_hash") WHERE "bank_reference_hash" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "intermediary_remittances_tenant_post_key_unique" ON "intermediary_remittances" ("tenant_id", "post_idempotency_key") WHERE "post_idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "intermediary_remittances_tenant_reversal_key_unique" ON "intermediary_remittances" ("tenant_id", "reversal_idempotency_key") WHERE "reversal_idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "intermediary_remittances_tenant_intermediary_status_idx" ON "intermediary_remittances" ("tenant_id", "intermediary_id", "status");--> statement-breakpoint
CREATE UNIQUE INDEX "intermediary_remittance_allocations_tenant_id_id_unique" ON "intermediary_remittance_allocations" ("tenant_id", "id");--> statement-breakpoint
CREATE UNIQUE INDEX "intermediary_allocations_active_collection_unique" ON "intermediary_remittance_allocations" ("tenant_id", "collection_id") WHERE "released_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "intermediary_allocations_remittance_collection_unique" ON "intermediary_remittance_allocations" ("tenant_id", "remittance_id", "collection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "intermediary_remittance_proposals_tenant_id_id_unique" ON "intermediary_remittance_proposals" ("tenant_id", "id");--> statement-breakpoint
CREATE UNIQUE INDEX "intermediary_remittance_proposals_version_unique" ON "intermediary_remittance_proposals" ("tenant_id", "remittance_id", "version");--> statement-breakpoint

CREATE FUNCTION reject_immutable_intermediary_financial_mutation() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' AND OLD.status IN ('settled', 'manual_approved', 'posted', 'reversed') THEN
        RAISE EXCEPTION 'immutable intermediary financial records cannot be deleted';
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.status IN ('settled', 'manual_approved', 'posted', 'reversed') THEN
        IF TG_TABLE_NAME = 'intermediary_collections'
            AND OLD.status IN ('settled', 'manual_approved') AND NEW.status = 'reversed'
            AND (to_jsonb(NEW) - ARRAY['status', 'reversed_at', 'updated_by_user_id', 'updated_at'])
                = (to_jsonb(OLD) - ARRAY['status', 'reversed_at', 'updated_by_user_id', 'updated_at']) THEN
            RETURN NEW;
        END IF;
        IF TG_TABLE_NAME = 'intermediary_remittances'
            AND OLD.status = 'posted' AND NEW.status = 'reversed'
            AND (to_jsonb(NEW) - ARRAY['status', 'reversal_idempotency_key', 'reversal_reason', 'reversed_by_user_id', 'reversed_at', 'updated_by_user_id', 'updated_at'])
                = (to_jsonb(OLD) - ARRAY['status', 'reversal_idempotency_key', 'reversal_reason', 'reversed_by_user_id', 'reversed_at', 'updated_by_user_id', 'updated_at']) THEN
            RETURN NEW;
        END IF;
        RAISE EXCEPTION 'immutable intermediary financial records cannot be updated';
    END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER intermediary_collections_immutable BEFORE UPDATE OR DELETE ON "intermediary_collections"
FOR EACH ROW EXECUTE FUNCTION reject_immutable_intermediary_financial_mutation();--> statement-breakpoint
CREATE TRIGGER intermediary_remittances_immutable BEFORE UPDATE OR DELETE ON "intermediary_remittances"
FOR EACH ROW EXECUTE FUNCTION reject_immutable_intermediary_financial_mutation();
