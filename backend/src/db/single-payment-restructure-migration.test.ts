import { describe, expect, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { getTableConfig, PgDialect, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "./schema";

const backendRoot = `${import.meta.dir}/../../`;
const migrationTag = "0027_single_payment_restructure";
const migrationPath = `${backendRoot}drizzle/${migrationTag}.sql`;

function table(exportName: string): PgTable {
    const value = (schema as Record<string, unknown>)[exportName];
    expect(value, `missing Drizzle export ${exportName}`).toBeDefined();
    return value as PgTable;
}

function config(exportName: string) {
    return getTableConfig(table(exportName));
}

function columnNames(exportName: string) {
    return config(exportName).columns.map((column) => column.name);
}

function expectTenantForeignKey(exportName: string, columnName: string, foreignTable: string) {
    const foreignKey = config(exportName).foreignKeys.find((candidate) => {
        const reference = candidate.reference();
        return reference.columns.some((column) => column.name === columnName)
            && getTableConfig(reference.foreignTable).name === foreignTable;
    });
    expect(foreignKey, `${exportName}.${columnName} needs a tenant-safe foreign key`).toBeDefined();
    const reference = foreignKey!.reference();
    expect(reference.columns.map((column) => column.name)).toEqual(["tenant_id", columnName]);
    expect(reference.foreignColumns.map((column) => column.name)).toEqual(["tenant_id", "id"]);
}

describe("single-payment restructure schema contract", () => {
    test("registers the next additive migration without rewriting historical repayment types", async () => {
        const [journal, file] = await Promise.all([
            Bun.file(`${backendRoot}drizzle/meta/_journal.json`).json(),
            Bun.file(migrationPath),
        ]);
        expect(await file.exists()).toBe(true);
        const migration = await file.text();

        expect(journal.entries).toEqual(expect.arrayContaining([expect.objectContaining({ idx: 27, tag: migrationTag })]));
        expect(migration).toContain('ALTER TABLE "loans" ADD COLUMN "single_payment_due_date" date');
        expect(migration).toContain('ALTER TABLE "loans" ADD COLUMN "floating_accrual_cycle" text');
        expect(migration).toMatch(/UPDATE "loans"[\s\S]+SET "floating_accrual_cycle" = 'daily'[\s\S]+WHERE "repayment_type" = 'floating'/);
        expect(migration).not.toMatch(/UPDATE "loans"[\s\S]+SET "repayment_type" = 'single_payment'/);
        expect(migration).toContain('CREATE TABLE "loan_restructures"');
        expect(migration).toContain('CREATE TABLE "loan_opening_balance_components"');
        expect(migration).toContain('CREATE TABLE "loan_restructure_waivers"');
        expect(migration).not.toMatch(/\bDROP\s+(TABLE|COLUMN)\b/i);
    });

    test("adds closed single-payment, floating-cycle, and late-penalty columns to loans", () => {
        expect(columnNames("loans")).toEqual(expect.arrayContaining([
            "single_payment_due_date",
            "single_payment_fixed_agreed_interest",
            "single_payment_interest_policy",
            "single_payment_retroactive_rate_type",
            "single_payment_retroactive_rate",
            "floating_accrual_cycle",
            "single_payment_late_penalty_mode",
            "single_payment_late_penalty_amount_per_day",
            "single_payment_late_penalty_grace_days",
        ]));
        expect(config("loans").checks.map((check) => check.name)).toEqual(expect.arrayContaining([
            "loans_single_payment_terms_check",
            "loans_floating_accrual_cycle_check",
            "loans_single_payment_money_check",
        ]));
    });

    test("stores every gross, waived, and net component as an exact numeric column", () => {
        const expectedNumericColumns = [
            "gross_principal", "gross_interest", "gross_fees", "gross_penalty",
            "waived_interest", "waived_fees", "waived_penalty",
            "net_principal", "net_interest", "net_fees", "net_penalty",
            "external_settlement_credits", "additional_principal", "cash_amount",
        ];
        const restructureConfig = config("loanRestructures");
        for (const columnName of expectedNumericColumns) {
            const column = restructureConfig.columns.find((candidate) => candidate.name === columnName);
            expect(column, `missing loan_restructures.${columnName}`).toBeDefined();
            expect(column!.getSQLType()).toBe("numeric");
        }
        expect(config("loanOpeningBalanceComponents").columns.find((column) => column.name === "amount")?.getSQLType()).toBe("numeric");
        expect(config("loanRestructureWaivers").columns.find((column) => column.name === "amount")?.getSQLType()).toBe("numeric");
    });

    test("uses UUIDv7 public IDs, closed statuses, durable tenant request keys, and public source lineage", () => {
        for (const exportName of ["loanRestructures", "loanOpeningBalanceComponents", "loanRestructureWaivers"]) {
            const publicId = config(exportName).columns.find((column) => column.name === "public_id");
            expect(new PgDialect().sqlToQuery(publicId?.default as SQL).sql).toBe("uuidv7()");
        }
        expect(columnNames("loanOpeningBalanceComponents")).toEqual(expect.arrayContaining([
            "source_type", "source_public_id",
        ]));
        expect(config("loanRestructures").checks.map((check) => check.name)).toEqual(expect.arrayContaining([
            "loan_restructures_status_check",
            "loan_restructures_lifecycle_check",
        ]));
        expect(columnNames("loanRestructures")).toEqual(expect.arrayContaining([
            "created_actor_source", "execute_actor_source", "reversal_actor_source",
        ]));
        expect(config("loanRestructureWaivers").checks.map((check) => check.name)).toContain("loan_restructure_waivers_status_check");

        const expectedUniqueIndexes: Record<string, string[]> = {
            loan_restructures_tenant_execute_key_unique: ["tenant_id", "execute_idempotency_key"],
            loan_restructures_tenant_reversal_key_unique: ["tenant_id", "reversal_idempotency_key"],
        };
        for (const [name, columns] of Object.entries(expectedUniqueIndexes)) {
            const index = config("loanRestructures").indexes.find((candidate) => candidate.config.name === name);
            expect(index?.config.unique, `missing unique request-key index ${name}`).toBe(true);
            expect(index!.config.columns.map((column) => (column as { name?: string }).name)).toEqual(columns);
        }
        for (const name of ["loan_restructure_waivers_tenant_execute_key_unique", "loan_restructure_waivers_tenant_reversal_key_unique"]) {
            const index = config("loanRestructureWaivers").indexes.find((candidate) => candidate.config.name === name);
            expect(index?.config.unique, `missing unique request-key index ${name}`).toBe(true);
        }
    });

    test("keeps all restructure, opening-balance, waiver, and actor relations tenant scoped", () => {
        expectTenantForeignKey("loanRestructures", "old_loan_id", "loans");
        expectTenantForeignKey("loanRestructures", "new_loan_id", "loans");
        expectTenantForeignKey("loanRestructures", "created_by_user_id", "users");
        expectTenantForeignKey("loanRestructures", "executed_by_user_id", "users");
        expectTenantForeignKey("loanRestructures", "reversed_by_user_id", "users");
        expectTenantForeignKey("loanOpeningBalanceComponents", "restructure_id", "loan_restructures");
        expectTenantForeignKey("loanOpeningBalanceComponents", "loan_id", "loans");
        expectTenantForeignKey("loanRestructureWaivers", "restructure_id", "loan_restructures");
        expectTenantForeignKey("loanRestructureWaivers", "loan_id", "loans");
        expectTenantForeignKey("loanRestructureWaivers", "reversed_waiver_id", "loan_restructure_waivers");
    });
});

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

if (!testDatabaseUrl) {
    test.skip("single-payment PostgreSQL invariants (TEST_DATABASE_URL is not set)", () => {});
} else {
    test("PostgreSQL enforces backfill, term combinations, tenant isolation, request keys, waivers, and immutability", async () => {
        const postgres = (await import("postgres")).default;
        const { drizzle } = await import("drizzle-orm/postgres-js");
        const { migrate } = await import("drizzle-orm/postgres-js/migrator");
        const sql = postgres(testDatabaseUrl, { max: 1 });
        let primaryError: unknown;
        const postgresError = async (query: PromiseLike<unknown>): Promise<unknown> => {
            try {
                await query;
                return undefined;
            } catch (error) {
                return error;
            }
        };
        const applySqlFile = async (path: string) => {
            const content = await Bun.file(path).text();
            for (const statement of content.split("--> statement-breakpoint")) {
                if (statement.trim()) await sql.unsafe(statement);
            }
        };

        try {
            await sql.unsafe("DROP SCHEMA public CASCADE");
            await sql.unsafe("DROP SCHEMA IF EXISTS drizzle CASCADE");
            await sql.unsafe("CREATE SCHEMA public");
            const journal = await Bun.file(`${backendRoot}drizzle/meta/_journal.json`).json() as {
                entries: { idx: number; tag: string }[];
            };
            const targetIndex = journal.entries.find((candidate) => candidate.tag === migrationTag)?.idx;
            expect(targetIndex).toBeDefined();
            for (const entry of journal.entries.filter((candidate) => candidate.idx < targetIndex!)) {
                await applySqlFile(`${backendRoot}drizzle/${entry.tag}.sql`);
            }

            await sql`
                INSERT INTO users (tenant_id, email, role)
                VALUES ('tenant-a', 'actor-a@restructure.test', 'owner'), ('tenant-b', 'actor-b@restructure.test', 'owner')
            `;
            await sql`
                INSERT INTO borrowers (tenant_id, owner_user_id, name)
                SELECT tenant_id, id, 'Borrower ' || tenant_id FROM users WHERE email LIKE '%@restructure.test'
            `;
            await sql`
                INSERT INTO loans (tenant_id, owner_user_id, borrower_id, principal_amount, interest_rate, repayment_type, status)
                SELECT users.tenant_id, users.id, borrowers.id, 1000, 0, 'floating', 'active'
                FROM users JOIN borrowers USING (tenant_id) WHERE users.email = 'actor-a@restructure.test'
            `;
            await sql`
                INSERT INTO loans (tenant_id, owner_user_id, borrower_id, principal_amount, interest_rate, repayment_type, status)
                SELECT users.tenant_id, users.id, borrowers.id, 1000, 0, 'daily', 'active'
                FROM users JOIN borrowers USING (tenant_id) WHERE users.email = 'actor-b@restructure.test'
            `;

            await applySqlFile(migrationPath);

            const migratedLoans = await sql<{ repayment_type: string; floating_accrual_cycle: string | null; single_payment_interest_policy: string | null }[]>`
                SELECT repayment_type, floating_accrual_cycle, single_payment_interest_policy
                FROM loans ORDER BY tenant_id
            `;
            expect([...migratedLoans]).toEqual([
                { repayment_type: "floating", floating_accrual_cycle: "daily", single_payment_interest_policy: null },
                { repayment_type: "daily", floating_accrual_cycle: null, single_payment_interest_policy: null },
            ]);

            expect(await postgresError(sql`
                INSERT INTO loans (
                    tenant_id, owner_user_id, borrower_id, principal_amount, interest_rate, repayment_type, status,
                    single_payment_due_date, single_payment_fixed_agreed_interest, single_payment_interest_policy,
                    single_payment_retroactive_rate_type, single_payment_retroactive_rate,
                    single_payment_late_penalty_mode
                )
                SELECT users.tenant_id, users.id, borrowers.id, 1000, 0, 'single_payment', 'active',
                       DATE '2026-09-01', 100, 'fixed_only', 'percent_per_day', 1, 'none'
                FROM users JOIN borrowers USING (tenant_id) WHERE users.tenant_id = 'tenant-a'
            `)).toMatchObject({ code: "23514" });

            await sql`
                INSERT INTO loans (
                    tenant_id, owner_user_id, borrower_id, principal_amount, interest_rate, repayment_type, status,
                    single_payment_due_date, single_payment_fixed_agreed_interest, single_payment_interest_policy,
                    single_payment_late_penalty_mode
                )
                SELECT users.tenant_id, users.id, borrowers.id, 1000, 0, 'single_payment', 'active',
                       DATE '2026-09-01', 100, 'fixed_only', 'none'
                FROM users JOIN borrowers USING (tenant_id) WHERE users.tenant_id IN ('tenant-a', 'tenant-b')
            `;

            await sql`
                INSERT INTO loans (
                    tenant_id, owner_user_id, borrower_id, principal_amount, interest_rate, repayment_type, status,
                    single_payment_due_date, single_payment_fixed_agreed_interest, single_payment_interest_policy,
                    single_payment_late_penalty_mode
                )
                SELECT users.tenant_id, users.id, borrowers.id, 1000 + generated.sequence, 0, 'single_payment', 'active',
                       DATE '2026-09-01' + generated.sequence::integer, 100, 'fixed_only', 'none'
                FROM users JOIN borrowers USING (tenant_id)
                CROSS JOIN generate_series(1, 2) AS generated(sequence)
                WHERE users.tenant_id = 'tenant-a'
            `;

            const tenantALoans = await sql<{ id: number; public_id: string }[]>`
                SELECT id, public_id FROM loans WHERE tenant_id = 'tenant-a' AND repayment_type = 'single_payment' ORDER BY id
            `;
            const tenantBLoans = await sql<{ id: number; public_id: string }[]>`
                SELECT id, public_id FROM loans WHERE tenant_id = 'tenant-b' AND repayment_type = 'single_payment' ORDER BY id
            `;
            const tenantAActor = await sql<{ id: number }[]>`SELECT id FROM users WHERE tenant_id = 'tenant-a'`;

            const draftLoan = await sql<{ id: number }[]>`
                INSERT INTO loans (
                    tenant_id, owner_user_id, borrower_id, principal_amount, interest_rate, repayment_type, status,
                    single_payment_due_date, single_payment_fixed_agreed_interest, single_payment_interest_policy,
                    single_payment_late_penalty_mode
                )
                SELECT users.tenant_id, users.id, borrowers.id, 500, 0, 'single_payment', 'draft',
                       DATE '2026-10-01', 50, 'fixed_only', 'none'
                FROM users JOIN borrowers USING (tenant_id) WHERE users.tenant_id = 'tenant-a'
                RETURNING id
            `;
            expect((await sql`UPDATE loans SET single_payment_fixed_agreed_interest = 55 WHERE id = ${draftLoan[0]!.id}`).count).toBe(1);
            await sql`UPDATE loans SET status = 'active', outstanding_principal = 500 WHERE id = ${draftLoan[0]!.id}`;
            expect(String(await postgresError(sql`UPDATE loans SET status = 'draft' WHERE id = ${draftLoan[0]!.id}`))).toMatch(/cannot transition back to draft/);
            expect(String(await postgresError(sql`UPDATE loans SET single_payment_due_date = DATE '2026-10-02' WHERE id = ${draftLoan[0]!.id}`))).toMatch(/contractual terms are immutable/);
            expect(String(await postgresError(sql`DELETE FROM loans WHERE id = ${draftLoan[0]!.id}`))).toMatch(/activated loans are immutable/);
            expect((await sql`
                UPDATE loans SET outstanding_principal = 400, outstanding_interest = 5,
                    outstanding_fees = 2, next_due_date = DATE '2026-10-01', status = 'paid'
                WHERE id = ${draftLoan[0]!.id}
            `).count).toBe(1);
            expect(String(await postgresError(sql`UPDATE loans SET status = 'draft' WHERE id = ${draftLoan[0]!.id}`))).toMatch(/cannot transition back to draft/);
            expect((await sql`UPDATE loans SET outstanding_principal = 0, next_due_date = NULL WHERE id = ${draftLoan[0]!.id}`).count).toBe(1);
            expect(String(await postgresError(sql`UPDATE loans SET single_payment_fixed_agreed_interest = 60 WHERE id = ${draftLoan[0]!.id}`))).toMatch(/contractual terms are immutable/);
            expect(String(await postgresError(sql`UPDATE loans SET floating_accrual_cycle = 'weekly' WHERE tenant_id = 'tenant-a' AND repayment_type = 'floating'`))).toMatch(/contractual terms are immutable/);
            expect((await sql`UPDATE loans SET status = 'restructured' WHERE id = ${tenantALoans[2]!.id}`).count).toBe(1);
            expect(String(await postgresError(sql`UPDATE loans SET status = 'draft' WHERE id = ${tenantALoans[2]!.id}`))).toMatch(/cannot transition back to draft/);

            const schedule = await sql<{ id: number }[]>`
                INSERT INTO loan_schedules (
                    tenant_id, loan_id, installment_no, due_date, scheduled_principal,
                    scheduled_interest, scheduled_fee, scheduled_total, paid_total,
                    paid_penalty, remaining_due, overdue_days, status
                ) VALUES (
                    'tenant-a', ${tenantALoans[0]!.id}, 1, DATE '2026-09-01', 1000, 100, 0, 1100, 0, 0, 1100, 0, 'pending'
                ) RETURNING id
            `;
            expect((await sql`
                UPDATE loan_schedules SET paid_total = 100, paid_penalty = 5,
                    remaining_due = 1000, overdue_days = 1, status = 'partial', updated_at = now()
                WHERE id = ${schedule[0]!.id}
            `).count).toBe(1);
            expect(String(await postgresError(sql`UPDATE loan_schedules SET due_date = DATE '2026-09-02' WHERE id = ${schedule[0]!.id}`))).toMatch(/contractual fields are immutable/);
            expect(String(await postgresError(sql`UPDATE loan_schedules SET scheduled_total = 1200 WHERE id = ${schedule[0]!.id}`))).toMatch(/contractual fields are immutable/);
            expect(String(await postgresError(sql`DELETE FROM loan_schedules WHERE id = ${schedule[0]!.id}`))).toMatch(/activated loan schedules are immutable/);

            const audits = await sql<{ public_id: string }[]>`
                INSERT INTO audit_logs (tenant_id, entity_type, entity_id, action, actor_user_id, actor_source, correlation_id)
                VALUES
                    ('tenant-a', 'loan_restructure', 'execute', 'executed', ${tenantAActor[0]!.id}, 'web', 'audit-execute'),
                    ('tenant-a', 'loan_restructure', 'reverse', 'reversed', ${tenantAActor[0]!.id}, 'web', 'audit-reverse'),
                    ('tenant-a', 'loan_restructure_waiver', 'execute', 'executed', ${tenantAActor[0]!.id}, 'web', 'audit-waiver'),
                    ('tenant-a', 'loan_restructure_waiver', 'reverse', 'reversed', ${tenantAActor[0]!.id}, 'web', 'audit-waiver-reverse')
                RETURNING public_id
            `;
            const tenantBAudit = await sql<{ public_id: string }[]>`
                INSERT INTO audit_logs (tenant_id, entity_type, entity_id, action, actor_user_id, actor_source, correlation_id)
                SELECT 'tenant-b', 'loan_restructure', 'execute-b', 'executed', id, 'web', 'audit-execute-b'
                FROM users WHERE tenant_id = 'tenant-b'
                RETURNING public_id
            `;
            const systemAudits = await sql<{ public_id: string }[]>`
                INSERT INTO audit_logs (tenant_id, entity_type, entity_id, action, actor_source, correlation_id)
                VALUES
                    ('tenant-a', 'loan_restructure', 'system-execute', 'executed', 'system', 'audit-system-execute'),
                    ('tenant-a', 'loan_restructure', 'system-reverse', 'reversed', 'system', 'audit-system-reverse'),
                    ('tenant-a', 'loan_restructure_waiver', 'system-waiver', 'executed', 'system', 'audit-system-waiver'),
                    ('tenant-a', 'loan_restructure_waiver', 'system-waiver-reverse', 'reversed', 'system', 'audit-system-waiver-reverse')
                RETURNING public_id
            `;

            const insertRestructure = (
                newLoanId: number,
                executeKey: string,
                waivedInterest = "10",
                cashDirection: "none" | "payout" | "collection" = "none",
                cashAmount = "0",
                auditPublicId: string | null = audits[0]!.public_id,
                preExecutionState: Record<string, string | null> | null = {
                    status: "active",
                    outstandingPrincipal: "1000.00",
                    outstandingInterest: "0.00",
                    outstandingFees: "0.00",
                    nextDueDate: "2026-09-01",
                },
                executedByUserId: number | null = tenantAActor[0]!.id,
                reversedAuditPublicId: string | null = null,
                reversedByUserId: number | null = null,
                executeActorSource: "web" | "mcp" | "system" = "web",
                createdByUserId: number | null = tenantAActor[0]!.id,
                createdActorSource: "web" | "mcp" | "system" = executeActorSource,
            ) => sql`
                INSERT INTO loan_restructures (
                    tenant_id, old_loan_id, new_loan_id, settlement_date, old_balance_version,
                    status, preview_hash, request_hash, requested_replacement_terms,
                    gross_principal, gross_interest, gross_fees, gross_penalty,
                    waived_interest, waived_fees, waived_penalty,
                    net_principal, net_interest, net_fees, net_penalty,
                    external_settlement_credits, additional_principal, cash_direction, cash_amount,
                    reason, created_actor_source, execute_actor_source, correlation_id, execute_idempotency_key,
                    execute_request_hash, executed_audit_public_id, reversed_audit_public_id,
                    pre_execution_old_loan_state, expires_at, executed_at,
                    created_by_user_id, executed_by_user_id, reversed_by_user_id
                ) VALUES (
                    'tenant-a', ${tenantALoans[0]!.id}, ${newLoanId}, DATE '2026-08-20', 'balance-v1',
                    'executed', 'preview-hash', 'request-hash', '{}'::jsonb,
                    1000, 100, 20, 5, ${waivedInterest}, 0, 0, 1000, 90, 20, 5,
                    0, 0, ${cashDirection}, ${cashAmount}, 'customer request', ${createdActorSource}, ${executeActorSource}, 'correlation-a', ${executeKey},
                    'execute-hash', ${auditPublicId}, ${reversedAuditPublicId}, ${preExecutionState === null ? null : sql.json(preExecutionState)},
                    now() + interval '1 hour', now(), ${createdByUserId}, ${executedByUserId}, ${reversedByUserId}
                ) RETURNING id, public_id
            `;

            expect(await postgresError(insertRestructure(tenantALoans[1]!.id, "valid-restructure", "10"))).toBeUndefined();
            expect(await postgresError(insertRestructure(tenantBLoans[0]!.id, "cross-tenant-2", "10"))).toMatchObject({ code: "23503" });
            expect(await postgresError(insertRestructure(tenantALoans[1]!.id, "over-waiver", "101"))).toMatchObject({ code: "23514" });
            expect(await postgresError(insertRestructure(tenantALoans[0]!.id, "self-restructure"))).toMatchObject({ code: "23514" });
            expect(await postgresError(insertRestructure(tenantALoans[1]!.id, "missing-execution-audit", "10", "none", "0", null))).toMatchObject({ code: "23514" });
            expect(await postgresError(insertRestructure(tenantALoans[1]!.id, "cross-tenant-execution-audit", "10", "none", "0", tenantBAudit[0]!.public_id))).toMatchObject({ code: "23503" });
            expect(await postgresError(insertRestructure(tenantALoans[1]!.id, "missing-pre-state", "10", "none", "0", audits[0]!.public_id, null))).toMatchObject({ code: "23514" });
            expect(await postgresError(insertRestructure(tenantALoans[1]!.id, "incomplete-pre-state", "10", "none", "0", audits[0]!.public_id, {}))).toMatchObject({ code: "23514" });
            expect(await postgresError(insertRestructure(tenantALoans[1]!.id, "missing-execution-actor", "10", "none", "0", audits[0]!.public_id, undefined, null))).toMatchObject({ code: "23514" });
            const systemRestructure = await insertRestructure(
                tenantALoans[1]!.id, "system-restructure", "10", "none", "0",
                systemAudits[0]!.public_id, undefined, null, null, null, "system", null,
            );
            expect(await postgresError(insertRestructure(
                tenantALoans[1]!.id, "executed-with-reversal-metadata", "10", "none", "0",
                audits[0]!.public_id, undefined, tenantAActor[0]!.id, audits[1]!.public_id, tenantAActor[0]!.id,
            ))).toMatchObject({ code: "23514" });
            expect(await postgresError(insertRestructure(tenantALoans[1]!.id, "cash-none-positive", "10", "none", "1"))).toMatchObject({ code: "23514" });
            expect(await postgresError(insertRestructure(tenantALoans[1]!.id, "cash-payout-zero", "10", "payout", "0"))).toMatchObject({ code: "23514" });
            expect(await postgresError(insertRestructure(tenantALoans[1]!.id, "cash-collection-zero", "10", "collection", "0"))).toMatchObject({ code: "23514" });
            expect(await postgresError(insertRestructure(tenantALoans[1]!.id, "cash-payout-positive", "10", "payout", "25"))).toBeUndefined();
            expect(await postgresError(insertRestructure(tenantALoans[1]!.id, "cash-collection-positive", "10", "collection", "25"))).toBeUndefined();

            const restructure = await sql<{ id: number; public_id: string }[]>`
                SELECT id, public_id FROM loan_restructures WHERE execute_idempotency_key = 'valid-restructure'
            `;
            expect(await postgresError(insertRestructure(tenantALoans[1]!.id, "valid-restructure", "10"))).toMatchObject({ code: "23505" });

            const component = await sql<{ id: number }[]>`
                INSERT INTO loan_opening_balance_components (
                    tenant_id, restructure_id, loan_id, component_kind, amount, source_type, source_public_id, created_by_user_id
                ) VALUES (
                    'tenant-a', ${restructure[0]!.id}, ${tenantALoans[1]!.id}, 'carried_principal', 1000,
                    'loan', ${tenantALoans[0]!.public_id}::uuid, ${tenantAActor[0]!.id}
                ) RETURNING id
            `;
            expect(await postgresError(sql`
                INSERT INTO loan_opening_balance_components (
                    tenant_id, restructure_id, loan_id, component_kind, amount, source_type, source_public_id, created_by_user_id
                ) VALUES (
                    'tenant-a', ${restructure[0]!.id}, ${tenantALoans[1]!.id}, 'carried_interest', 10,
                    'loan_restructure', ${restructure[0]!.public_id}::uuid, ${tenantAActor[0]!.id}
                )
            `)).toBeUndefined();
            expect(await postgresError(sql`
                INSERT INTO loan_opening_balance_components (
                    tenant_id, restructure_id, loan_id, component_kind, amount, source_type, source_public_id, created_by_user_id
                ) VALUES (
                    'tenant-a', ${restructure[0]!.id}, ${tenantALoans[2]!.id}, 'carried_interest', 10,
                    'loan', ${tenantALoans[0]!.public_id}::uuid, ${tenantAActor[0]!.id}
                )
            `)).toMatchObject({ code: "23503" });
            expect(await postgresError(sql`
                INSERT INTO loan_opening_balance_components (
                    tenant_id, restructure_id, loan_id, component_kind, amount, source_type, source_public_id, created_by_user_id
                ) VALUES (
                    'tenant-a', ${restructure[0]!.id}, ${tenantALoans[1]!.id}, 'carried_interest', 10,
                    'loan', '00000000-0000-0000-0000-000000000001', ${tenantAActor[0]!.id}
                )
            `)).toMatchObject({ code: "23503" });
            expect(await postgresError(sql`
                INSERT INTO loan_opening_balance_components (
                    tenant_id, restructure_id, loan_id, component_kind, amount, source_type, source_public_id, created_by_user_id
                ) VALUES (
                    'tenant-a', ${restructure[0]!.id}, ${tenantALoans[1]!.id}, 'carried_interest', 10,
                    'loan', ${tenantBLoans[0]!.public_id}::uuid, ${tenantAActor[0]!.id}
                )
            `)).toMatchObject({ code: "23503" });
            expect(await postgresError(sql`
                INSERT INTO loan_opening_balance_components (
                    tenant_id, restructure_id, loan_id, component_kind, amount, source_type, source_public_id, created_by_user_id
                ) VALUES (
                    'tenant-a', ${restructure[0]!.id}, ${tenantALoans[1]!.id}, 'carried_interest', 10,
                    'loan_restructure', ${tenantALoans[0]!.public_id}::uuid, ${tenantAActor[0]!.id}
                )
            `)).toMatchObject({ code: "23503" });
            expect(String(await postgresError(sql`UPDATE loan_restructures SET gross_principal = 999 WHERE id = ${restructure[0]!.id}`))).toMatch(/immutable/);
            expect(String(await postgresError(sql`DELETE FROM loan_restructures WHERE id = ${restructure[0]!.id}`))).toMatch(/immutable/);
            expect(String(await postgresError(sql`UPDATE loan_opening_balance_components SET amount = 999 WHERE id = ${component[0]!.id}`))).toMatch(/immutable/);
            expect(String(await postgresError(sql`DELETE FROM loan_opening_balance_components WHERE id = ${component[0]!.id}`))).toMatch(/immutable/);

            const executionSourceMutation = await insertRestructure(tenantALoans[1]!.id, "execution-source-mutation", "10");
            expect(String(await postgresError(sql`
                UPDATE loan_restructures SET
                    status = 'reversed', execute_actor_source = 'system', reversal_actor_source = 'system',
                    reversal_idempotency_key = 'execution-source-mutation-reverse',
                    reversal_request_hash = 'execution-source-mutation-reverse-hash',
                    reversed_audit_public_id = ${systemAudits[1]!.public_id}, reversed_at = now(), updated_at = now()
                WHERE id = ${executionSourceMutation[0]!.id}
            `))).toMatch(/immutable/);

            const reversedRestructure = await insertRestructure(tenantALoans[1]!.id, "restructure-to-reverse", "10");
            expect(await postgresError(sql`
                UPDATE loan_restructures SET
                    status = 'reversed', reversal_idempotency_key = 'missing-reversal-audit-key',
                    reversal_request_hash = 'missing-reversal-audit-hash', reversed_at = now(),
                    reversed_by_user_id = ${tenantAActor[0]!.id}, updated_by_user_id = ${tenantAActor[0]!.id}, updated_at = now()
                WHERE id = ${reversedRestructure[0]!.id}
            `)).toMatchObject({ code: "23514" });
            expect(await postgresError(sql`
                UPDATE loan_restructures SET
                    status = 'reversed',
                    reversal_idempotency_key = 'restructure-reverse-key',
                    reversal_request_hash = 'restructure-reverse-hash',
                    reversal_actor_source = 'system',
                    reversed_audit_public_id = ${systemAudits[1]!.public_id},
                    reversed_at = now(),
                    updated_at = now()
                WHERE id = ${reversedRestructure[0]!.id}
            `)).toBeUndefined();
            expect(String(await postgresError(sql`UPDATE loan_restructures SET reason = 'changed' WHERE id = ${reversedRestructure[0]!.id}`))).toMatch(/immutable/);
            expect(String(await postgresError(sql`DELETE FROM loan_restructures WHERE id = ${reversedRestructure[0]!.id}`))).toMatch(/immutable/);
            expect(await postgresError(sql`
                UPDATE loan_restructures SET
                    status = 'reversed', reversal_idempotency_key = 'system-restructure-reverse',
                    reversal_request_hash = 'system-restructure-reverse-hash', reversal_actor_source = 'web',
                    reversed_audit_public_id = ${audits[1]!.public_id}, reversed_at = now(), updated_at = now()
                WHERE id = ${systemRestructure[0]!.id}
            `)).toMatchObject({ code: "23514" });
            expect((await sql`
                UPDATE loan_restructures SET
                    status = 'reversed', reversal_idempotency_key = 'system-restructure-reverse',
                    reversal_request_hash = 'system-restructure-reverse-hash',
                    reversal_actor_source = 'web', reversed_by_user_id = ${tenantAActor[0]!.id},
                    reversed_audit_public_id = ${audits[1]!.public_id}, reversed_at = now(), updated_at = now()
                WHERE id = ${systemRestructure[0]!.id}
            `).count).toBe(1);

            const waiver = await sql<{ id: number }[]>`
                INSERT INTO loan_restructure_waivers (
                    tenant_id, restructure_id, loan_id, component_kind, amount, reason,
                    status, actor_source, correlation_id, execute_idempotency_key, execute_request_hash,
                    audit_public_id, created_by_user_id, executed_at
                ) VALUES (
                    'tenant-a', ${restructure[0]!.id}, ${tenantALoans[1]!.id}, 'interest', 5, 'courtesy',
                    'executed', 'web', 'correlation-waiver', 'waiver-key', 'waiver-hash',
                    ${audits[2]!.public_id}, ${tenantAActor[0]!.id}, now()
                ) RETURNING id
            `;
            expect(await postgresError(sql`
                INSERT INTO loan_restructure_waivers (
                    tenant_id, restructure_id, loan_id, component_kind, amount, reason,
                    status, actor_source, correlation_id, execute_idempotency_key, execute_request_hash,
                    created_by_user_id, executed_at
                ) VALUES (
                    'tenant-a', ${restructure[0]!.id}, ${tenantALoans[1]!.id}, 'interest', 1, 'missing audit',
                    'executed', 'web', 'correlation-waiver-no-audit', 'waiver-no-audit', 'waiver-no-audit-hash',
                    ${tenantAActor[0]!.id}, now()
                )
            `)).toMatchObject({ code: "23514" });
            const systemWaiver = await sql<{ id: number }[]>`
                INSERT INTO loan_restructure_waivers (
                    tenant_id, restructure_id, loan_id, component_kind, amount, reason,
                    status, actor_source, correlation_id, execute_idempotency_key, execute_request_hash,
                    audit_public_id, executed_at
                ) VALUES (
                    'tenant-a', ${restructure[0]!.id}, ${tenantALoans[1]!.id}, 'fee', 1, 'system waiver',
                    'executed', 'system', 'correlation-system-waiver', 'system-waiver-key', 'system-waiver-hash',
                    ${systemAudits[2]!.public_id}, now()
                ) RETURNING id
            `;
            expect(await postgresError(sql`
                INSERT INTO loan_restructure_waivers (
                    tenant_id, restructure_id, loan_id, component_kind, amount, reason,
                    status, actor_source, correlation_id, execute_idempotency_key, execute_request_hash,
                    audit_public_id, executed_at
                ) VALUES (
                    'tenant-a', ${restructure[0]!.id}, ${tenantALoans[1]!.id}, 'interest', 1, 'missing actor',
                    'executed', 'web', 'correlation-waiver-no-actor', 'waiver-no-actor', 'waiver-no-actor-hash',
                    ${audits[2]!.public_id}, now()
                )
            `)).toMatchObject({ code: "23514" });
            expect(await postgresError(sql`
                INSERT INTO loan_restructure_waivers (
                    tenant_id, restructure_id, loan_id, component_kind, amount, reason,
                    status, reversed_waiver_id, actor_source, correlation_id,
                    execute_idempotency_key, execute_request_hash,
                    reversal_idempotency_key, reversal_request_hash,
                    audit_public_id, executed_at, reversed_at
                ) VALUES (
                    'tenant-a', ${restructure[0]!.id}, ${tenantALoans[1]!.id}, 'interest', 5, 'system restore waiver',
                    'reversed', ${systemWaiver[0]!.id}, 'system', 'correlation-system-waiver-reverse',
                    'system-waiver-reversal-entry-key', 'system-waiver-reversal-entry-hash',
                    'system-waiver-reverse-key', 'system-waiver-reverse-hash',
                    ${systemAudits[3]!.public_id}, now(), now()
                )
            `)).toBeUndefined();
            expect(await postgresError(sql`
                INSERT INTO loan_restructure_waivers (
                    tenant_id, restructure_id, loan_id, component_kind, amount, reason,
                    status, actor_source, correlation_id, execute_idempotency_key, execute_request_hash,
                    audit_public_id, created_by_user_id, reversed_by_user_id, executed_at, reversed_at
                ) VALUES (
                    'tenant-a', ${restructure[0]!.id}, ${tenantALoans[1]!.id}, 'interest', 1, 'contradictory reverse metadata',
                    'executed', 'web', 'correlation-waiver-contradictory', 'waiver-contradictory', 'waiver-contradictory-hash',
                    ${audits[2]!.public_id}, ${tenantAActor[0]!.id}, ${tenantAActor[0]!.id}, now(), now()
                )
            `)).toMatchObject({ code: "23514" });
            expect(await postgresError(sql`
                INSERT INTO loan_restructure_waivers (
                    tenant_id, restructure_id, loan_id, component_kind, amount, reason,
                    status, actor_source, correlation_id, execute_idempotency_key, execute_request_hash,
                    audit_public_id, created_by_user_id, executed_at
                ) VALUES (
                    'tenant-a', ${restructure[0]!.id}, ${tenantALoans[1]!.id}, 'interest', 1, 'duplicate',
                    'executed', 'web', 'correlation-waiver-2', 'waiver-key', 'other-hash',
                    ${audits[2]!.public_id}, ${tenantAActor[0]!.id}, now()
                )
            `)).toMatchObject({ code: "23505" });
            expect(String(await postgresError(sql`UPDATE loan_restructure_waivers SET amount = 4 WHERE id = ${waiver[0]!.id}`))).toMatch(/immutable/);
            expect(String(await postgresError(sql`DELETE FROM loan_restructure_waivers WHERE id = ${waiver[0]!.id}`))).toMatch(/immutable/);
            const waiverPublicId = await sql<{ public_id: string }[]>`SELECT public_id FROM loan_restructure_waivers WHERE id = ${waiver[0]!.id}`;
            expect(await postgresError(sql`
                INSERT INTO loan_opening_balance_components (
                    tenant_id, restructure_id, loan_id, component_kind, amount, source_type, source_public_id, created_by_user_id
                ) VALUES (
                    'tenant-a', ${restructure[0]!.id}, ${tenantALoans[1]!.id}, 'carried_interest', 5,
                    'loan_restructure_waiver', ${waiverPublicId[0]!.public_id}::uuid, ${tenantAActor[0]!.id}
                )
            `)).toBeUndefined();

            expect(await postgresError(sql`
                INSERT INTO loan_restructure_waivers (
                    tenant_id, restructure_id, loan_id, component_kind, amount, reason,
                    status, reversed_waiver_id, actor_source, correlation_id,
                    execute_idempotency_key, execute_request_hash,
                    reversal_idempotency_key, reversal_request_hash,
                    audit_public_id, created_by_user_id, executed_at, reversed_at
                ) VALUES (
                    'tenant-a', ${restructure[0]!.id}, ${tenantALoans[1]!.id}, 'interest', 5, 'missing reversal actor',
                    'reversed', ${waiver[0]!.id}, 'web', 'correlation-waiver-reverse-no-actor',
                    'waiver-reversal-no-actor-entry-key', 'waiver-reversal-no-actor-entry-hash',
                    'waiver-reverse-no-actor-key', 'waiver-reverse-no-actor-hash',
                    ${audits[3]!.public_id}, ${tenantAActor[0]!.id}, now(), now()
                )
            `)).toMatchObject({ code: "23514" });
            expect(await postgresError(sql`
                INSERT INTO loan_restructure_waivers (
                    tenant_id, restructure_id, loan_id, component_kind, amount, reason,
                    status, reversed_waiver_id, actor_source, correlation_id,
                    execute_idempotency_key, execute_request_hash,
                    reversal_idempotency_key, reversal_request_hash,
                    audit_public_id, created_by_user_id, reversed_by_user_id, executed_at
                ) VALUES (
                    'tenant-a', ${restructure[0]!.id}, ${tenantALoans[1]!.id}, 'interest', 5, 'missing reversal timestamp',
                    'reversed', ${waiver[0]!.id}, 'web', 'correlation-waiver-reverse-no-time',
                    'waiver-reversal-no-time-entry-key', 'waiver-reversal-no-time-entry-hash',
                    'waiver-reverse-no-time-key', 'waiver-reverse-no-time-hash',
                    ${audits[3]!.public_id}, ${tenantAActor[0]!.id}, ${tenantAActor[0]!.id}, now()
                )
            `)).toMatchObject({ code: "23514" });

            const reversedWaiver = await sql<{ id: number }[]>`
                INSERT INTO loan_restructure_waivers (
                    tenant_id, restructure_id, loan_id, component_kind, amount, reason,
                    status, reversed_waiver_id, actor_source, correlation_id,
                    execute_idempotency_key, execute_request_hash,
                    reversal_idempotency_key, reversal_request_hash,
                    audit_public_id, created_by_user_id, reversed_by_user_id, executed_at, reversed_at
                ) VALUES (
                    'tenant-a', ${restructure[0]!.id}, ${tenantALoans[1]!.id}, 'interest', 5, 'restore waiver',
                    'reversed', ${waiver[0]!.id}, 'web', 'correlation-waiver-reverse',
                    'waiver-reversal-entry-key', 'waiver-reversal-entry-hash',
                    'waiver-reverse-key', 'waiver-reverse-hash',
                    ${audits[3]!.public_id}, ${tenantAActor[0]!.id}, ${tenantAActor[0]!.id}, now(), now()
                ) RETURNING id
            `;
            expect(String(await postgresError(sql`UPDATE loan_restructure_waivers SET reason = 'changed' WHERE id = ${reversedWaiver[0]!.id}`))).toMatch(/immutable/);
            expect(String(await postgresError(sql`DELETE FROM loan_restructure_waivers WHERE id = ${reversedWaiver[0]!.id}`))).toMatch(/immutable/);
        } catch (error) {
            primaryError = error;
        } finally {
            try {
                await sql.unsafe("DROP SCHEMA public CASCADE");
                await sql.unsafe("DROP SCHEMA IF EXISTS drizzle CASCADE");
                await sql.unsafe("CREATE SCHEMA public");
                await migrate(drizzle(sql), { migrationsFolder: `${backendRoot}drizzle` });
            } catch (cleanupError) {
                if (primaryError === undefined) primaryError = cleanupError;
            }
            await sql.end();
        }
        if (primaryError !== undefined) throw primaryError;
    }, 60_000);
}
