ALTER TABLE "loans" DROP CONSTRAINT IF EXISTS "loans_status_check";--> statement-breakpoint
ALTER TABLE "loans" ADD CONSTRAINT "loans_status_check" CHECK ("status" IN ('draft', 'active', 'paid', 'defaulted', 'replaced'));--> statement-breakpoint
CREATE TABLE "loan_replacements" (
  "id" serial PRIMARY KEY NOT NULL,
  "public_id" uuid DEFAULT uuidv7() NOT NULL UNIQUE,
  "tenant_id" text NOT NULL,
  "old_loan_id" integer NOT NULL,
  "replacement_loan_id" integer NOT NULL,
  "status" text DEFAULT 'preview' NOT NULL,
  "reason" text NOT NULL,
  "old_balance_version" text NOT NULL,
  "replacement_draft_version" text NOT NULL,
  "preview_hash" text NOT NULL,
  "request_hash" text NOT NULL,
  "pre_execution_snapshot" jsonb,
  "expires_at" timestamptz NOT NULL,
  "execute_idempotency_key" text,
  "reversal_idempotency_key" text,
  "created_by_user_id" integer,
  "executed_by_user_id" integer,
  "reversed_by_user_id" integer,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "loan_replacements_status_check" CHECK (status IN ('preview', 'executed', 'reversed', 'expired')),
  CONSTRAINT "loan_replacements_tenant_old_loan_fk" FOREIGN KEY (tenant_id, old_loan_id) REFERENCES loans(tenant_id, id),
  CONSTRAINT "loan_replacements_tenant_replacement_loan_fk" FOREIGN KEY (tenant_id, replacement_loan_id) REFERENCES loans(tenant_id, id),
  CONSTRAINT "loan_replacements_tenant_created_by_fk" FOREIGN KEY (tenant_id, created_by_user_id) REFERENCES users(tenant_id, id),
  CONSTRAINT "loan_replacements_tenant_executed_by_fk" FOREIGN KEY (tenant_id, executed_by_user_id) REFERENCES users(tenant_id, id),
  CONSTRAINT "loan_replacements_tenant_reversed_by_fk" FOREIGN KEY (tenant_id, reversed_by_user_id) REFERENCES users(tenant_id, id)
);--> statement-breakpoint
CREATE UNIQUE INDEX "loan_replacements_tenant_id_id_unique" ON "loan_replacements" (tenant_id, id);--> statement-breakpoint
CREATE TABLE "loan_replacement_corrections" (
  "id" serial PRIMARY KEY NOT NULL,
  "public_id" uuid DEFAULT uuidv7() NOT NULL UNIQUE,
  "tenant_id" text NOT NULL,
  "replacement_id" integer NOT NULL,
  "loan_id" integer NOT NULL,
  "status" text DEFAULT 'posted' NOT NULL,
  "principal" numeric(18,2) DEFAULT '0' NOT NULL,
  "interest" numeric(18,2) DEFAULT '0' NOT NULL,
  "fee" numeric(18,2) DEFAULT '0' NOT NULL,
  "penalty" numeric(18,2) DEFAULT '0' NOT NULL,
  "reason" text NOT NULL,
  "created_by_user_id" integer,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "loan_replacement_corrections_tenant_replacement_fk" FOREIGN KEY (tenant_id, replacement_id) REFERENCES loan_replacements(tenant_id, id),
  CONSTRAINT "loan_replacement_corrections_tenant_loan_fk" FOREIGN KEY (tenant_id, loan_id) REFERENCES loans(tenant_id, id),
  CONSTRAINT "loan_replacement_corrections_tenant_created_by_fk" FOREIGN KEY (tenant_id, created_by_user_id) REFERENCES users(tenant_id, id)
);--> statement-breakpoint
CREATE UNIQUE INDEX "loan_replacements_tenant_execute_key_unique" ON "loan_replacements" (tenant_id, execute_idempotency_key) WHERE execute_idempotency_key IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "loan_replacements_tenant_reversal_key_unique" ON "loan_replacements" (tenant_id, reversal_idempotency_key) WHERE reversal_idempotency_key IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "loan_replacements_tenant_old_executed_unique" ON "loan_replacements" (tenant_id, old_loan_id) WHERE status = 'executed';--> statement-breakpoint
CREATE UNIQUE INDEX "loan_replacements_tenant_replacement_executed_unique" ON "loan_replacements" (tenant_id, replacement_loan_id) WHERE status = 'executed';--> statement-breakpoint
CREATE UNIQUE INDEX "loan_replacement_corrections_tenant_id_id_unique" ON "loan_replacement_corrections" (tenant_id, id);--> statement-breakpoint
