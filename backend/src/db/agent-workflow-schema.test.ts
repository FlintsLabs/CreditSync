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
    "loanRestructures",
    "loanOpeningBalanceComponents",
    "loanRestructureWaivers",
    "loanReplacements",
    "loanReplacementCorrections",
] as const;

function workflowTable(exportName: string): PgTable {
    const table = (schema as Record<string, unknown>)[exportName];
    expect(table, `missing Drizzle export ${exportName}`).toBeDefined();
    return table as PgTable;
}

function tableColumnNames(table: PgTable): string[] {
    return getTableConfig(table).columns.map((column) => column.name);
}

function uniqueIndexContract(table: PgTable, name: string) {
    const index = getTableConfig(table).indexes.find((candidate) => candidate.config.name === name);
    expect(index, `missing unique index ${name}`).toBeDefined();
    expect(index?.config.unique, `${name} must be unique`).toBe(true);
    return {
        columns: index!.config.columns.map((column) => (column as { name?: string }).name),
        where: index!.config.where
            ? new PgDialect().sqlToQuery(index!.config.where).sql
            : null,
    };
}

describe("agent workflow Drizzle schema", () => {
    test("persists the exact signer-returned payment evidence expiry", () => {
        expect(Object.keys(schema.paymentEvidence)).toContain("uploadExpiresAt");
    });
    test("exports every additive workflow table with tenant, UUIDv7, timestamps, actor, and status metadata", () => {
        for (const exportName of expectedWorkflowTables) {
            const table = workflowTable(exportName);
            const columns = tableColumnNames(table);

            expect(columns).toContain("tenant_id");
            expect(columns).toContain("public_id");
            expect(columns).toContain("created_at");
            if (exportName === "loanReplacementCorrections") {
                expect(columns).not.toContain("updated_at");
            } else {
                expect(columns).toContain("updated_at");
            }
            expect(columns).toContain("status");
            expect(
                columns.some((column) => column.endsWith("_by_user_id")),
                `${exportName} needs an actor user column`,
            ).toBe(true);

            const publicId = getTableConfig(table).columns.find((column) => column.name === "public_id");
            expect(new PgDialect().sqlToQuery(publicId?.default as SQL).sql).toBe("uuidv7()");
        }
    });

    test("models exact tenant-scoped unique index columns and nullable-key predicates", () => {
        const expectedIndexes: Record<string, Record<string, { columns: string[]; where: string | null }>> = {
            users: {
                users_tenant_id_id_unique: { columns: ["tenant_id", "id"], where: null },
            },
            borrowers: {
                borrowers_tenant_id_id_unique: { columns: ["tenant_id", "id"], where: null },
            },
            files: {
                files_tenant_id_id_unique: { columns: ["tenant_id", "id"], where: null },
            },
            loans: {
                loans_tenant_id_id_unique: { columns: ["tenant_id", "id"], where: null },
            },
            loanSchedules: {
                loan_schedules_tenant_id_id_unique: { columns: ["tenant_id", "id"], where: null },
            },
            borrowerAliases: {
                borrower_aliases_tenant_borrower_normalized_unique: {
                    columns: ["tenant_id", "borrower_id", "normalized_alias"],
                    where: null,
                },
            },
            paymentIntakes: {
                payment_intakes_tenant_id_id_unique: { columns: ["tenant_id", "id"], where: null },
                payment_intakes_tenant_idempotency_unique: {
                    columns: ["tenant_id", "idempotency_key"],
                    where: '"payment_intakes"."idempotency_key" IS NOT NULL',
                },
                payment_intakes_tenant_bank_reference_hash_unique: {
                    columns: ["tenant_id", "bank_reference_hash"],
                    where: '"payment_intakes"."bank_reference_hash" IS NOT NULL',
                },
                payment_intakes_tenant_qr_payload_hash_unique: {
                    columns: ["tenant_id", "qr_payload_hash"],
                    where: '"payment_intakes"."qr_payload_hash" IS NOT NULL',
                },
            },
            paymentEvidence: {
                payment_evidence_tenant_evidence_hash_unique: {
                    columns: ["tenant_id", "evidence_hash"],
                    where: '"payment_evidence"."evidence_hash" IS NOT NULL',
                },
            },
            paymentMatchProposals: {
                payment_match_proposals_tenant_id_id_unique: { columns: ["tenant_id", "id"], where: null },
                payment_match_proposals_tenant_intake_version_unique: {
                    columns: ["tenant_id", "payment_intake_id", "version"],
                    where: null,
                },
            },
            loanRenewals: {
                loan_renewals_tenant_id_id_unique: { columns: ["tenant_id", "id"], where: null },
                loan_renewals_tenant_idempotency_unique: {
                    columns: ["tenant_id", "idempotency_key"],
                    where: '"loan_renewals"."idempotency_key" IS NOT NULL',
                },
            },
            loanAdjustments: {
                loan_adjustments_tenant_id_id_unique: { columns: ["tenant_id", "id"], where: null },
                loan_adjustments_tenant_idempotency_unique: {
                    columns: ["tenant_id", "idempotency_key"],
                    where: '"loan_adjustments"."idempotency_key" IS NOT NULL',
                },
                loan_adjustments_tenant_reversed_adjustment_unique: {
                    columns: ["tenant_id", "reversed_adjustment_id"],
                    where: '"loan_adjustments"."reversed_adjustment_id" IS NOT NULL',
                },
            },
            loanRestructures: {
                loan_restructures_tenant_id_id_unique: { columns: ["tenant_id", "id"], where: null },
                loan_restructures_tenant_execute_key_unique: {
                    columns: ["tenant_id", "execute_idempotency_key"],
                    where: '"loan_restructures"."execute_idempotency_key" IS NOT NULL',
                },
                loan_restructures_tenant_reversal_key_unique: {
                    columns: ["tenant_id", "reversal_idempotency_key"],
                    where: '"loan_restructures"."reversal_idempotency_key" IS NOT NULL',
                },
            },
            loanOpeningBalanceComponents: {
                loan_opening_balance_components_tenant_id_id_unique: { columns: ["tenant_id", "id"], where: null },
            },
            loanRestructureWaivers: {
                loan_restructure_waivers_tenant_id_id_unique: { columns: ["tenant_id", "id"], where: null },
                loan_restructure_waivers_tenant_execute_key_unique: {
                    columns: ["tenant_id", "execute_idempotency_key"],
                    where: null,
                },
            },
            loanReplacements: {
                loan_replacements_tenant_id_id_unique: { columns: ["tenant_id", "id"], where: null },
                loan_replacements_tenant_execute_key_unique: { columns: ["tenant_id", "execute_idempotency_key"], where: '"loan_replacements"."execute_idempotency_key" IS NOT NULL' },
                loan_replacements_tenant_reversal_key_unique: { columns: ["tenant_id", "reversal_idempotency_key"], where: '"loan_replacements"."reversal_idempotency_key" IS NOT NULL' },
                loan_replacements_tenant_old_executed_unique: { columns: ["tenant_id", "old_loan_id"], where: '"loan_replacements"."status" = \'executed\'' },
                loan_replacements_tenant_replacement_executed_unique: { columns: ["tenant_id", "replacement_loan_id"], where: '"loan_replacements"."status" = \'executed\'' },
            },
            loanReplacementCorrections: {
                loan_replacement_corrections_tenant_id_id_unique: { columns: ["tenant_id", "id"], where: null },
            },
            transactions: {
                transactions_tenant_id_id_unique: { columns: ["tenant_id", "id"], where: null },
                transactions_tenant_idempotency_unique: {
                    columns: ["tenant_id", "idempotency_key"],
                    where: '"transactions"."idempotency_key" IS NOT NULL',
                },
                transactions_tenant_reversed_transaction_unique: {
                    columns: ["tenant_id", "reversed_transaction_id"],
                    where: '"transactions"."reversed_transaction_id" IS NOT NULL',
                },
            },
        };

        for (const [exportName, indexes] of Object.entries(expectedIndexes)) {
            for (const [name, expected] of Object.entries(indexes)) {
                expect(uniqueIndexContract(workflowTable(exportName), name)).toEqual(expected);
            }
        }
    });

    test("uses tenant-safe composite foreign keys for every new tenant-owned relationship", () => {
        const expectedRelationships: Record<string, Record<string, string>> = {
            borrowerAliases: {
                borrower_id: "borrowers",
                created_by_user_id: "users",
                updated_by_user_id: "users",
            },
            paymentIntakes: {
                owner_user_id: "users",
                duplicate_of_intake_id: "payment_intakes",
                created_by_user_id: "users",
                updated_by_user_id: "users",
                posted_by_user_id: "users",
            },
            paymentEvidence: {
                payment_intake_id: "payment_intakes",
                file_id: "files",
                created_by_user_id: "users",
                updated_by_user_id: "users",
            },
            paymentMatchProposals: {
                payment_intake_id: "payment_intakes",
                created_by_user_id: "users",
                updated_by_user_id: "users",
            },
            paymentMatchAllocations: {
                proposal_id: "payment_match_proposals",
                borrower_id: "borrowers",
                loan_id: "loans",
                schedule_id: "loan_schedules",
                created_by_user_id: "users",
                updated_by_user_id: "users",
            },
            loanRenewals: {
                old_loan_id: "loans",
                new_loan_id: "loans",
                created_by_user_id: "users",
                updated_by_user_id: "users",
                executed_by_user_id: "users",
                reversed_by_user_id: "users",
            },
            loanAdjustments: {
                loan_id: "loans",
                renewal_id: "loan_renewals",
                reversed_adjustment_id: "loan_adjustments",
                created_by_user_id: "users",
                updated_by_user_id: "users",
            },
            loanRestructures: {
                old_loan_id: "loans",
                new_loan_id: "loans",
                created_by_user_id: "users",
                updated_by_user_id: "users",
                executed_by_user_id: "users",
                reversed_by_user_id: "users",
            },
            loanOpeningBalanceComponents: {
                restructure_id: "loan_restructures",
                loan_id: "loans",
                created_by_user_id: "users",
            },
            loanRestructureWaivers: {
                restructure_id: "loan_restructures",
                loan_id: "loans",
                reversed_waiver_id: "loan_restructure_waivers",
                created_by_user_id: "users",
                reversed_by_user_id: "users",
            },
            loanReplacements: {
                old_loan_id: "loans", replacement_loan_id: "loans", created_by_user_id: "users", executed_by_user_id: "users", reversed_by_user_id: "users",
            },
            loanReplacementCorrections: {
                replacement_id: "loan_replacements", loan_id: "loans", created_by_user_id: "users",
            },
            transactions: {
                payment_intake_id: "payment_intakes",
                reversed_transaction_id: "transactions",
            },
        };

        for (const [exportName, relationships] of Object.entries(expectedRelationships)) {
            const foreignKeys = getTableConfig(workflowTable(exportName)).foreignKeys;
            for (const [idColumn, foreignTableName] of Object.entries(relationships)) {
                const foreignKey = foreignKeys.find((candidate) => {
                    const reference = candidate.reference();
                    return reference.columns.some((column) => column.name === idColumn)
                        && getTableConfig(reference.foreignTable).name === foreignTableName;
                });
                expect(foreignKey, `${exportName}.${idColumn} must have a foreign key`).toBeDefined();
                const reference = foreignKey!.reference();
                expect(reference.columns.map((column) => column.name)).toEqual(["tenant_id", idColumn]);
                expect(reference.foreignColumns.map((column) => column.name)).toEqual(["tenant_id", "id"]);
            }
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

        const legacyLoanBorrowerReference = getTableConfig(workflowTable("loans")).foreignKeys
            .map((foreignKey) => foreignKey.reference())
            .find((reference) => reference.columns.some((column) => column.name === "borrower_id"));
        expect(legacyLoanBorrowerReference, "loans.borrower_id legacy FK must remain").toBeDefined();
        expect(legacyLoanBorrowerReference?.foreignColumns.map((column) => column.name)).toEqual(["id"]);
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
            loanRestructures: "loan_restructures_status_check",
            loanOpeningBalanceComponents: "loan_opening_balance_components_kind_check",
            loanRestructureWaivers: "loan_restructure_waivers_status_check",
            loanReplacements: "loan_replacements_status_check",
            auditLogs: "audit_logs_actor_source_check",
        };

        for (const [exportName, constraintName] of Object.entries(expectedChecks)) {
            const checkNames = getTableConfig(workflowTable(exportName)).checks.map((check) => check.name);
            expect(checkNames).toContain(constraintName);
        }
    });
});
