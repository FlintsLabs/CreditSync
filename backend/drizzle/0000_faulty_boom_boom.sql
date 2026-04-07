CREATE TYPE "public"."role" AS ENUM('owner', 'manager', 'collector', 'viewer');--> statement-breakpoint
CREATE TABLE "bank_loans" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"bank_profile_id" integer,
	"amount" numeric NOT NULL,
	"interest_rate" numeric,
	"start_date" date,
	"term_months" integer,
	"status" text DEFAULT 'active',
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "bank_profiles" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"credit_limit" numeric,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "bank_transactions" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"bank_loan_id" integer NOT NULL,
	"amount" numeric NOT NULL,
	"type" text DEFAULT 'repayment',
	"transaction_date" timestamp DEFAULT now(),
	"notes" text,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "borrowers" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"id_card_number" text,
	"address" text,
	"phone" text,
	"photo_url" text,
	"id_card_image_url" text,
	"credit_score" integer DEFAULT 100,
	"tags" text[],
	"google_maps_url" text,
	"notes" text,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "bot_uploads" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"file_id" integer,
	"source" text DEFAULT 'line',
	"sender_id" text,
	"status" text DEFAULT 'pending',
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "files" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"bucket" text NOT NULL,
	"key" text NOT NULL,
	"original_name" text,
	"mime_type" text,
	"size" integer,
	"url" text,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "loans" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"borrower_id" integer NOT NULL,
	"bank_loan_id" integer,
	"principal_amount" numeric NOT NULL,
	"interest_rate" numeric NOT NULL,
	"repayment_type" text NOT NULL,
	"installment_amount" numeric,
	"total_installments" integer,
	"start_date" date DEFAULT now(),
	"status" text DEFAULT 'draft',
	"cloned_from_loan_id" integer,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "tenant_configs" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"line_channel_token" text,
	"webhook_secret" text,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "tenant_configs_tenant_id_unique" UNIQUE("tenant_id")
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"loan_id" integer NOT NULL,
	"amount" numeric NOT NULL,
	"type" text DEFAULT 'repayment',
	"slip_url" text,
	"transaction_date" timestamp DEFAULT now(),
	"notes" text,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"picture" text,
	"role" "role" DEFAULT 'viewer',
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "bank_loans" ADD CONSTRAINT "bank_loans_bank_profile_id_bank_profiles_id_fk" FOREIGN KEY ("bank_profile_id") REFERENCES "public"."bank_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_bank_loan_id_bank_loans_id_fk" FOREIGN KEY ("bank_loan_id") REFERENCES "public"."bank_loans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_uploads" ADD CONSTRAINT "bot_uploads_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loans_borrower_id_borrowers_id_fk" FOREIGN KEY ("borrower_id") REFERENCES "public"."borrowers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loans_bank_loan_id_bank_loans_id_fk" FOREIGN KEY ("bank_loan_id") REFERENCES "public"."bank_loans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_loan_id_loans_id_fk" FOREIGN KEY ("loan_id") REFERENCES "public"."loans"("id") ON DELETE no action ON UPDATE no action;