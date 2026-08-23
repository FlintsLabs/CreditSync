-- Correct the posted-batch immutability trigger without rewriting the 0051 schema checkpoint.
CREATE OR REPLACE FUNCTION "payment_batch_posted_immutable_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_TABLE_NAME = 'payment_batches' AND OLD."status" = 'posted' THEN
        RAISE EXCEPTION 'posted payment batch is immutable' USING ERRCODE = '23514';
    ELSIF TG_TABLE_NAME = 'payment_batch_items' AND EXISTS (
        SELECT 1 FROM "payment_batches" b WHERE b."tenant_id" = OLD."tenant_id" AND b."id" = ((to_jsonb(OLD)->>'batch_id')::integer) AND b."status" = 'posted'
    ) THEN
        RAISE EXCEPTION 'posted payment batch item is immutable' USING ERRCODE = '23514';
    ELSIF TG_TABLE_NAME = 'payment_batch_previews' AND EXISTS (
        SELECT 1 FROM "payment_batches" b WHERE b."tenant_id" = OLD."tenant_id" AND b."id" = ((to_jsonb(OLD)->>'batch_id')::integer) AND b."status" = 'posted'
    ) THEN
        RAISE EXCEPTION 'posted payment batch preview is immutable' USING ERRCODE = '23514';
    ELSIF TG_TABLE_NAME = 'payment_batch_allocations' AND EXISTS (
        SELECT 1 FROM "payment_batch_previews" p JOIN "payment_batches" b ON b."tenant_id" = p."tenant_id" AND b."id" = p."batch_id"
        WHERE p."tenant_id" = OLD."tenant_id" AND p."id" = ((to_jsonb(OLD)->>'preview_id')::integer) AND b."status" = 'posted'
    ) THEN
        RAISE EXCEPTION 'posted payment batch allocation is immutable' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
END;
$$;
