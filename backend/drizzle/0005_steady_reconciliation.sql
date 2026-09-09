ALTER TABLE "bank_loan_schedules" ADD COLUMN "overdue_days" integer DEFAULT 0 NOT NULL;
ALTER TABLE "loans" ADD COLUMN "grace_period_days" integer DEFAULT 0;
ALTER TABLE "loans" ADD COLUMN "late_fee_mode" text DEFAULT 'none';
ALTER TABLE "loans" ADD COLUMN "late_fee_amount" numeric DEFAULT '0';
ALTER TABLE "loan_schedules" ADD COLUMN "overdue_days" integer DEFAULT 0 NOT NULL;

CREATE TABLE "reconciliation_entries" (
    "id" serial PRIMARY KEY NOT NULL,
    "tenant_id" text NOT NULL,
    "entity_type" text NOT NULL,
    "entity_id" integer NOT NULL,
    "upload_id" integer,
    "status" text DEFAULT 'matched' NOT NULL,
    "note" text,
    "matched_by_user_id" integer,
    "created_at" timestamp DEFAULT now(),
    "updated_at" timestamp DEFAULT now()
);

ALTER TABLE "reconciliation_entries"
    ADD CONSTRAINT "reconciliation_entries_upload_id_bot_uploads_id_fk"
    FOREIGN KEY ("upload_id") REFERENCES "public"."bot_uploads"("id") ON DELETE no action ON UPDATE no action;

ALTER TABLE "reconciliation_entries"
    ADD CONSTRAINT "reconciliation_entries_matched_by_user_id_users_id_fk"
    FOREIGN KEY ("matched_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
