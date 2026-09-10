ALTER TABLE "payment_batch_staging_items" ADD COLUMN "reviewed_mapping" jsonb;
--> statement-breakpoint
CREATE TABLE "payment_batch_dependencies" (
  "id" serial PRIMARY KEY NOT NULL,
  "public_id" uuid DEFAULT uuidv7() NOT NULL,
  "tenant_id" text NOT NULL,
  "source_batch_id" integer NOT NULL,
  "destination_batch_id" integer NOT NULL,
  "relation" text NOT NULL,
  "source_revision" integer NOT NULL,
  "destination_revision" integer NOT NULL,
  "reason" text NOT NULL,
  "provenance" jsonb NOT NULL,
  "created_by_user_id" integer,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "payment_batch_dependencies_public_id_unique" UNIQUE("public_id"),
  CONSTRAINT "payment_batch_dependencies_relation_check" CHECK ("relation" = 'split'),
  CONSTRAINT "payment_batch_dependencies_tenant_source_fk" FOREIGN KEY ("tenant_id", "source_batch_id") REFERENCES "payment_batches"("tenant_id", "id"),
  CONSTRAINT "payment_batch_dependencies_tenant_destination_fk" FOREIGN KEY ("tenant_id", "destination_batch_id") REFERENCES "payment_batches"("tenant_id", "id"),
  CONSTRAINT "payment_batch_dependencies_tenant_actor_fk" FOREIGN KEY ("tenant_id", "created_by_user_id") REFERENCES "users"("tenant_id", "id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "payment_batch_dependencies_tenant_id_id_unique" ON "payment_batch_dependencies" ("tenant_id", "id");
--> statement-breakpoint
CREATE UNIQUE INDEX "payment_batch_dependencies_tenant_source_destination_unique" ON "payment_batch_dependencies" ("tenant_id", "source_batch_id", "destination_batch_id");
--> statement-breakpoint
CREATE TRIGGER "payment_batch_dependencies_immutable" BEFORE UPDATE OR DELETE ON "payment_batch_dependencies" FOR EACH ROW EXECUTE FUNCTION reject_payment_batch_receipt_mutation();
