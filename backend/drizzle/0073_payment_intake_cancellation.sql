ALTER TABLE "payment_intakes" ADD COLUMN "cancellation_reason" text;
ALTER TABLE "payment_intakes" ADD COLUMN "cancelled_at" timestamptz;
ALTER TABLE "payment_intakes" ADD COLUMN "cancelled_by_user_id" integer;
ALTER TABLE "payment_intakes" ADD COLUMN "cancellation_actor_source" text;
ALTER TABLE "payment_intakes" ADD COLUMN "cancellation_request_id" text;
ALTER TABLE "payment_intakes" ADD COLUMN "cancellation_correlation_id" text;
ALTER TABLE "payment_intakes" ADD COLUMN "cancellation_idempotency_key" text;
ALTER TABLE "payment_intakes" ADD COLUMN "cancellation_request_hash" text;
ALTER TABLE "payment_intakes" ADD COLUMN "cancellation_audit_public_id" uuid;
ALTER TABLE "payment_intakes" DROP CONSTRAINT "payment_intakes_status_check";
ALTER TABLE "payment_intakes" ADD CONSTRAINT "payment_intakes_status_check" CHECK ("status" IN ('draft', 'needs_review', 'ready', 'posted', 'reversed', 'duplicate', 'cancelled'));
ALTER TABLE "payment_intakes" ADD CONSTRAINT "payment_intakes_cancellation_lifecycle_check" CHECK (("status" = 'cancelled' AND "cancellation_reason" IS NOT NULL AND length(trim("cancellation_reason")) BETWEEN 1 AND 2000 AND "cancelled_at" IS NOT NULL AND "cancelled_by_user_id" IS NOT NULL AND "cancellation_actor_source" IS NOT NULL AND length(trim("cancellation_actor_source")) > 0 AND "cancellation_request_id" IS NOT NULL AND length(trim("cancellation_request_id")) > 0 AND "cancellation_correlation_id" IS NOT NULL AND length(trim("cancellation_correlation_id")) > 0 AND "cancellation_idempotency_key" IS NOT NULL AND length(trim("cancellation_idempotency_key")) > 0 AND "cancellation_request_hash" IS NOT NULL AND "cancellation_audit_public_id" IS NOT NULL) OR ("status" <> 'cancelled' AND "cancellation_reason" IS NULL AND "cancelled_at" IS NULL AND "cancelled_by_user_id" IS NULL AND "cancellation_actor_source" IS NULL AND "cancellation_request_id" IS NULL AND "cancellation_correlation_id" IS NULL AND "cancellation_idempotency_key" IS NULL AND "cancellation_request_hash" IS NULL AND "cancellation_audit_public_id" IS NULL));
ALTER TABLE "payment_intakes" ADD CONSTRAINT "payment_intakes_tenant_cancelled_by_fk" FOREIGN KEY ("tenant_id", "cancelled_by_user_id") REFERENCES "users"("tenant_id", "id");
ALTER TABLE "payment_intakes" ADD CONSTRAINT "payment_intakes_tenant_cancellation_audit_fk" FOREIGN KEY ("tenant_id", "cancellation_audit_public_id") REFERENCES "audit_logs"("tenant_id", "public_id") DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE "payment_intake_cancellations" (
  "id" serial PRIMARY KEY NOT NULL,
  "public_id" uuid DEFAULT uuidv7() NOT NULL UNIQUE,
  "tenant_id" text NOT NULL,
  "payment_intake_id" integer NOT NULL,
  "operation_key" text NOT NULL,
  "request_hash" text NOT NULL,
  "reason" text NOT NULL,
  "original_status" text NOT NULL,
  "actor_user_id" integer,
  "actor_source" text NOT NULL,
  "request_id" text NOT NULL,
  "correlation_id" text NOT NULL,
  "audit_public_id" uuid NOT NULL,
  "original_result" jsonb NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "payment_intake_cancellations_tenant_intake_fk" FOREIGN KEY ("tenant_id", "payment_intake_id") REFERENCES "payment_intakes"("tenant_id", "id") DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "payment_intake_cancellations_tenant_actor_fk" FOREIGN KEY ("tenant_id", "actor_user_id") REFERENCES "users"("tenant_id", "id"),
  CONSTRAINT "payment_intake_cancellations_tenant_audit_fk" FOREIGN KEY ("tenant_id", "audit_public_id") REFERENCES "audit_logs"("tenant_id", "public_id"),
  CONSTRAINT "payment_intake_cancellations_reason_check" CHECK (length(trim("reason")) BETWEEN 1 AND 2000)
);
CREATE UNIQUE INDEX "payment_intake_cancellations_tenant_id_id_unique" ON "payment_intake_cancellations" ("tenant_id", "id");
CREATE UNIQUE INDEX "payment_intake_cancellations_tenant_operation_unique" ON "payment_intake_cancellations" ("tenant_id", "operation_key");
CREATE UNIQUE INDEX "payment_intake_cancellations_tenant_intake_unique" ON "payment_intake_cancellations" ("tenant_id", "payment_intake_id");
CREATE OR REPLACE FUNCTION verify_payment_intake_cancellation_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE intake_row RECORD;
BEGIN
  SELECT * INTO intake_row FROM payment_intakes WHERE tenant_id = NEW.tenant_id AND id = NEW.payment_intake_id;
  IF intake_row.id IS NULL OR intake_row.status <> 'cancelled'
    OR intake_row.cancellation_reason IS DISTINCT FROM NEW.reason
    OR intake_row.cancellation_idempotency_key IS DISTINCT FROM NEW.operation_key
    OR intake_row.cancellation_request_hash IS DISTINCT FROM NEW.request_hash
    OR intake_row.cancellation_actor_source IS DISTINCT FROM NEW.actor_source
    OR intake_row.cancellation_request_id IS DISTINCT FROM NEW.request_id
    OR intake_row.cancellation_correlation_id IS DISTINCT FROM NEW.correlation_id
    OR intake_row.cancelled_by_user_id IS DISTINCT FROM NEW.actor_user_id
    OR intake_row.cancellation_audit_public_id IS DISTINCT FROM NEW.audit_public_id
    OR NEW.original_status NOT IN ('draft', 'needs_review', 'ready') THEN
    RAISE EXCEPTION 'cancellation receipt does not match cancelled intake';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER "payment_intake_cancellations_match_intake" BEFORE INSERT ON "payment_intake_cancellations" FOR EACH ROW EXECUTE FUNCTION verify_payment_intake_cancellation_receipt();
CREATE OR REPLACE FUNCTION reject_payment_intake_cancellation_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'payment intake cancellations are immutable'; END; $$;
CREATE TRIGGER "payment_intake_cancellations_immutable" BEFORE UPDATE OR DELETE ON "payment_intake_cancellations" FOR EACH ROW EXECUTE FUNCTION reject_payment_intake_cancellation_mutation();
CREATE OR REPLACE FUNCTION guard_payment_intake_cancellation_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'cancelled' THEN RAISE EXCEPTION 'cancelled payment intakes require an existing intake and receipt'; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'cancelled' THEN RAISE EXCEPTION 'cancelled payment intakes are immutable'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'cancelled' THEN RAISE EXCEPTION 'cancelled payment intakes are immutable'; END IF;
  IF NEW.status = 'cancelled' AND OLD.status NOT IN ('draft','needs_review','ready') THEN RAISE EXCEPTION 'only unposted payment intakes can be cancelled'; END IF;
  IF OLD.status = 'cancelled' AND NEW.status <> 'cancelled' THEN RAISE EXCEPTION 'cancelled payment intakes cannot be reactivated'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER "payment_intakes_cancellation_guard" BEFORE INSERT OR UPDATE OR DELETE ON "payment_intakes" FOR EACH ROW EXECUTE FUNCTION guard_payment_intake_cancellation_transition();
CREATE OR REPLACE FUNCTION verify_payment_intake_cancellation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'cancelled' THEN RETURN NEW; END IF;
  IF NOT EXISTS (SELECT 1 FROM payment_intake_cancellations c WHERE c.tenant_id = NEW.tenant_id AND c.payment_intake_id = NEW.id AND c.audit_public_id = NEW.cancellation_audit_public_id AND c.request_hash = NEW.cancellation_request_hash) THEN
    RAISE EXCEPTION 'cancelled payment intake requires a matching immutable receipt';
  END IF;
  IF EXISTS (SELECT 1 FROM transactions t WHERE t.tenant_id = NEW.tenant_id AND t.payment_intake_id = NEW.id) THEN
    RAISE EXCEPTION 'payment intake with financial effects cannot be cancelled';
  END IF;
  RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER "payment_intakes_cancellation_receipt_guard" AFTER INSERT OR UPDATE ON payment_intakes DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_payment_intake_cancellation();
CREATE OR REPLACE FUNCTION reject_transaction_for_cancelled_payment_intake() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.payment_intake_id IS NOT NULL AND EXISTS (SELECT 1 FROM payment_intakes WHERE tenant_id = NEW.tenant_id AND id = NEW.payment_intake_id AND status = 'cancelled') THEN
    RAISE EXCEPTION 'cancelled payment intakes cannot receive financial effects';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER "transactions_cancelled_payment_intake_guard" BEFORE INSERT OR UPDATE ON transactions FOR EACH ROW EXECUTE FUNCTION reject_transaction_for_cancelled_payment_intake();
--> statement-breakpoint
