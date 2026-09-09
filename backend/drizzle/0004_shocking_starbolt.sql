CREATE TABLE "audit_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"action" text NOT NULL,
	"actor_user_id" integer,
	"payload" jsonb,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "fund_ledger_entries" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"bank_profile_id" integer NOT NULL,
	"bank_loan_id" integer,
	"loan_id" integer,
	"transaction_id" integer,
	"bank_repayment_id" integer,
	"rollover_entry_id" integer,
	"entry_date" timestamp DEFAULT now() NOT NULL,
	"entry_type" text NOT NULL,
	"amount" numeric NOT NULL,
	"note" text,
	"created_by_user_id" integer,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "fund_rollover_entries" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"from_bank_profile_id" integer,
	"from_bank_loan_id" integer,
	"to_bank_profile_id" integer,
	"to_bank_loan_id" integer,
	"entry_type" text NOT NULL,
	"amount" numeric NOT NULL,
	"effective_date" date NOT NULL,
	"note" text,
	"created_by_user_id" integer,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "loan_funding_allocations" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"bank_profile_id" integer,
	"bank_loan_id" integer,
	"loan_id" integer NOT NULL,
	"allocated_amount" numeric NOT NULL,
	"allocation_date" date NOT NULL,
	"allocation_type" text DEFAULT 'initial' NOT NULL,
	"note" text,
	"created_by_user_id" integer,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "loan_schedules" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"loan_id" integer NOT NULL,
	"installment_no" integer NOT NULL,
	"due_date" date NOT NULL,
	"scheduled_principal" numeric DEFAULT '0' NOT NULL,
	"scheduled_interest" numeric DEFAULT '0' NOT NULL,
	"scheduled_fee" numeric DEFAULT '0' NOT NULL,
	"scheduled_total" numeric DEFAULT '0' NOT NULL,
	"paid_total" numeric DEFAULT '0' NOT NULL,
	"paid_penalty" numeric DEFAULT '0' NOT NULL,
	"remaining_due" numeric DEFAULT '0' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "bank_loans" ADD COLUMN "updated_at" timestamp DEFAULT now();--> statement-breakpoint
ALTER TABLE "bank_profiles" ADD COLUMN "accounting_mode" text DEFAULT 'external_liability' NOT NULL;--> statement-breakpoint
ALTER TABLE "bank_profiles" ADD COLUMN "reinvest_profit_mode" text DEFAULT 'manual_distribution' NOT NULL;--> statement-breakpoint
ALTER TABLE "bank_profiles" ADD COLUMN "updated_at" timestamp DEFAULT now();--> statement-breakpoint
ALTER TABLE "borrowers" ADD COLUMN "updated_at" timestamp DEFAULT now();--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN "next_due_date" date;--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN "outstanding_principal" numeric DEFAULT '0';--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN "outstanding_interest" numeric DEFAULT '0';--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN "outstanding_fees" numeric DEFAULT '0';--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN "updated_at" timestamp DEFAULT now();--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "schedule_id" integer;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "principal_component" numeric DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "interest_component" numeric DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "fee_component" numeric DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "penalty_component" numeric DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "recorded_by_user_id" integer;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "updated_at" timestamp DEFAULT now();--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fund_ledger_entries" ADD CONSTRAINT "fund_ledger_entries_bank_profile_id_bank_profiles_id_fk" FOREIGN KEY ("bank_profile_id") REFERENCES "public"."bank_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fund_ledger_entries" ADD CONSTRAINT "fund_ledger_entries_bank_loan_id_bank_loans_id_fk" FOREIGN KEY ("bank_loan_id") REFERENCES "public"."bank_loans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fund_ledger_entries" ADD CONSTRAINT "fund_ledger_entries_loan_id_loans_id_fk" FOREIGN KEY ("loan_id") REFERENCES "public"."loans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fund_ledger_entries" ADD CONSTRAINT "fund_ledger_entries_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fund_ledger_entries" ADD CONSTRAINT "fund_ledger_entries_bank_repayment_id_bank_loan_repayments_id_fk" FOREIGN KEY ("bank_repayment_id") REFERENCES "public"."bank_loan_repayments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fund_ledger_entries" ADD CONSTRAINT "fund_ledger_entries_rollover_entry_id_fund_rollover_entries_id_fk" FOREIGN KEY ("rollover_entry_id") REFERENCES "public"."fund_rollover_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fund_ledger_entries" ADD CONSTRAINT "fund_ledger_entries_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fund_rollover_entries" ADD CONSTRAINT "fund_rollover_entries_from_bank_profile_id_bank_profiles_id_fk" FOREIGN KEY ("from_bank_profile_id") REFERENCES "public"."bank_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fund_rollover_entries" ADD CONSTRAINT "fund_rollover_entries_from_bank_loan_id_bank_loans_id_fk" FOREIGN KEY ("from_bank_loan_id") REFERENCES "public"."bank_loans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fund_rollover_entries" ADD CONSTRAINT "fund_rollover_entries_to_bank_profile_id_bank_profiles_id_fk" FOREIGN KEY ("to_bank_profile_id") REFERENCES "public"."bank_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fund_rollover_entries" ADD CONSTRAINT "fund_rollover_entries_to_bank_loan_id_bank_loans_id_fk" FOREIGN KEY ("to_bank_loan_id") REFERENCES "public"."bank_loans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fund_rollover_entries" ADD CONSTRAINT "fund_rollover_entries_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_funding_allocations" ADD CONSTRAINT "loan_funding_allocations_bank_profile_id_bank_profiles_id_fk" FOREIGN KEY ("bank_profile_id") REFERENCES "public"."bank_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_funding_allocations" ADD CONSTRAINT "loan_funding_allocations_bank_loan_id_bank_loans_id_fk" FOREIGN KEY ("bank_loan_id") REFERENCES "public"."bank_loans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_funding_allocations" ADD CONSTRAINT "loan_funding_allocations_loan_id_loans_id_fk" FOREIGN KEY ("loan_id") REFERENCES "public"."loans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_funding_allocations" ADD CONSTRAINT "loan_funding_allocations_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_schedules" ADD CONSTRAINT "loan_schedules_loan_id_loans_id_fk" FOREIGN KEY ("loan_id") REFERENCES "public"."loans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_schedule_id_loan_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."loan_schedules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;