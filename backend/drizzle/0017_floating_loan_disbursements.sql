CREATE TABLE "loan_disbursements" (
  "id" serial PRIMARY KEY NOT NULL,
  "public_id" uuid DEFAULT uuidv7() NOT NULL,
  "tenant_id" text NOT NULL,
  "loan_id" integer NOT NULL,
  "gross_principal" numeric NOT NULL,
  "first_day_interest_deducted" numeric DEFAULT '0' NOT NULL,
  "net_disbursement" numeric NOT NULL,
  "disbursed_at" timestamp DEFAULT now() NOT NULL,
  "created_by_user_id" integer,
  "created_at" timestamp DEFAULT now(),
  CONSTRAINT "loan_disbursements_public_id_unique" UNIQUE("public_id"),
  CONSTRAINT "loan_disbursements_loan_fk" FOREIGN KEY ("loan_id") REFERENCES "loans"("id"),
  CONSTRAINT "loan_disbursements_created_by_user_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id")
);--> statement-breakpoint
CREATE UNIQUE INDEX "loan_disbursements_tenant_loan_unique" ON "loan_disbursements" USING btree ("tenant_id","loan_id");
