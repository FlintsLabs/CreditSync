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

        expect(journal.entries.at(-1)).toMatchObject({ idx: 27, tag: migrationTag });
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
        const sql = postgres(testDatabaseUrl, { max: 1 });
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
                entries: { tag: string }[];
            };
            for (const entry of journal.entries.filter((candidate) => candidate.tag !== migrationTag)) {
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

            const tenantALoans = await sql<{ id: number }[]>`SELECT id FROM loans WHERE tenant_id = 'tenant-a' AND repayment_type = 'single_payment'`;
            const tenantBLoans = await sql<{ id: number }[]>`SELECT id FROM loans WHERE tenant_id = 'tenant-b' AND repayment_type = 'single_payment'`;
            const tenantAActor = await sql<{ id: number }[]>`SELECT id FROM users WHERE tenant_id = 'tenant-a'`;

            const insertRestructure = (newLoanId: number, executeKey: string, waivedInterest = "10") => sql`
                INSERT INTO loan_restructures (
                    tenant_id, old_loan_id, new_loan_id, settlement_date, old_balance_version,
                    status, preview_hash, request_hash, requested_replacement_terms,
                    gross_principal, gross_interest, gross_fees, gross_penalty,
                    waived_interest, waived_fees, waived_penalty,
                    net_principal, net_interest, net_fees, net_penalty,
                    external_settlement_credits, additional_principal, cash_direction, cash_amount,
                    reason, actor_source, correlation_id, execute_idempotency_key,
                    execute_request_hash, expires_at, executed_at, created_by_user_id, executed_by_user_id
                ) VALUES (
                    'tenant-a', ${tenantALoans[0]!.id}, ${newLoanId}, DATE '2026-08-20', 'balance-v1',
                    'executed', 'preview-hash', 'request-hash', '{}'::jsonb,
                    1000, 100, 20, 5, ${waivedInterest}, 0, 0, 1000, 90, 20, 5,
                    0, 0, 'none', 0, 'customer request', 'web', 'correlation-a', ${executeKey},
                    'execute-hash', now() + interval '1 hour', now(), ${tenantAActor[0]!.id}, ${tenantAActor[0]!.id}
                ) RETURNING id, public_id
            `;

            expect(await postgresError(insertRestructure(tenantALoans[0]!.id, "cross-tenant", "10"))).toBeUndefined();
            expect(await postgresError(insertRestructure(tenantBLoans[0]!.id, "cross-tenant-2", "10"))).toMatchObject({ code: "23503" });
            expect(await postgresError(insertRestructure(tenantALoans[0]!.id, "over-waiver", "101"))).toMatchObject({ code: "23514" });

            const restructure = await sql<{ id: number; public_id: string }[]>`
                SELECT id, public_id FROM loan_restructures WHERE execute_idempotency_key = 'cross-tenant'
            `;
            expect(await postgresError(insertRestructure(tenantALoans[0]!.id, "cross-tenant", "10"))).toMatchObject({ code: "23505" });

            const oldLoanPublicId = await sql<{ public_id: string }[]>`SELECT public_id FROM loans WHERE tenant_id = 'tenant-a' AND id = ${tenantALoans[0]!.id}`;
            const component = await sql<{ id: number }[]>`
                INSERT INTO loan_opening_balance_components (
                    tenant_id, restructure_id, loan_id, component_kind, amount, source_type, source_public_id, created_by_user_id
                ) VALUES (
                    'tenant-a', ${restructure[0]!.id}, ${tenantALoans[0]!.id}, 'carried_principal', 1000,
                    'loan', ${oldLoanPublicId[0]!.public_id}, ${tenantAActor[0]!.id}
                ) RETURNING id
            `;
            expect(String(await postgresError(sql`UPDATE loan_restructures SET gross_principal = 999 WHERE id = ${restructure[0]!.id}`))).toMatch(/immutable/);
            expect(String(await postgresError(sql`DELETE FROM loan_restructures WHERE id = ${restructure[0]!.id}`))).toMatch(/immutable/);
            expect(String(await postgresError(sql`UPDATE loan_opening_balance_components SET amount = 999 WHERE id = ${component[0]!.id}`))).toMatch(/immutable/);
            expect(String(await postgresError(sql`DELETE FROM loan_opening_balance_components WHERE id = ${component[0]!.id}`))).toMatch(/immutable/);

            const reversedRestructure = await insertRestructure(tenantALoans[0]!.id, "restructure-to-reverse", "10");
            await sql`
                UPDATE loan_restructures SET
                    status = 'reversed',
                    reversal_idempotency_key = 'restructure-reverse-key',
                    reversal_request_hash = 'restructure-reverse-hash',
                    reversed_at = now(),
                    reversed_by_user_id = ${tenantAActor[0]!.id},
                    updated_by_user_id = ${tenantAActor[0]!.id},
                    updated_at = now()
                WHERE id = ${reversedRestructure[0]!.id}
            `;
            expect(String(await postgresError(sql`UPDATE loan_restructures SET reason = 'changed' WHERE id = ${reversedRestructure[0]!.id}`))).toMatch(/immutable/);
            expect(String(await postgresError(sql`DELETE FROM loan_restructures WHERE id = ${reversedRestructure[0]!.id}`))).toMatch(/immutable/);

            const waiver = await sql<{ id: number }[]>`
                INSERT INTO loan_restructure_waivers (
                    tenant_id, restructure_id, loan_id, component_kind, amount, reason,
                    status, actor_source, correlation_id, execute_idempotency_key, execute_request_hash,
                    created_by_user_id, executed_at
                ) VALUES (
                    'tenant-a', ${restructure[0]!.id}, ${tenantALoans[0]!.id}, 'interest', 5, 'courtesy',
                    'executed', 'web', 'correlation-waiver', 'waiver-key', 'waiver-hash',
                    ${tenantAActor[0]!.id}, now()
                ) RETURNING id
            `;
            expect(await postgresError(sql`
                INSERT INTO loan_restructure_waivers (
                    tenant_id, restructure_id, loan_id, component_kind, amount, reason,
                    status, actor_source, correlation_id, execute_idempotency_key, execute_request_hash, executed_at
                ) VALUES (
                    'tenant-a', ${restructure[0]!.id}, ${tenantALoans[0]!.id}, 'interest', 1, 'duplicate',
                    'executed', 'web', 'correlation-waiver-2', 'waiver-key', 'other-hash', now()
                )
            `)).toMatchObject({ code: "23505" });
            expect(String(await postgresError(sql`UPDATE loan_restructure_waivers SET amount = 4 WHERE id = ${waiver[0]!.id}`))).toMatch(/immutable/);
            expect(String(await postgresError(sql`DELETE FROM loan_restructure_waivers WHERE id = ${waiver[0]!.id}`))).toMatch(/immutable/);

            const reversedWaiver = await sql<{ id: number }[]>`
                INSERT INTO loan_restructure_waivers (
                    tenant_id, restructure_id, loan_id, component_kind, amount, reason,
                    status, reversed_waiver_id, actor_source, correlation_id,
                    execute_idempotency_key, execute_request_hash,
                    reversal_idempotency_key, reversal_request_hash,
                    created_by_user_id, reversed_by_user_id, executed_at, reversed_at
                ) VALUES (
                    'tenant-a', ${restructure[0]!.id}, ${tenantALoans[0]!.id}, 'interest', 5, 'restore waiver',
                    'reversed', ${waiver[0]!.id}, 'web', 'correlation-waiver-reverse',
                    'waiver-reversal-entry-key', 'waiver-reversal-entry-hash',
                    'waiver-reverse-key', 'waiver-reverse-hash',
                    ${tenantAActor[0]!.id}, ${tenantAActor[0]!.id}, now(), now()
                ) RETURNING id
            `;
            expect(String(await postgresError(sql`UPDATE loan_restructure_waivers SET reason = 'changed' WHERE id = ${reversedWaiver[0]!.id}`))).toMatch(/immutable/);
            expect(String(await postgresError(sql`DELETE FROM loan_restructure_waivers WHERE id = ${reversedWaiver[0]!.id}`))).toMatch(/immutable/);
        } finally {
            await sql.end();
        }
    }, 60_000);
}
