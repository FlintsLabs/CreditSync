import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getTableConfig } from "drizzle-orm/pg-core";
import { paymentDuplicateReviewCandidates, paymentDuplicateReviewExecutions, paymentDuplicateReviewMemberships, paymentDuplicateReviews } from "./schema";

describe("cancelled duplicate review migration contract", () => {
    test("adds the next append-only tenant-scoped review ledger", () => {
        const migration = readFileSync(join(import.meta.dir, "../../drizzle/0080_cancelled_payment_duplicate_reviews.sql"), "utf8");
        const journal = readFileSync(join(import.meta.dir, "../../drizzle/meta/_journal.json"), "utf8");
        expect(journal).toContain('"tag": "0080_cancelled_payment_duplicate_reviews"');
        for (const table of ["payment_duplicate_reviews", "payment_duplicate_review_candidates", "payment_duplicate_review_executions", "payment_duplicate_review_memberships"]) expect(migration).toContain(`CREATE TABLE "${table}"`);
        for (const trigger of ["payment_duplicate_reviews_immutable", "payment_duplicate_review_candidates_immutable", "payment_duplicate_review_executions_immutable", "payment_duplicate_review_memberships_immutable"]) expect(migration).toContain(trigger);
        expect(getTableConfig(paymentDuplicateReviews).columns.map((column) => column.name)).toEqual(expect.arrayContaining(["tenant_id", "canonical_payment_intake_id", "preview_hash", "evidence_hash", "dependency_hash", "expires_at"]));
        expect(getTableConfig(paymentDuplicateReviewCandidates).columns.map((column) => column.name)).toEqual(expect.arrayContaining(["review_id", "candidate_payment_intake_id", "candidate_state_hash"]));
        expect(getTableConfig(paymentDuplicateReviewExecutions).columns.map((column) => column.name)).toEqual(expect.arrayContaining(["review_id", "idempotency_key", "audit_public_id", "confirmed_at"]));
        expect(getTableConfig(paymentDuplicateReviewMemberships).columns.map((column) => column.name)).toEqual(expect.arrayContaining(["canonical_payment_intake_id", "candidate_payment_intake_id", "execution_id"]));
    });
});
