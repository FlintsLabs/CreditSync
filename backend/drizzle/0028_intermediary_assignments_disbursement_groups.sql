CREATE TABLE "intermediary_bank_accounts" (
	"id" serial PRIMARY KEY NOT NULL,
	"public_id" uuid DEFAULT uuidv7() NOT NULL,
	"tenant_id" text NOT NULL,
	"intermediary_id" integer NOT NULL,
	"bank_code" text,
	"bank_name" text NOT NULL,
	"account_name" text NOT NULL,
	"account_number_last4" text NOT NULL,
	"account_number_hash" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"note" text,
	"created_by_user_id" integer,
	"updated_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "intermediary_bank_accounts_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "intermediary_bank_accounts_status_check" CHECK ("intermediary_bank_accounts"."status" IN ('active', 'inactive')),
	CONSTRAINT "intermediary_bank_accounts_last4_check" CHECK ("intermediary_bank_accounts"."account_number_last4" ~ '^[0-9]{4}$'),
	CONSTRAINT "intermediary_bank_accounts_identity_check" CHECK (length("intermediary_bank_accounts"."bank_name") > 0 AND length("intermediary_bank_accounts"."account_name") > 0 AND length("intermediary_bank_accounts"."account_number_hash") > 0)
);
--> statement-breakpoint
CREATE TABLE "intermediated_disbursement_group_previews" (
	"id" serial PRIMARY KEY NOT NULL,
	"public_id" uuid DEFAULT uuidv7() NOT NULL,
	"tenant_id" text NOT NULL,
	"group_id" integer NOT NULL,
	"version" integer NOT NULL,
	"status" text NOT NULL,
	"expected_funding_amount" numeric NOT NULL,
	"actual_funding_amount" numeric NOT NULL,
	"expected_borrower_payout_amount" numeric NOT NULL,
	"actual_borrower_payout_amount" numeric NOT NULL,
	"expected_advance_interest_return_amount" numeric NOT NULL,
	"actual_advance_interest_return_amount" numeric NOT NULL,
	"retained_balance_amount" numeric NOT NULL,
	"variance_amount" numeric NOT NULL,
	"evidence_ready" boolean DEFAULT false NOT NULL,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"preview_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "intermediated_disbursement_group_previews_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "intermediated_disbursement_group_previews_version_check" CHECK ("intermediated_disbursement_group_previews"."version" > 0),
	CONSTRAINT "intermediated_disbursement_group_previews_status_check" CHECK ("intermediated_disbursement_group_previews"."status" IN ('needs_review', 'ready', 'stale', 'expired', 'executed')),
	CONSTRAINT "intermediated_disbursement_group_previews_amount_check" CHECK (
        "intermediated_disbursement_group_previews"."expected_funding_amount" >= 0 AND "intermediated_disbursement_group_previews"."actual_funding_amount" >= 0
        AND "intermediated_disbursement_group_previews"."expected_borrower_payout_amount" >= 0 AND "intermediated_disbursement_group_previews"."actual_borrower_payout_amount" >= 0
        AND "intermediated_disbursement_group_previews"."expected_advance_interest_return_amount" >= 0 AND "intermediated_disbursement_group_previews"."actual_advance_interest_return_amount" >= 0
        AND "intermediated_disbursement_group_previews"."retained_balance_amount" >= 0
    ),
	CONSTRAINT "intermediated_disbursement_group_previews_money_scale_check" CHECK (
        scale("intermediated_disbursement_group_previews"."expected_funding_amount") <= 2 AND scale("intermediated_disbursement_group_previews"."actual_funding_amount") <= 2
        AND scale("intermediated_disbursement_group_previews"."expected_borrower_payout_amount") <= 2 AND scale("intermediated_disbursement_group_previews"."actual_borrower_payout_amount") <= 2
        AND scale("intermediated_disbursement_group_previews"."expected_advance_interest_return_amount") <= 2 AND scale("intermediated_disbursement_group_previews"."actual_advance_interest_return_amount") <= 2
        AND scale("intermediated_disbursement_group_previews"."retained_balance_amount") <= 2 AND scale("intermediated_disbursement_group_previews"."variance_amount") <= 2
    ),
	CONSTRAINT "intermediated_disbursement_group_previews_expected_balance_check" CHECK (
        "intermediated_disbursement_group_previews"."expected_funding_amount" = "intermediated_disbursement_group_previews"."expected_borrower_payout_amount"
            + "intermediated_disbursement_group_previews"."expected_advance_interest_return_amount" + "intermediated_disbursement_group_previews"."retained_balance_amount"
    ),
	CONSTRAINT "intermediated_disbursement_group_previews_actual_balance_check" CHECK (
        "intermediated_disbursement_group_previews"."variance_amount" = "intermediated_disbursement_group_previews"."actual_funding_amount" - "intermediated_disbursement_group_previews"."actual_borrower_payout_amount"
            - "intermediated_disbursement_group_previews"."actual_advance_interest_return_amount" - "intermediated_disbursement_group_previews"."retained_balance_amount"
    ),
	CONSTRAINT "intermediated_disbursement_group_previews_hash_check" CHECK (length("intermediated_disbursement_group_previews"."preview_hash") > 0),
	CONSTRAINT "intermediated_disbursement_group_previews_expiry_check" CHECK ("intermediated_disbursement_group_previews"."expires_at" > "intermediated_disbursement_group_previews"."created_at"),
	CONSTRAINT "intermediated_disbursement_group_previews_ready_check" CHECK (
        "intermediated_disbursement_group_previews"."status" <> 'ready' OR ("intermediated_disbursement_group_previews"."variance_amount" = 0 AND "intermediated_disbursement_group_previews"."evidence_ready")
    )
);
--> statement-breakpoint
CREATE TABLE "intermediated_disbursement_groups" (
	"id" serial PRIMARY KEY NOT NULL,
	"public_id" uuid DEFAULT uuidv7() NOT NULL,
	"tenant_id" text NOT NULL,
	"loan_id" integer NOT NULL,
	"intermediary_id" integer NOT NULL,
	"expected_funding_amount" numeric NOT NULL,
	"expected_borrower_payout_amount" numeric NOT NULL,
	"expected_advance_interest_return_amount" numeric NOT NULL,
	"retained_balance_amount" numeric DEFAULT '0' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"idempotency_key" text NOT NULL,
	"post_idempotency_key" text,
	"reversed_group_id" integer,
	"reversal_idempotency_key" text,
	"reversal_request_hash" text,
	"reversal_reason" text,
	"note" text,
	"created_by_user_id" integer,
	"updated_by_user_id" integer,
	"posted_by_user_id" integer,
	"reversed_by_user_id" integer,
	"posted_at" timestamp with time zone,
	"reversed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "intermediated_disbursement_groups_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "intermediated_disbursement_groups_status_check" CHECK ("intermediated_disbursement_groups"."status" IN ('draft', 'needs_review', 'ready', 'posted', 'reversed')),
	CONSTRAINT "intermediated_disbursement_groups_money_check" CHECK (
        "intermediated_disbursement_groups"."expected_funding_amount" >= 0
        AND "intermediated_disbursement_groups"."expected_borrower_payout_amount" >= 0
        AND "intermediated_disbursement_groups"."expected_advance_interest_return_amount" >= 0
        AND "intermediated_disbursement_groups"."retained_balance_amount" >= 0
    ),
	CONSTRAINT "intermediated_disbursement_groups_money_scale_check" CHECK (
        scale("intermediated_disbursement_groups"."expected_funding_amount") <= 2
        AND scale("intermediated_disbursement_groups"."expected_borrower_payout_amount") <= 2
        AND scale("intermediated_disbursement_groups"."expected_advance_interest_return_amount") <= 2
        AND scale("intermediated_disbursement_groups"."retained_balance_amount") <= 2
    ),
	CONSTRAINT "intermediated_disbursement_groups_expected_balance_check" CHECK (
        "intermediated_disbursement_groups"."expected_funding_amount" = "intermediated_disbursement_groups"."expected_borrower_payout_amount"
            + "intermediated_disbursement_groups"."expected_advance_interest_return_amount" + "intermediated_disbursement_groups"."retained_balance_amount"
    ),
	CONSTRAINT "intermediated_disbursement_groups_lifecycle_check" CHECK (
        ("intermediated_disbursement_groups"."status" IN ('draft', 'needs_review', 'ready')
            AND "intermediated_disbursement_groups"."reversed_group_id" IS NULL AND "intermediated_disbursement_groups"."posted_at" IS NULL AND "intermediated_disbursement_groups"."reversed_at" IS NULL)
        OR ("intermediated_disbursement_groups"."status" = 'posted'
            AND "intermediated_disbursement_groups"."reversed_group_id" IS NULL AND "intermediated_disbursement_groups"."post_idempotency_key" IS NOT NULL
            AND "intermediated_disbursement_groups"."posted_at" IS NOT NULL AND "intermediated_disbursement_groups"."reversed_at" IS NULL)
        OR ("intermediated_disbursement_groups"."status" = 'reversed'
            AND "intermediated_disbursement_groups"."reversed_group_id" IS NOT NULL AND "intermediated_disbursement_groups"."posted_at" IS NOT NULL AND "intermediated_disbursement_groups"."reversed_at" IS NOT NULL
            AND "intermediated_disbursement_groups"."reversal_idempotency_key" IS NOT NULL AND length("intermediated_disbursement_groups"."reversal_request_hash") > 0
            AND length("intermediated_disbursement_groups"."reversal_reason") > 0)
    )
);
--> statement-breakpoint
CREATE TABLE "intermediated_transfer_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"public_id" uuid DEFAULT uuidv7() NOT NULL,
	"tenant_id" text NOT NULL,
	"group_id" integer NOT NULL,
	"intermediary_bank_account_id" integer,
	"role" text NOT NULL,
	"channel" text NOT NULL,
	"amount" numeric NOT NULL,
	"sender_hint" text,
	"payee_hint" text,
	"bank_reference" text,
	"bank_reference_hash" text,
	"transferred_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"idempotency_key" text NOT NULL,
	"reversed_event_id" integer,
	"reversal_reason" text,
	"note" text,
	"created_by_user_id" integer,
	"updated_by_user_id" integer,
	"posted_at" timestamp with time zone,
	"reversed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "intermediated_transfer_events_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "intermediated_transfer_events_role_check" CHECK ("intermediated_transfer_events"."role" IN ('funding_to_intermediary', 'borrower_net_payout', 'advance_interest_return')),
	CONSTRAINT "intermediated_transfer_events_channel_check" CHECK ("intermediated_transfer_events"."channel" IN ('bank_transfer', 'cash', 'adjustment')),
	CONSTRAINT "intermediated_transfer_events_status_check" CHECK ("intermediated_transfer_events"."status" IN ('draft', 'ready', 'posted', 'reversed')),
	CONSTRAINT "intermediated_transfer_events_money_check" CHECK ("intermediated_transfer_events"."amount" >= 0),
	CONSTRAINT "intermediated_transfer_events_money_scale_check" CHECK (scale("intermediated_transfer_events"."amount") <= 2),
	CONSTRAINT "intermediated_transfer_events_lifecycle_check" CHECK (
        ("intermediated_transfer_events"."status" IN ('draft', 'ready')
            AND "intermediated_transfer_events"."reversed_event_id" IS NULL AND "intermediated_transfer_events"."posted_at" IS NULL AND "intermediated_transfer_events"."reversed_at" IS NULL)
        OR ("intermediated_transfer_events"."status" = 'posted'
            AND "intermediated_transfer_events"."reversed_event_id" IS NULL AND "intermediated_transfer_events"."posted_at" IS NOT NULL AND "intermediated_transfer_events"."reversed_at" IS NULL)
        OR ("intermediated_transfer_events"."status" = 'reversed'
            AND "intermediated_transfer_events"."reversed_event_id" IS NOT NULL AND "intermediated_transfer_events"."posted_at" IS NOT NULL AND "intermediated_transfer_events"."reversed_at" IS NOT NULL
            AND length("intermediated_transfer_events"."reversal_reason") > 0)
    )
);
--> statement-breakpoint
CREATE TABLE "intermediated_transfer_evidence" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"event_id" integer NOT NULL,
	"file_id" integer NOT NULL,
	"created_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "intermediated_transfer_evidence_intents" (
	"id" serial PRIMARY KEY NOT NULL,
	"public_id" uuid DEFAULT uuidv7() NOT NULL,
	"tenant_id" text NOT NULL,
	"event_id" integer NOT NULL,
	"file_id" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"evidence_hash" text NOT NULL,
	"mime_type" text NOT NULL,
	"declared_size" integer NOT NULL,
	"upload_expires_at" timestamp with time zone NOT NULL,
	"finalized_at" timestamp with time zone,
	"created_by_user_id" integer,
	"updated_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "intermediated_transfer_evidence_intents_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "intermediated_transfer_evidence_intents_status_check" CHECK ("intermediated_transfer_evidence_intents"."status" IN ('pending', 'ready')),
	CONSTRAINT "intermediated_transfer_evidence_intents_metadata_check" CHECK (length("intermediated_transfer_evidence_intents"."evidence_hash") > 0 AND length("intermediated_transfer_evidence_intents"."mime_type") > 0 AND "intermediated_transfer_evidence_intents"."declared_size" > 0),
	CONSTRAINT "intermediated_transfer_evidence_intents_lifecycle_check" CHECK (
        ("intermediated_transfer_evidence_intents"."status" = 'pending' AND "intermediated_transfer_evidence_intents"."finalized_at" IS NULL)
        OR ("intermediated_transfer_evidence_intents"."status" = 'ready' AND "intermediated_transfer_evidence_intents"."finalized_at" IS NOT NULL)
    )
);
--> statement-breakpoint
CREATE TABLE "loan_intermediary_assignments" (
	"id" serial PRIMARY KEY NOT NULL,
	"public_id" uuid DEFAULT uuidv7() NOT NULL,
	"tenant_id" text NOT NULL,
	"loan_id" integer NOT NULL,
	"intermediary_id" integer NOT NULL,
	"role" text NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"status" text DEFAULT 'active' NOT NULL,
	"idempotency_key" text NOT NULL,
	"note" text,
	"created_by_user_id" integer,
	"updated_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loan_intermediary_assignments_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "loan_intermediary_assignments_role_check" CHECK ("loan_intermediary_assignments"."role" IN ('disbursement', 'collection', 'both')),
	CONSTRAINT "loan_intermediary_assignments_status_check" CHECK ("loan_intermediary_assignments"."status" IN ('active', 'ended')),
	CONSTRAINT "loan_intermediary_assignments_date_order_check" CHECK ("loan_intermediary_assignments"."effective_to" IS NULL OR "loan_intermediary_assignments"."effective_to" > "loan_intermediary_assignments"."effective_from"),
	CONSTRAINT "loan_intermediary_assignments_lifecycle_check" CHECK (("loan_intermediary_assignments"."status" = 'active' AND "loan_intermediary_assignments"."effective_to" IS NULL) OR ("loan_intermediary_assignments"."status" = 'ended' AND "loan_intermediary_assignments"."effective_to" IS NOT NULL))
);
--> statement-breakpoint
-- Referenced tenant/id pairs must be unique before PostgreSQL accepts the
-- tenant-safe compound foreign keys declared below.
CREATE UNIQUE INDEX "intermediary_bank_accounts_tenant_id_id_unique" ON "intermediary_bank_accounts" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "intermediated_disbursement_groups_tenant_id_id_unique" ON "intermediated_disbursement_groups" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "intermediated_transfer_events_tenant_id_id_unique" ON "intermediated_transfer_events" USING btree ("tenant_id","id");--> statement-breakpoint
ALTER TABLE "intermediary_bank_accounts" ADD CONSTRAINT "intermediary_bank_accounts_tenant_intermediary_fk" FOREIGN KEY ("tenant_id","intermediary_id") REFERENCES "public"."intermediaries"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intermediary_bank_accounts" ADD CONSTRAINT "intermediary_bank_accounts_tenant_created_by_fk" FOREIGN KEY ("tenant_id","created_by_user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intermediary_bank_accounts" ADD CONSTRAINT "intermediary_bank_accounts_tenant_updated_by_fk" FOREIGN KEY ("tenant_id","updated_by_user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intermediated_disbursement_group_previews" ADD CONSTRAINT "intermediated_disbursement_group_previews_tenant_group_fk" FOREIGN KEY ("tenant_id","group_id") REFERENCES "public"."intermediated_disbursement_groups"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intermediated_disbursement_group_previews" ADD CONSTRAINT "intermediated_disbursement_group_previews_tenant_created_by_fk" FOREIGN KEY ("tenant_id","created_by_user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intermediated_disbursement_groups" ADD CONSTRAINT "intermediated_disbursement_groups_tenant_loan_fk" FOREIGN KEY ("tenant_id","loan_id") REFERENCES "public"."loans"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intermediated_disbursement_groups" ADD CONSTRAINT "intermediated_disbursement_groups_tenant_intermediary_fk" FOREIGN KEY ("tenant_id","intermediary_id") REFERENCES "public"."intermediaries"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intermediated_disbursement_groups" ADD CONSTRAINT "intermediated_disbursement_groups_tenant_reversed_group_fk" FOREIGN KEY ("tenant_id","reversed_group_id") REFERENCES "public"."intermediated_disbursement_groups"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intermediated_disbursement_groups" ADD CONSTRAINT "intermediated_disbursement_groups_tenant_created_by_fk" FOREIGN KEY ("tenant_id","created_by_user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intermediated_disbursement_groups" ADD CONSTRAINT "intermediated_disbursement_groups_tenant_updated_by_fk" FOREIGN KEY ("tenant_id","updated_by_user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intermediated_disbursement_groups" ADD CONSTRAINT "intermediated_disbursement_groups_tenant_posted_by_fk" FOREIGN KEY ("tenant_id","posted_by_user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intermediated_disbursement_groups" ADD CONSTRAINT "intermediated_disbursement_groups_tenant_reversed_by_fk" FOREIGN KEY ("tenant_id","reversed_by_user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intermediated_transfer_events" ADD CONSTRAINT "intermediated_transfer_events_tenant_group_fk" FOREIGN KEY ("tenant_id","group_id") REFERENCES "public"."intermediated_disbursement_groups"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intermediated_transfer_events" ADD CONSTRAINT "intermediated_transfer_events_tenant_bank_account_fk" FOREIGN KEY ("tenant_id","intermediary_bank_account_id") REFERENCES "public"."intermediary_bank_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intermediated_transfer_events" ADD CONSTRAINT "intermediated_transfer_events_tenant_reversed_event_fk" FOREIGN KEY ("tenant_id","reversed_event_id") REFERENCES "public"."intermediated_transfer_events"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intermediated_transfer_events" ADD CONSTRAINT "intermediated_transfer_events_tenant_created_by_fk" FOREIGN KEY ("tenant_id","created_by_user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intermediated_transfer_events" ADD CONSTRAINT "intermediated_transfer_events_tenant_updated_by_fk" FOREIGN KEY ("tenant_id","updated_by_user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intermediated_transfer_evidence" ADD CONSTRAINT "intermediated_transfer_evidence_tenant_event_fk" FOREIGN KEY ("tenant_id","event_id") REFERENCES "public"."intermediated_transfer_events"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intermediated_transfer_evidence" ADD CONSTRAINT "intermediated_transfer_evidence_tenant_file_fk" FOREIGN KEY ("tenant_id","file_id") REFERENCES "public"."files"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intermediated_transfer_evidence" ADD CONSTRAINT "intermediated_transfer_evidence_tenant_created_by_fk" FOREIGN KEY ("tenant_id","created_by_user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intermediated_transfer_evidence_intents" ADD CONSTRAINT "intermediated_transfer_evidence_intents_tenant_event_fk" FOREIGN KEY ("tenant_id","event_id") REFERENCES "public"."intermediated_transfer_events"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intermediated_transfer_evidence_intents" ADD CONSTRAINT "intermediated_transfer_evidence_intents_tenant_file_fk" FOREIGN KEY ("tenant_id","file_id") REFERENCES "public"."files"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intermediated_transfer_evidence_intents" ADD CONSTRAINT "intermediated_transfer_evidence_intents_tenant_created_by_fk" FOREIGN KEY ("tenant_id","created_by_user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intermediated_transfer_evidence_intents" ADD CONSTRAINT "intermediated_transfer_evidence_intents_tenant_updated_by_fk" FOREIGN KEY ("tenant_id","updated_by_user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_intermediary_assignments" ADD CONSTRAINT "loan_intermediary_assignments_tenant_loan_fk" FOREIGN KEY ("tenant_id","loan_id") REFERENCES "public"."loans"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_intermediary_assignments" ADD CONSTRAINT "loan_intermediary_assignments_tenant_intermediary_fk" FOREIGN KEY ("tenant_id","intermediary_id") REFERENCES "public"."intermediaries"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_intermediary_assignments" ADD CONSTRAINT "loan_intermediary_assignments_tenant_created_by_fk" FOREIGN KEY ("tenant_id","created_by_user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_intermediary_assignments" ADD CONSTRAINT "loan_intermediary_assignments_tenant_updated_by_fk" FOREIGN KEY ("tenant_id","updated_by_user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "intermediary_bank_accounts_tenant_hash_unique" ON "intermediary_bank_accounts" USING btree ("tenant_id","account_number_hash");--> statement-breakpoint
CREATE INDEX "intermediary_bank_accounts_tenant_intermediary_status_idx" ON "intermediary_bank_accounts" USING btree ("tenant_id","intermediary_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "intermediated_disbursement_group_previews_tenant_id_id_unique" ON "intermediated_disbursement_group_previews" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "intermediated_disbursement_group_previews_version_unique" ON "intermediated_disbursement_group_previews" USING btree ("tenant_id","group_id","version");--> statement-breakpoint
CREATE INDEX "intermediated_disbursement_group_previews_tenant_group_created_idx" ON "intermediated_disbursement_group_previews" USING btree ("tenant_id","group_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "intermediated_disbursement_groups_tenant_idempotency_unique" ON "intermediated_disbursement_groups" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "intermediated_disbursement_groups_tenant_post_idempotency_unique" ON "intermediated_disbursement_groups" USING btree ("tenant_id","post_idempotency_key") WHERE "intermediated_disbursement_groups"."post_idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "intermediated_disbursement_groups_tenant_reversal_idempotency_unique" ON "intermediated_disbursement_groups" USING btree ("tenant_id","reversal_idempotency_key") WHERE "intermediated_disbursement_groups"."reversal_idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "intermediated_disbursement_groups_tenant_reversed_group_unique" ON "intermediated_disbursement_groups" USING btree ("tenant_id","reversed_group_id") WHERE "intermediated_disbursement_groups"."reversed_group_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "intermediated_disbursement_groups_tenant_loan_status_idx" ON "intermediated_disbursement_groups" USING btree ("tenant_id","loan_id","status");--> statement-breakpoint
CREATE INDEX "intermediated_disbursement_groups_tenant_intermediary_status_idx" ON "intermediated_disbursement_groups" USING btree ("tenant_id","intermediary_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "intermediated_transfer_events_tenant_idempotency_unique" ON "intermediated_transfer_events" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "intermediated_transfer_events_tenant_reference_unique" ON "intermediated_transfer_events" USING btree ("tenant_id","bank_reference_hash") WHERE "intermediated_transfer_events"."bank_reference_hash" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "intermediated_transfer_events_tenant_reversed_event_unique" ON "intermediated_transfer_events" USING btree ("tenant_id","reversed_event_id") WHERE "intermediated_transfer_events"."reversed_event_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "intermediated_transfer_events_tenant_group_role_idx" ON "intermediated_transfer_events" USING btree ("tenant_id","group_id","role");--> statement-breakpoint
CREATE UNIQUE INDEX "intermediated_transfer_evidence_tenant_id_id_unique" ON "intermediated_transfer_evidence" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "intermediated_transfer_evidence_event_file_unique" ON "intermediated_transfer_evidence" USING btree ("event_id","file_id");--> statement-breakpoint
CREATE UNIQUE INDEX "intermediated_transfer_evidence_tenant_file_unique" ON "intermediated_transfer_evidence" USING btree ("tenant_id","file_id");--> statement-breakpoint
CREATE UNIQUE INDEX "intermediated_transfer_evidence_intents_tenant_id_id_unique" ON "intermediated_transfer_evidence_intents" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "intermediated_transfer_evidence_intents_tenant_hash_unique" ON "intermediated_transfer_evidence_intents" USING btree ("tenant_id","evidence_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "intermediated_transfer_evidence_intents_tenant_file_unique" ON "intermediated_transfer_evidence_intents" USING btree ("tenant_id","file_id");--> statement-breakpoint
CREATE UNIQUE INDEX "loan_intermediary_assignments_tenant_id_id_unique" ON "loan_intermediary_assignments" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "loan_intermediary_assignments_tenant_idempotency_unique" ON "loan_intermediary_assignments" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "loan_intermediary_assignments_tenant_loan_effective_idx" ON "loan_intermediary_assignments" USING btree ("tenant_id","loan_id","effective_from");--> statement-breakpoint
CREATE INDEX "loan_intermediary_assignments_tenant_intermediary_status_idx" ON "loan_intermediary_assignments" USING btree ("tenant_id","intermediary_id","status");--> statement-breakpoint

-- `both` consumes both independently exclusive responsibilities. A half-open
-- range lets one assignment end at the exact instant its successor begins.
CREATE EXTENSION IF NOT EXISTS btree_gist;--> statement-breakpoint
ALTER TABLE "loan_intermediary_assignments"
ADD CONSTRAINT "loan_intermediary_assignments_disbursement_no_overlap"
EXCLUDE USING gist (
	"tenant_id" WITH =,
	"loan_id" WITH =,
	tstzrange("effective_from", "effective_to", '[)') WITH &&
)
WHERE ("role" IN ('disbursement', 'both'));--> statement-breakpoint
ALTER TABLE "loan_intermediary_assignments"
ADD CONSTRAINT "loan_intermediary_assignments_collection_no_overlap"
EXCLUDE USING gist (
	"tenant_id" WITH =,
	"loan_id" WITH =,
	tstzrange("effective_from", "effective_to", '[)') WITH &&
)
WHERE ("role" IN ('collection', 'both'));--> statement-breakpoint

CREATE FUNCTION reject_immutable_intermediated_disbursement_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF OLD."status" IN ('posted', 'reversed') THEN
		RAISE EXCEPTION '% non-draft financial records are immutable; % is not allowed', TG_TABLE_NAME, TG_OP;
	END IF;
	RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;--> statement-breakpoint
CREATE TRIGGER intermediated_disbursement_groups_posted_immutable
BEFORE UPDATE OR DELETE ON "intermediated_disbursement_groups"
FOR EACH ROW EXECUTE FUNCTION reject_immutable_intermediated_disbursement_mutation();--> statement-breakpoint
CREATE TRIGGER intermediated_transfer_events_posted_immutable
BEFORE UPDATE OR DELETE ON "intermediated_transfer_events"
FOR EACH ROW EXECUTE FUNCTION reject_immutable_intermediated_disbursement_mutation();--> statement-breakpoint

CREATE FUNCTION reject_immutable_intermediated_evidence_link_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	RAISE EXCEPTION 'finalized intermediated transfer evidence links are immutable; % is not allowed', TG_OP;
END;
$$;--> statement-breakpoint
CREATE TRIGGER intermediated_transfer_evidence_immutable
BEFORE UPDATE OR DELETE ON "intermediated_transfer_evidence"
FOR EACH ROW EXECUTE FUNCTION reject_immutable_intermediated_evidence_link_mutation();--> statement-breakpoint

CREATE FUNCTION reject_ready_intermediated_evidence_intent_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF OLD."status" = 'ready' THEN
		RAISE EXCEPTION 'finalized intermediated transfer evidence intents are immutable; % is not allowed', TG_OP;
	END IF;
	RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;--> statement-breakpoint
CREATE TRIGGER intermediated_transfer_evidence_intents_ready_immutable
BEFORE UPDATE OR DELETE ON "intermediated_transfer_evidence_intents"
FOR EACH ROW EXECUTE FUNCTION reject_ready_intermediated_evidence_intent_mutation();
