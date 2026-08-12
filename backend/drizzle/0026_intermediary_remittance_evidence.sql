ALTER TABLE "intermediary_collections" ADD COLUMN "payment_intake_preexisting" boolean DEFAULT false NOT NULL;

CREATE OR REPLACE FUNCTION reject_immutable_intermediary_financial_mutation() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' AND OLD.status IN ('settled', 'manual_approved', 'posted', 'reversed') THEN
        RAISE EXCEPTION 'immutable intermediary financial records cannot be deleted';
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.status IN ('settled', 'manual_approved', 'posted', 'reversed') THEN
        IF TG_TABLE_NAME = 'intermediary_collections'
            AND OLD.status IN ('settled', 'manual_approved') AND NEW.status = 'reversed'
            AND (to_jsonb(NEW) - ARRAY['status', 'reversed_at', 'updated_by_user_id', 'updated_at']) = (to_jsonb(OLD) - ARRAY['status', 'reversed_at', 'updated_by_user_id', 'updated_at']) THEN RETURN NEW;
        END IF;
        IF TG_TABLE_NAME = 'intermediary_collections'
            AND OLD.status = 'settled' AND COALESCE((to_jsonb(OLD)->>'payment_intake_preexisting')::boolean, false) AND NEW.status = 'pending_remittance'
            AND (to_jsonb(NEW) - ARRAY['status', 'settled_at', 'reversed_at', 'updated_by_user_id', 'updated_at']) = (to_jsonb(OLD) - ARRAY['status', 'settled_at', 'reversed_at', 'updated_by_user_id', 'updated_at']) THEN RETURN NEW;
        END IF;
        IF TG_TABLE_NAME = 'intermediary_remittances'
            AND OLD.status = 'posted' AND NEW.status = 'reversed'
            AND (to_jsonb(NEW) - ARRAY['status', 'reversal_idempotency_key', 'reversal_reason', 'reversed_by_user_id', 'reversed_at', 'updated_by_user_id', 'updated_at']) = (to_jsonb(OLD) - ARRAY['status', 'reversal_idempotency_key', 'reversal_reason', 'reversed_by_user_id', 'reversed_at', 'updated_by_user_id', 'updated_at']) THEN RETURN NEW;
        END IF;
        RAISE EXCEPTION 'immutable intermediary financial records cannot be updated';
    END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE "intermediary_remittance_evidence" (
  "id" serial PRIMARY KEY NOT NULL,
  "tenant_id" text NOT NULL,
  "remittance_id" integer NOT NULL,
  "file_id" integer NOT NULL,
  "created_at" timestamp DEFAULT now()
);--> statement-breakpoint
CREATE TABLE "intermediary_remittance_evidence_intents" (
  "id" serial PRIMARY KEY NOT NULL,
  "public_id" uuid DEFAULT uuidv7() NOT NULL UNIQUE,
  "tenant_id" text NOT NULL,
  "remittance_id" integer NOT NULL,
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
  CONSTRAINT "intermediary_remittance_evidence_intents_status_check" CHECK ("status" IN ('pending', 'ready'))
);--> statement-breakpoint
CREATE UNIQUE INDEX "intermediary_remittance_evidence_remittance_file_unique" ON "intermediary_remittance_evidence" ("remittance_id", "file_id");--> statement-breakpoint
CREATE UNIQUE INDEX "intermediary_remittance_evidence_intents_tenant_hash_unique" ON "intermediary_remittance_evidence_intents" ("tenant_id", "evidence_hash");--> statement-breakpoint
ALTER TABLE "intermediary_remittance_evidence" ADD CONSTRAINT "intermediary_remittance_evidence_tenant_remittance_fk" FOREIGN KEY ("tenant_id", "remittance_id") REFERENCES "intermediary_remittances"("tenant_id", "id");--> statement-breakpoint
ALTER TABLE "intermediary_remittance_evidence" ADD CONSTRAINT "intermediary_remittance_evidence_tenant_file_fk" FOREIGN KEY ("tenant_id", "file_id") REFERENCES "files"("tenant_id", "id");--> statement-breakpoint
ALTER TABLE "intermediary_remittance_evidence_intents" ADD CONSTRAINT "intermediary_remittance_evidence_intents_tenant_remittance_fk" FOREIGN KEY ("tenant_id", "remittance_id") REFERENCES "intermediary_remittances"("tenant_id", "id");--> statement-breakpoint
ALTER TABLE "intermediary_remittance_evidence_intents" ADD CONSTRAINT "intermediary_remittance_evidence_intents_tenant_file_fk" FOREIGN KEY ("tenant_id", "file_id") REFERENCES "files"("tenant_id", "id");--> statement-breakpoint
ALTER TABLE "intermediary_remittance_evidence_intents" ADD CONSTRAINT "intermediary_remittance_evidence_intents_tenant_created_by_fk" FOREIGN KEY ("tenant_id", "created_by_user_id") REFERENCES "users"("tenant_id", "id");--> statement-breakpoint
ALTER TABLE "intermediary_remittance_evidence_intents" ADD CONSTRAINT "intermediary_remittance_evidence_intents_tenant_updated_by_fk" FOREIGN KEY ("tenant_id", "updated_by_user_id") REFERENCES "users"("tenant_id", "id");
