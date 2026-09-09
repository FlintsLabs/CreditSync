ALTER TABLE "loan_renewals" ADD COLUMN "renewal_date" date;
ALTER TABLE "loan_renewals" ADD COLUMN "payment_start_date" date;
UPDATE "loan_renewals"
SET "renewal_date" = NULLIF("composition"->>'renewalDate', '')::date
WHERE "renewal_date" IS NULL
  AND "composition" IS NOT NULL
  AND "composition" ? 'renewalDate';
