import { describe, expect, test } from "bun:test";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
    intermediaries,
    intermediaryCollections,
    intermediaryRemittanceAllocations,
    intermediaryRemittanceEvidence,
    intermediaryRemittanceEvidenceIntents,
    intermediaryRemittanceProposals,
    intermediaryRemittances,
} from "./schema";

const backendRoot = `${import.meta.dir}/../../`;

describe("intermediary settlement ledger schema", () => {
    test("exports tenant-scoped intermediary workflow tables with exact lifecycle constraints", () => {
        const intermediary = getTableConfig(intermediaries);
        const collection = getTableConfig(intermediaryCollections);
        const remittance = getTableConfig(intermediaryRemittances);
        const allocation = getTableConfig(intermediaryRemittanceAllocations);
        const proposal = getTableConfig(intermediaryRemittanceProposals);
        const evidence = getTableConfig(intermediaryRemittanceEvidence);
        const evidenceIntent = getTableConfig(intermediaryRemittanceEvidenceIntents);

        expect(intermediary.columns.map((column) => column.name)).toEqual(expect.arrayContaining([
            "public_id", "tenant_id", "name", "normalized_name", "status", "created_at", "updated_at",
        ]));
        expect(collection.columns.map((column) => column.name)).toEqual(expect.arrayContaining([
            "public_id", "tenant_id", "intermediary_id", "borrower_id", "loan_id", "amount",
            "borrower_paid_at", "status", "idempotency_key", "bank_reference_hash", "posted_payment_intake_id", "payment_intake_preexisting",
        ]));
        expect(remittance.columns.map((column) => column.name)).toEqual(expect.arrayContaining([
            "public_id", "tenant_id", "intermediary_id", "gross_amount", "received_at", "status",
            "idempotency_key", "posted_at", "reversed_at",
        ]));
        expect(allocation.columns.map((column) => column.name)).toEqual(expect.arrayContaining([
            "tenant_id", "remittance_id", "collection_id", "allocation_order", "released_at",
        ]));
        expect(proposal.columns.map((column) => column.name)).toEqual(expect.arrayContaining([
            "public_id", "tenant_id", "remittance_id", "version", "status", "selected_total",
            "remaining_balance", "state_hash", "expires_at",
        ]));
        expect(evidence.columns.map((column) => column.name)).toEqual(expect.arrayContaining(["tenant_id", "remittance_id", "file_id"]));
        expect(evidenceIntent.columns.map((column) => column.name)).toEqual(expect.arrayContaining(["public_id", "tenant_id", "remittance_id", "file_id", "status", "evidence_hash", "upload_expires_at"]));

        expect(collection.checks.map((check) => check.name)).toContain("intermediary_collections_status_check");
        expect(remittance.checks.map((check) => check.name)).toContain("intermediary_remittances_status_check");
        expect(allocation.indexes.some((index) => index.config.name === "intermediary_allocations_active_collection_unique" && index.config.unique)).toBe(true);
    });

    test("registers remittance evidence migration", async () => {
        const [journal, sql] = await Promise.all([
            Bun.file(`${backendRoot}drizzle/meta/_journal.json`).json(),
            Bun.file(`${backendRoot}drizzle/0026_intermediary_remittance_evidence.sql`).text(),
        ]);
        expect(sql).toContain('CREATE TABLE "intermediary_remittance_evidence_intents"');
        expect(sql).toContain('CREATE TABLE "intermediary_remittance_evidence"');
        expect(journal.entries.some((entry: { tag: string }) => entry.tag === "0026_intermediary_remittance_evidence")).toBe(true);
    });

    test("registers an additive migration with immutable posted records", async () => {
        const [journal, sql] = await Promise.all([
            Bun.file(`${backendRoot}drizzle/meta/_journal.json`).json(),
            Bun.file(`${backendRoot}drizzle/0023_intermediary_collection_remittance.sql`).text(),
        ]);

        expect(sql).toContain('CREATE TABLE "intermediaries"');
        expect(sql).toContain('CREATE TABLE "intermediary_collections"');
        expect(sql).toContain('CREATE TABLE "intermediary_remittances"');
        expect(sql).toContain('CREATE TABLE "intermediary_remittance_allocations"');
        expect(sql).toContain('CREATE TABLE "intermediary_remittance_proposals"');
        expect(sql).toContain('intermediary_allocations_active_collection_unique');
        expect(sql).toContain('CREATE FUNCTION reject_immutable_intermediary_financial_mutation()');
        expect(sql).toContain('BEFORE UPDATE OR DELETE ON "intermediary_collections"');
        expect(sql).toContain('BEFORE UPDATE OR DELETE ON "intermediary_remittances"');
        expect(journal.entries.some((entry: { tag: string }) => entry.tag === "0023_intermediary_collection_remittance")).toBe(true);
    });
});
