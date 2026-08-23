ALTER TABLE "loan_commission_participants"
    DROP CONSTRAINT "loan_commission_participants_rate_check";

ALTER TABLE "loan_commission_participants"
    ADD CONSTRAINT "loan_commission_participants_rate_check"
    CHECK ("commission_rate" >= 0 AND "commission_rate" <= 100 AND scale("commission_rate") <= 4);
