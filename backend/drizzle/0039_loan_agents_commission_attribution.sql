CREATE TABLE "loan_commission_participants" (
    "id" serial PRIMARY KEY NOT NULL,
    "public_id" uuid DEFAULT uuidv7() NOT NULL UNIQUE,
    "tenant_id" text NOT NULL,
    "loan_id" integer NOT NULL,
    "intermediary_id" integer NOT NULL,
    "previous_participant_id" integer,
    "commission_rate" numeric(7,4) NOT NULL,
    "role" text NOT NULL,
    "note" text,
    "effective_from" timestamp with time zone NOT NULL,
    "effective_to" timestamp with time zone,
    "status" text NOT NULL,
    "idempotency_key" text NOT NULL,
    "audit_public_id" uuid NOT NULL,
    "actor_source" text NOT NULL,
    "request_id" text NOT NULL,
    "correlation_id" text NOT NULL,
    "created_by_user_id" integer,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "loan_commission_participants_rate_check" CHECK ("commission_rate" > 0 AND "commission_rate" <= 100 AND scale("commission_rate") <= 4),
    CONSTRAINT "loan_commission_participants_status_check" CHECK ("status" IN ('active', 'ended')),
    CONSTRAINT "loan_commission_participants_role_check" CHECK ("role" ~ '[^[:space:]]'),
    CONSTRAINT "loan_commission_participants_idempotency_check" CHECK ("idempotency_key" ~ '[^[:space:]]'),
    CONSTRAINT "loan_commission_participants_dates_check" CHECK (("status" = 'active' AND "effective_to" IS NULL) OR ("status" = 'ended' AND "effective_to" IS NOT NULL AND "effective_to" > "effective_from")),
    CONSTRAINT "loan_commission_participants_tenant_loan_fk" FOREIGN KEY ("tenant_id", "loan_id") REFERENCES "loans"("tenant_id", "id"),
    CONSTRAINT "loan_commission_participants_tenant_intermediary_fk" FOREIGN KEY ("tenant_id", "intermediary_id") REFERENCES "intermediaries"("tenant_id", "id"),
    CONSTRAINT "loan_commission_participants_tenant_audit_fk" FOREIGN KEY ("tenant_id", "audit_public_id") REFERENCES "audit_logs"("tenant_id", "public_id"),
    CONSTRAINT "loan_commission_participants_tenant_actor_fk" FOREIGN KEY ("tenant_id", "created_by_user_id") REFERENCES "users"("tenant_id", "id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "loan_commission_participants_tenant_id_id_unique" ON "loan_commission_participants" ("tenant_id", "id");
--> statement-breakpoint
ALTER TABLE "loan_commission_participants" ADD CONSTRAINT "loan_commission_participants_tenant_previous_fk" FOREIGN KEY ("tenant_id", "previous_participant_id") REFERENCES "loan_commission_participants"("tenant_id", "id");
--> statement-breakpoint
CREATE UNIQUE INDEX "loan_commission_participants_tenant_idempotency_unique" ON "loan_commission_participants" ("tenant_id", "idempotency_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "loan_commission_participants_tenant_previous_unique" ON "loan_commission_participants" ("tenant_id", "previous_participant_id") WHERE "previous_participant_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "loan_commission_participants_tenant_loan_effective_idx" ON "loan_commission_participants" ("tenant_id", "loan_id", "effective_from");
--> statement-breakpoint
CREATE TABLE "payment_intermediary_attributions" (
    "id" serial PRIMARY KEY NOT NULL,
    "public_id" uuid DEFAULT uuidv7() NOT NULL UNIQUE,
    "tenant_id" text NOT NULL,
    "payment_id" integer NOT NULL,
    "transaction_id" integer,
    "intermediary_id" integer,
    "source_kind" text NOT NULL,
    "attributed_amount" numeric(31,2) NOT NULL,
    "reason" text,
    "reversed_attribution_id" integer,
    "idempotency_key" text NOT NULL,
    "audit_public_id" uuid NOT NULL,
    "actor_source" text NOT NULL,
    "request_id" text NOT NULL,
    "correlation_id" text NOT NULL,
    "created_by_user_id" integer,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "payment_intermediary_attributions_source_check" CHECK (("source_kind" = 'direct' AND "intermediary_id" IS NULL) OR ("source_kind" = 'intermediary' AND "intermediary_id" IS NOT NULL)),
    CONSTRAINT "payment_intermediary_attributions_amount_check" CHECK (scale("attributed_amount") <= 2 AND "attributed_amount" <> 0),
    CONSTRAINT "payment_intermediary_attributions_reversal_check" CHECK (("attributed_amount" > 0 AND "reversed_attribution_id" IS NULL AND "reason" IS NULL) OR ("attributed_amount" < 0 AND "reversed_attribution_id" IS NOT NULL AND "reason" IS NOT NULL AND "reason" ~ '[^[:space:]]')),
    CONSTRAINT "payment_intermediary_attributions_idempotency_check" CHECK ("idempotency_key" ~ '[^[:space:]]'),
    CONSTRAINT "payment_intermediary_attributions_tenant_payment_fk" FOREIGN KEY ("tenant_id", "payment_id") REFERENCES "transactions"("tenant_id", "id"),
    CONSTRAINT "payment_intermediary_attributions_tenant_transaction_fk" FOREIGN KEY ("tenant_id", "transaction_id") REFERENCES "transactions"("tenant_id", "id"),
    CONSTRAINT "payment_intermediary_attributions_tenant_intermediary_fk" FOREIGN KEY ("tenant_id", "intermediary_id") REFERENCES "intermediaries"("tenant_id", "id"),
    CONSTRAINT "payment_intermediary_attributions_tenant_audit_fk" FOREIGN KEY ("tenant_id", "audit_public_id") REFERENCES "audit_logs"("tenant_id", "public_id"),
    CONSTRAINT "payment_intermediary_attributions_tenant_actor_fk" FOREIGN KEY ("tenant_id", "created_by_user_id") REFERENCES "users"("tenant_id", "id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "payment_intermediary_attributions_tenant_id_id_unique" ON "payment_intermediary_attributions" ("tenant_id", "id");
--> statement-breakpoint
CREATE UNIQUE INDEX "payment_intermediary_attributions_tenant_payment_id_unique" ON "payment_intermediary_attributions" ("tenant_id", "payment_id", "id");
--> statement-breakpoint
ALTER TABLE "payment_intermediary_attributions" ADD CONSTRAINT "payment_intermediary_attributions_tenant_reversed_fk" FOREIGN KEY ("tenant_id", "payment_id", "reversed_attribution_id") REFERENCES "payment_intermediary_attributions"("tenant_id", "payment_id", "id");
--> statement-breakpoint
CREATE UNIQUE INDEX "payment_intermediary_attributions_tenant_idempotency_unique" ON "payment_intermediary_attributions" ("tenant_id", "idempotency_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "payment_intermediary_attributions_tenant_reversed_unique" ON "payment_intermediary_attributions" ("tenant_id", "reversed_attribution_id") WHERE "reversed_attribution_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "payment_intermediary_attributions_tenant_payment_idx" ON "payment_intermediary_attributions" ("tenant_id", "payment_id", "id");
--> statement-breakpoint
CREATE FUNCTION reject_immutable_commission_attribution_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION '% is append-only; % is not allowed', TG_TABLE_NAME, TG_OP;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER loan_commission_participants_immutable BEFORE UPDATE OR DELETE ON "loan_commission_participants" FOR EACH ROW EXECUTE FUNCTION reject_immutable_commission_attribution_mutation();
--> statement-breakpoint
CREATE TRIGGER payment_intermediary_attributions_immutable BEFORE UPDATE OR DELETE ON "payment_intermediary_attributions" FOR EACH ROW EXECUTE FUNCTION reject_immutable_commission_attribution_mutation();
