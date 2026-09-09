ALTER TABLE "loan_disbursement_events" ADD COLUMN "restructure_id" integer;--> statement-breakpoint
ALTER TABLE "loan_disbursement_events" ADD CONSTRAINT "loan_disbursement_events_restructure_fk" FOREIGN KEY ("tenant_id", "restructure_id") REFERENCES "loan_restructures"("tenant_id", "id");--> statement-breakpoint
CREATE INDEX "loan_disbursement_events_tenant_restructure_idx" ON "loan_disbursement_events" USING btree ("tenant_id", "restructure_id");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "guard_disbursement_restructure_relation"() RETURNS trigger AS $$
BEGIN
  IF OLD."restructure_id" IS DISTINCT FROM NEW."restructure_id" THEN
    RAISE EXCEPTION 'loan_disbursement_events restructure relation is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "loan_disbursement_events_restructure_relation_immutable" BEFORE UPDATE ON "loan_disbursement_events" FOR EACH ROW EXECUTE FUNCTION "guard_disbursement_restructure_relation"();
