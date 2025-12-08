CREATE TYPE "public"."role" AS ENUM('owner', 'manager', 'collector', 'viewer');--> statement-breakpoint
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
ALTER TABLE "users" ALTER COLUMN "role" SET DEFAULT 'viewer'::"public"."role";--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "role" SET DATA TYPE "public"."role" USING "role"::"public"."role";--> statement-breakpoint
ALTER TABLE "bank_loans" ADD COLUMN "tenant_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "bank_profiles" ADD COLUMN "tenant_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD COLUMN "tenant_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "borrowers" ADD COLUMN "tenant_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN "tenant_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "loans" ADD COLUMN "cloned_from_loan_id" integer;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "tenant_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "tenant_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_uploads" ADD CONSTRAINT "bot_uploads_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE no action ON UPDATE no action;