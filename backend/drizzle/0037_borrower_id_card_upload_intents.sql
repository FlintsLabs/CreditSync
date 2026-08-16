CREATE TABLE "borrower_id_card_upload_intents" (
	"id" serial PRIMARY KEY NOT NULL,
	"public_id" uuid DEFAULT uuidv7() NOT NULL,
	"tenant_id" text NOT NULL,
	"borrower_id" integer NOT NULL,
	"file_id" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"evidence_hash" text NOT NULL,
	"mime_type" text NOT NULL,
	"declared_size" integer NOT NULL,
	"upload_expires_at" timestamp,
	"finalized_at" timestamp,
	"applied_at" timestamp,
	"apply_request_hash" text,
	"idempotency_key" text,
	"created_by_user_id" integer,
	"updated_by_user_id" integer,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "borrower_id_card_upload_intents_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "borrower_id_card_upload_intents_status_check" CHECK ("borrower_id_card_upload_intents"."status" IN ('pending', 'ready', 'applied')),
	CONSTRAINT "borrower_id_card_upload_intents_evidence_metadata_check" CHECK (
        "borrower_id_card_upload_intents"."evidence_hash" ~ '^[0-9a-f]{64}$'
        AND "borrower_id_card_upload_intents"."mime_type" IN ('image/jpeg', 'image/png')
        AND "borrower_id_card_upload_intents"."declared_size" > 0
    ),
	CONSTRAINT "borrower_id_card_upload_intents_lifecycle_check" CHECK (
        ("borrower_id_card_upload_intents"."status" = 'pending' AND "borrower_id_card_upload_intents"."finalized_at" IS NULL AND "borrower_id_card_upload_intents"."applied_at" IS NULL AND "borrower_id_card_upload_intents"."apply_request_hash" IS NULL AND "borrower_id_card_upload_intents"."idempotency_key" IS NULL)
        OR ("borrower_id_card_upload_intents"."status" = 'ready' AND "borrower_id_card_upload_intents"."finalized_at" IS NOT NULL AND "borrower_id_card_upload_intents"."applied_at" IS NULL AND "borrower_id_card_upload_intents"."apply_request_hash" IS NULL AND "borrower_id_card_upload_intents"."idempotency_key" IS NULL)
        OR ("borrower_id_card_upload_intents"."status" = 'applied' AND "borrower_id_card_upload_intents"."finalized_at" IS NOT NULL AND "borrower_id_card_upload_intents"."applied_at" IS NOT NULL AND "borrower_id_card_upload_intents"."apply_request_hash" ~ '^[0-9a-f]{64}$' AND "borrower_id_card_upload_intents"."idempotency_key" IS NOT NULL AND btrim("borrower_id_card_upload_intents"."idempotency_key") <> '')
    )
);
--> statement-breakpoint
ALTER TABLE "borrower_id_card_upload_intents" ADD CONSTRAINT "borrower_id_card_upload_intents_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "borrower_id_card_upload_intents" ADD CONSTRAINT "borrower_id_card_upload_intents_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "borrower_id_card_upload_intents" ADD CONSTRAINT "borrower_id_card_upload_intents_tenant_borrower_fk" FOREIGN KEY ("tenant_id","borrower_id") REFERENCES "public"."borrowers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "borrower_id_card_upload_intents" ADD CONSTRAINT "borrower_id_card_upload_intents_tenant_file_fk" FOREIGN KEY ("tenant_id","file_id") REFERENCES "public"."files"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "borrower_id_card_upload_intents" ADD CONSTRAINT "borrower_id_card_upload_intents_tenant_created_by_fk" FOREIGN KEY ("tenant_id","created_by_user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "borrower_id_card_upload_intents" ADD CONSTRAINT "borrower_id_card_upload_intents_tenant_updated_by_fk" FOREIGN KEY ("tenant_id","updated_by_user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "borrower_id_card_upload_intents_tenant_public_id_unique" ON "borrower_id_card_upload_intents" USING btree ("tenant_id","public_id");--> statement-breakpoint
CREATE UNIQUE INDEX "borrower_id_card_upload_intents_tenant_hash_unique" ON "borrower_id_card_upload_intents" USING btree ("tenant_id","evidence_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "borrower_id_card_upload_intents_tenant_idempotency_unique" ON "borrower_id_card_upload_intents" USING btree ("tenant_id","idempotency_key") WHERE "borrower_id_card_upload_intents"."idempotency_key" IS NOT NULL;
CREATE FUNCTION enforce_borrower_id_card_upload_intent_lifecycle() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.status <> 'pending' THEN
            RAISE EXCEPTION 'borrower id-card upload intents must be created as pending';
        END IF;
        RETURN NEW;
    END IF;

    IF TG_OP = 'DELETE' THEN
        IF OLD.status <> 'pending' THEN
            RAISE EXCEPTION 'borrower id-card upload intents are immutable after finalization; % is not allowed', TG_OP;
        END IF;
        RETURN OLD;
    END IF;

    IF OLD.status = 'applied' THEN
        RAISE EXCEPTION 'applied borrower id-card upload intents are immutable; % is not allowed', TG_OP;
    END IF;

    IF OLD.status = 'pending' AND NEW.status = 'pending' THEN
        IF to_jsonb(NEW) - 'status' - 'upload_expires_at' - 'updated_by_user_id' - 'updated_at'
            IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'upload_expires_at' - 'updated_by_user_id' - 'updated_at') THEN
            RAISE EXCEPTION 'pending borrower id-card upload intents may only refresh upload expiry and actor metadata';
        END IF;
        RETURN NEW;
    END IF;

    IF OLD.status = 'pending' AND NEW.status = 'ready' THEN
        IF to_jsonb(NEW) - 'status' - 'finalized_at' - 'updated_by_user_id' - 'updated_at'
            IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'finalized_at' - 'updated_by_user_id' - 'updated_at') THEN
            RAISE EXCEPTION 'pending to ready transition may only set finalized_at';
        END IF;
        RETURN NEW;
    END IF;

    IF OLD.status = 'ready' AND NEW.status = 'applied' THEN
        IF to_jsonb(NEW) - 'status' - 'applied_at' - 'apply_request_hash' - 'idempotency_key' - 'updated_by_user_id' - 'updated_at'
            IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'applied_at' - 'apply_request_hash' - 'idempotency_key' - 'updated_by_user_id' - 'updated_at') THEN
            RAISE EXCEPTION 'ready to applied transition may only set apply metadata';
        END IF;
        RETURN NEW;
    END IF;

    RAISE EXCEPTION 'invalid borrower id-card upload intent status transition from % to %', OLD.status, NEW.status;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER borrower_id_card_upload_intents_lifecycle_guard
BEFORE INSERT OR UPDATE OR DELETE ON "borrower_id_card_upload_intents"
FOR EACH ROW EXECUTE FUNCTION enforce_borrower_id_card_upload_intent_lifecycle();
