CREATE TABLE "bank_loan_repayments" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"bank_loan_id" integer NOT NULL,
	"schedule_id" integer,
	"payment_date" timestamp DEFAULT now() NOT NULL,
	"amount" numeric NOT NULL,
	"principal_component" numeric DEFAULT '0' NOT NULL,
	"interest_component" numeric DEFAULT '0' NOT NULL,
	"fee_component" numeric DEFAULT '0' NOT NULL,
	"vat_component" numeric DEFAULT '0' NOT NULL,
	"penalty_component" numeric DEFAULT '0' NOT NULL,
	"payment_method" text,
	"reference" text,
	"note" text,
	"recorded_by_user_id" integer,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "bank_loan_repayments" ADD CONSTRAINT "bank_loan_repayments_bank_loan_id_bank_loans_id_fk" FOREIGN KEY ("bank_loan_id") REFERENCES "public"."bank_loans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_loan_repayments" ADD CONSTRAINT "bank_loan_repayments_schedule_id_bank_loan_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."bank_loan_schedules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_loan_repayments" ADD CONSTRAINT "bank_loan_repayments_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;