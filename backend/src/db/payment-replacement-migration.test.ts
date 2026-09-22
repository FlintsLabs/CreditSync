import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getTableConfig } from "drizzle-orm/pg-core";
import { paymentIntakes, paymentReplacementEvidenceReferences, paymentReplacementLineages } from "./schema";

describe("cancelled payment replacement migration", () => {
    test("defines a distinct append-only lineage and immutable evidence references", () => {
        const migration = readFileSync(join(import.meta.dir, "../../drizzle/0079_cancelled_payment_replacement.sql"), "utf8");
        const journal = readFileSync(join(import.meta.dir, "../../drizzle/meta/_journal.json"), "utf8");
        expect(journal).toContain('"tag": "0079_cancelled_payment_replacement"');
        expect(journal).toContain('"tag": "0078_cancelled_restore_attempts"');
        expect(migration).toContain("payment_replacement_lineages");
        expect(migration).toContain("payment_replacement_evidence_references");
        expect(migration).toContain("payment_replacement_lineages_immutable");
        expect(migration).toContain("payment_replacement_evidence_references_immutable");
        expect(getTableConfig(paymentIntakes).columns.some((column) => column.name === "replacement_of_intake_id")).toBe(true);
        expect(getTableConfig(paymentReplacementLineages).columns.map((column) => column.name)).toEqual(expect.arrayContaining(["source_payment_intake_id", "replacement_payment_intake_id", "request_hash", "audit_public_id"]));
        expect(getTableConfig(paymentReplacementEvidenceReferences).columns.map((column) => column.name)).toEqual(expect.arrayContaining(["source_evidence_id", "replacement_payment_intake_id"]));
    });
});
