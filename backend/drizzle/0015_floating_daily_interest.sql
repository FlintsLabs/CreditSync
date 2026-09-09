ALTER TABLE "loans" ADD COLUMN "daily_interest_mode" text;--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN "daily_interest_rate" numeric;--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN "first_day_treatment" text;--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN "interest_start_date" date;--> statement-breakpoint
CREATE TABLE "loan_interest_accruals" (
  "id" serial PRIMARY KEY NOT NULL,
  "public_id" uuid DEFAULT uuidv7() NOT NULL,
  "tenant_id" text NOT NULL,
  "loan_id" integer NOT NULL,
  "accrual_date" date NOT NULL,
  "opening_principal" numeric NOT NULL,
  "rate_mode" text NOT NULL,
  "rate" numeric NOT NULL,
  "interest_amount" numeric NOT NULL,
  "status" text DEFAULT 'accrued' NOT NULL,
  "source_transaction_id" integer,
  "reversed_accrual_id" integer,
  "created_by_user_id" integer,
  "created_at" timestamp DEFAULT now(),
  CONSTRAINT "loan_interest_accruals_public_id_unique" UNIQUE("public_id"),
  CONSTRAINT "loan_interest_accruals_loan_fk" FOREIGN KEY ("loan_id") REFERENCES "loans"("id"),
  CONSTRAINT "loan_interest_accruals_source_transaction_fk" FOREIGN KEY ("source_transaction_id") REFERENCES "transactions"("id"),
  CONSTRAINT "loan_interest_accruals_created_by_user_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id")
);--> statement-breakpoint
CREATE UNIQUE INDEX "loan_interest_accruals_tenant_loan_date_unique" ON "loan_interest_accruals" USING btree ("tenant_id","loan_id","accrual_date");--> statement-breakpoint
CREATE UNIQUE INDEX "loan_interest_accruals_tenant_id_unique" ON "loan_interest_accruals" USING btree ("tenant_id","id");
