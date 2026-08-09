import { describe, expect, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { getTableConfig, PgDialect, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "./schema";

const expectedWorkflowTables = [
    "borrowerAliases",
    "paymentIntakes",
    "paymentEvidence",
    "paymentMatchProposals",
    "paymentMatchAllocations",
    "loanRenewals",
    "loanAdjustments",
] as const;

function workflowTable(exportName: string): PgTable {
    const table = (schema as Record<string, unknown>)[exportName];
    expect(table, `missing Drizzle export ${exportName}`).toBeDefined();
    return table as PgTable;
}

function tableColumnNames(table: PgTable): string[] {
    return getTableConfig(table).columns.map((column) => column.name);
}

function uniqueIndexNames(table: PgTable): string[] {
    return getTableConfig(table).indexes
        .filter((index) => index.config.unique)
        .map((index) => index.config.name)
        .filter((name): name is string => name !== undefined);
}

describe("agent workflow Drizzle schema", () => {
    test("exports every additive workflow table with tenant, UUIDv7, timestamps, actor, and status metadata", () => {
        for (const exportName of expectedWorkflowTables) {
            const table = workflowTable(exportName);
            const columns = tableColumnNames(table);

            expect(columns).toContain("tenant_id");
            expect(columns).toContain("public_id");
            expect(columns).toContain("created_at");
            expect(columns).toContain("updated_at");
            expect(columns).toContain("status");
            expect(
                columns.some((column) => column.endsWith("_by_user_id")),
                `${exportName} needs an actor user column`,
            ).toBe(true);

            const publicId = getTableConfig(table).columns.find((column) => column.name === "public_id");
            expect(new PgDialect().sqlToQuery(publicId?.default as SQL).sql).toBe("uuidv7()");
        }
    });

    test("models tenant-scoped duplicate and reversal invariants as unique indexes", () => {
        const expectedIndexes: Record<string, string[]> = {
            borrowerAliases: ["borrower_aliases_tenant_borrower_normalized_unique"],
            paymentIntakes: [
                "payment_intakes_tenant_idempotency_unique",
                "payment_intakes_tenant_bank_reference_hash_unique",
                "payment_intakes_tenant_qr_payload_hash_unique",
            ],
            paymentEvidence: ["payment_evidence_tenant_evidence_hash_unique"],
            paymentMatchProposals: ["payment_match_proposals_tenant_intake_version_unique"],
            loanRenewals: ["loan_renewals_tenant_idempotency_unique"],
            loanAdjustments: ["loan_adjustments_tenant_idempotency_unique"],
            transactions: [
                "transactions_tenant_idempotency_unique",
                "transactions_tenant_reversed_transaction_unique",
            ],
        };

        for (const [exportName, indexNames] of Object.entries(expectedIndexes)) {
            expect(uniqueIndexNames(workflowTable(exportName))).toEqual(expect.arrayContaining(indexNames));
        }
    });

    test("extends transactions and audit logs without replacing legacy columns", () => {
        const transactionColumns = tableColumnNames(workflowTable("transactions"));
        expect(transactionColumns).toEqual(expect.arrayContaining([
            "payment_intake_id",
            "entry_type",
            "reversed_transaction_id",
            "idempotency_key",
            "posted_at",
            "type",
            "slip_url",
        ]));

        const auditColumns = tableColumnNames(workflowTable("auditLogs"));
        expect(auditColumns).toEqual(expect.arrayContaining([
            "actor_source",
            "request_id",
            "correlation_id",
        ]));

        const postedAt = getTableConfig(workflowTable("transactions")).columns
            .find((column) => column.name === "posted_at");
        expect(postedAt?.notNull).toBe(true);
        expect(new PgDialect().sqlToQuery(postedAt?.default as SQL).sql).toBe("now()");
    });

    test("constrains persisted workflow and actor statuses to the product vocabulary", () => {
        const expectedChecks: Record<string, string> = {
            borrowerAliases: "borrower_aliases_status_check",
            paymentIntakes: "payment_intakes_status_check",
            paymentEvidence: "payment_evidence_status_check",
            paymentMatchProposals: "payment_match_proposals_status_check",
            paymentMatchAllocations: "payment_match_allocations_status_check",
            loanRenewals: "loan_renewals_status_check",
            loanAdjustments: "loan_adjustments_status_check",
            auditLogs: "audit_logs_actor_source_check",
        };

        for (const [exportName, constraintName] of Object.entries(expectedChecks)) {
            const checkNames = getTableConfig(workflowTable(exportName)).checks.map((check) => check.name);
            expect(checkNames).toContain(constraintName);
        }
    });
});
