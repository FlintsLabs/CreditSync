CREATE TABLE "loan_disbursement_events" (
  "id" serial PRIMARY KEY NOT NULL,
  "public_id" uuid DEFAULT uuidv7() NOT NULL,
  "tenant_id" text NOT NULL,
  "loan_id" integer NOT NULL,
  "gross_amount" numeric NOT NULL,
  "loan_attributed_amount" numeric NOT NULL,
  "channel" text NOT NULL,
  "source_bank_profile_id" integer,
  "payee_hint" text,
  "status" text DEFAULT 'draft' NOT NULL,
  "reversed_event_id" integer,
  "note" text,
  "disbursed_at" timestamp,
  "posted_at" timestamp,
  "reversed_at" timestamp,
  "created_by_user_id" integer,
  "created_at" timestamp DEFAULT now(),
  CONSTRAINT "loan_disbursement_events_public_id_unique" UNIQUE("public_id"),
  CONSTRAINT "loan_disbursement_events_channel_check" CHECK ("channel" IN ('bank_transfer', 'cash', 'adjustment')),
  CONSTRAINT "loan_disbursement_events_status_check" CHECK ("status" IN ('draft', 'posted', 'reversed')),
  CONSTRAINT "loan_disbursement_events_money_check" CHECK ("gross_amount" >= 0 AND "loan_attributed_amount" >= 0),
  CONSTRAINT "loan_disbursement_events_loan_fk" FOREIGN KEY ("loan_id") REFERENCES "loans"("id"),
  CONSTRAINT "loan_disbursement_events_source_bank_profile_fk" FOREIGN KEY ("source_bank_profile_id") REFERENCES "bank_profiles"("id"),
  CONSTRAINT "loan_disbursement_events_reversed_event_fk" FOREIGN KEY ("reversed_event_id") REFERENCES "loan_disbursement_events"("id"),
  CONSTRAINT "loan_disbursement_events_created_by_user_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id")
);--> statement-breakpoint
CREATE INDEX "loan_disbursement_events_tenant_loan_status_idx" ON "loan_disbursement_events" USING btree ("tenant_id", "loan_id", "status");--> statement-breakpoint
CREATE UNIQUE INDEX "loan_disbursement_events_tenant_id_id_unique" ON "loan_disbursement_events" USING btree ("tenant_id", "id");--> statement-breakpoint
CREATE TABLE "loan_disbursement_evidence" (
  "id" serial PRIMARY KEY NOT NULL,
  "tenant_id" text NOT NULL,
  "loan_disbursement_event_id" integer NOT NULL,
  "file_id" integer NOT NULL,
  "created_at" timestamp DEFAULT now(),
  CONSTRAINT "loan_disbursement_evidence_event_file_unique" UNIQUE("loan_disbursement_event_id", "file_id"),
  CONSTRAINT "loan_disbursement_evidence_tenant_event_fk" FOREIGN KEY ("tenant_id", "loan_disbursement_event_id") REFERENCES "loan_disbursement_events"("tenant_id", "id"),
  CONSTRAINT "loan_disbursement_evidence_tenant_file_fk" FOREIGN KEY ("tenant_id", "file_id") REFERENCES "files"("tenant_id", "id")
);--> statement-breakpoint
CREATE FUNCTION reject_posted_loan_disbursement_event_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."status" = 'posted' THEN
    RAISE EXCEPTION 'loan_disbursement_events posted records are immutable; % is not allowed', TG_OP;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER loan_disbursement_events_posted_immutable
BEFORE UPDATE OR DELETE ON "loan_disbursement_events"
FOR EACH ROW EXECUTE FUNCTION reject_posted_loan_disbursement_event_mutation();
