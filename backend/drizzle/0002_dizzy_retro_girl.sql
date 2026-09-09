CREATE TABLE "bank_loan_schedules" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"bank_loan_id" integer NOT NULL,
	"installment_no" integer NOT NULL,
	"due_date" date NOT NULL,
	"scheduled_principal" numeric DEFAULT '0' NOT NULL,
	"scheduled_interest" numeric DEFAULT '0' NOT NULL,
	"scheduled_fee" numeric DEFAULT '0' NOT NULL,
	"scheduled_vat" numeric DEFAULT '0' NOT NULL,
	"scheduled_total" numeric DEFAULT '0' NOT NULL,
	"paid_total" numeric DEFAULT '0' NOT NULL,
	"paid_penalty" numeric DEFAULT '0' NOT NULL,
	"remaining_due" numeric DEFAULT '0' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "bank_loans" ADD COLUMN "repayment_cycle" text DEFAULT 'monthly';--> statement-breakpoint
ALTER TABLE "bank_loans" ADD COLUMN "repayment_mode" text DEFAULT 'fixed_installment';--> statement-breakpoint
ALTER TABLE "bank_loans" ADD COLUMN "installment_amount" numeric;--> statement-breakpoint
ALTER TABLE "bank_loans" ADD COLUMN "total_installments" integer;--> statement-breakpoint
ALTER TABLE "bank_loans" ADD COLUMN "processing_fee_amount" numeric DEFAULT '0';--> statement-breakpoint
ALTER TABLE "bank_loans" ADD COLUMN "utilization_fee_amount" numeric DEFAULT '0';--> statement-breakpoint
ALTER TABLE "bank_loans" ADD COLUMN "vat_rate" numeric DEFAULT '0';--> statement-breakpoint
ALTER TABLE "bank_loans" ADD COLUMN "late_fee_mode" text DEFAULT 'none';--> statement-breakpoint
ALTER TABLE "bank_loans" ADD COLUMN "late_fee_amount" numeric DEFAULT '0';--> statement-breakpoint
ALTER TABLE "bank_loans" ADD COLUMN "grace_period_days" integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE "bank_loans" ADD COLUMN "next_due_date" date;--> statement-breakpoint
ALTER TABLE "bank_loans" ADD COLUMN "outstanding_principal" numeric DEFAULT '0';--> statement-breakpoint
ALTER TABLE "bank_loans" ADD COLUMN "outstanding_interest" numeric DEFAULT '0';--> statement-breakpoint
ALTER TABLE "bank_loans" ADD COLUMN "outstanding_fees" numeric DEFAULT '0';--> statement-breakpoint
ALTER TABLE "bank_loans" ADD COLUMN "outstanding_penalties" numeric DEFAULT '0';--> statement-breakpoint
ALTER TABLE "bank_loans" ADD COLUMN "closed_at" timestamp;--> statement-breakpoint
ALTER TABLE "bank_loans" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "bank_profiles" ADD COLUMN "provider_name" text;--> statement-breakpoint
ALTER TABLE "bank_profiles" ADD COLUMN "reference_no" text;--> statement-breakpoint
ALTER TABLE "bank_profiles" ADD COLUMN "status" text DEFAULT 'active';--> statement-breakpoint
ALTER TABLE "bank_profiles" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "borrowers" ADD COLUMN "tags" text[];--> statement-breakpoint
ALTER TABLE "borrowers" ADD COLUMN "google_maps_url" text;--> statement-breakpoint
ALTER TABLE "bank_loan_schedules" ADD CONSTRAINT "bank_loan_schedules_bank_loan_id_bank_loans_id_fk" FOREIGN KEY ("bank_loan_id") REFERENCES "public"."bank_loans"("id") ON DELETE no action ON UPDATE no action;