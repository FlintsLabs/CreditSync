CREATE TABLE "command_receipts" (
  "id" serial PRIMARY KEY NOT NULL,
  "public_id" uuid DEFAULT uuidv7() NOT NULL,
  "tenant_id" text NOT NULL,
  "operation_type" text NOT NULL,
  "operation_key" text NOT NULL,
  "request_hash" text NOT NULL,
  "result" jsonb NOT NULL,
  "audit_public_id" uuid NOT NULL,
  "correlation_id" text NOT NULL,
  "created_by_user_id" integer,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "command_receipts_public_id_unique" UNIQUE("public_id"),
  CONSTRAINT "command_receipts_tenant_audit_fk" FOREIGN KEY ("tenant_id", "audit_public_id") REFERENCES "audit_logs"("tenant_id", "public_id"),
  CONSTRAINT "command_receipts_tenant_created_by_fk" FOREIGN KEY ("tenant_id", "created_by_user_id") REFERENCES "users"("tenant_id", "id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "command_receipts_tenant_id_id_unique" ON "command_receipts" ("tenant_id", "id");
--> statement-breakpoint
CREATE UNIQUE INDEX "command_receipts_tenant_operation_unique" ON "command_receipts" ("tenant_id", "operation_type", "operation_key");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION reject_command_receipt_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'command receipts are append-only';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "command_receipts_immutable" BEFORE UPDATE OR DELETE ON "command_receipts" FOR EACH ROW EXECUTE FUNCTION reject_command_receipt_mutation();
