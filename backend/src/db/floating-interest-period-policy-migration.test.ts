import { beforeEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { db } from "../db";
import { borrowers, loans, users } from "./schema";

const integrationEnabled = Boolean(process.env.TEST_DATABASE_URL);
const integrationTest = integrationEnabled ? test : test.skip;

async function resetTables() {
    await db.execute(sql`SET client_min_messages TO WARNING`);
    await db.execute(sql`TRUNCATE TABLE loan_settlement_previews, loan_interest_rate_previews, loan_interest_accruals, loan_interest_rate_periods, loans, borrowers, users RESTART IDENTITY CASCADE`);
}

async function seedLoan(tenantId: string, suffix: string) {
    const actor = await db.insert(users).values({
        tenantId,
        email: `${tenantId}-${suffix}@period-policy.test`,
        role: "owner",
    }).returning().then((rows) => rows[0]!);
    const borrower = await db.insert(borrowers).values({
        tenantId,
        ownerUserId: actor.id,
        name: `${tenantId} Borrower`,
    }).returning().then((rows) => rows[0]!);
    const loan = await db.insert(loans).values({
        tenantId,
        ownerUserId: actor.id,
        borrowerId: borrower.id,
        principalAmount: "5000.00",
        interestRate: "0.00",
        repaymentType: "floating",
        dailyInterestMode: "percent",
        dailyInterestRate: "12.0000",
        firstDayTreatment: "start_next_day",
        interestStartDate: "2026-08-13",
        startDate: "2026-08-13",
        outstandingPrincipal: "5000.00",
        status: "active",
    }).returning().then((rows) => rows[0]!);
    return { actor, loan };
}

async function expectConstraintViolation(statement: ReturnType<typeof sql>) {
    const execute = async () => db.execute(statement);
    await expect(execute()).rejects.toMatchObject({ cause: { code: "23514" } });
}

test("migration journals the additive policy schema and backfills legacy daily policy without rewriting accrual amounts", async () => {
    // Break caught: a deploy can omit the migration, legacy policy projection, or mutate authoritative posted interest.
    const [journal, migration] = await Promise.all([
        readFile(new URL("../../drizzle/meta/_journal.json", import.meta.url), "utf8"),
        readFile(new URL("../../drizzle/0036_floating_weekly_intermediary_integration.sql", import.meta.url), "utf8"),
    ]);

    expect(journal).toContain('"tag": "0036_floating_weekly_intermediary_integration"');
    expect(migration).toMatch(/UPDATE "loans"[\s\S]*"interest_period_unit" = CASE "floating_accrual_cycle"[\s\S]*WHEN 'weekly' THEN 'week'[\s\S]*ELSE 'day'/);
    expect(migration).toMatch(/"interest_period_length" = 1/);
    expect(migration).toMatch(/"advance_interest_periods" = CASE[\s\S]*"first_day_treatment" = 'deduct' THEN 1[\s\S]*ELSE 0/);
    expect(migration).toMatch(/"advance_interest_refund_policy" = 'non_refundable'/);
    expect(migration).not.toMatch(/UPDATE "loan_interest_accruals"[\s\S]*SET[\s\S]*"interest_amount"\s*=/);
    expect(migration).toContain('ADD COLUMN "activation_idempotency_key" text');
    expect(migration).toContain('ADD COLUMN "activation_result" jsonb');
    expect(migration).toMatch(/CREATE UNIQUE INDEX "loans_tenant_activation_idempotency_unique"[\s\S]*\("tenant_id","activation_idempotency_key"\)[\s\S]*IS NOT NULL/);
    expect(migration).toMatch(/CONSTRAINT "loans_activation_command_completeness_check"[\s\S]*"activation_idempotency_key" IS NULL AND "loans"\."activation_result" IS NULL[\s\S]*"activation_idempotency_key" IS NOT NULL AND "loans"\."activation_result" IS NOT NULL/);
});

describe("floating period policy database contract", () => {
    if (integrationEnabled) beforeEach(resetTables);

    integrationTest("accepts the supported weekly loan policy", async () => {
        const { loan } = await seedLoan("tenant-policy", "valid");

        await db.execute(sql`
            UPDATE loans
            SET interest_period_unit = 'week',
                interest_period_length = 1,
                advance_interest_periods = 1,
                advance_interest_refund_policy = 'non_refundable',
                interest_period_anchor_date = '2026-08-13'
            WHERE id = ${loan.id}
        `);

        const result = await db.execute(sql`
            SELECT interest_period_unit, interest_period_length, advance_interest_periods,
                   advance_interest_refund_policy, interest_period_anchor_date
            FROM loans WHERE id = ${loan.id}
        `);
        expect(result[0]).toMatchObject({
            interest_period_unit: "week",
            interest_period_length: 1,
            advance_interest_periods: 1,
            advance_interest_refund_policy: "non_refundable",
            interest_period_anchor_date: "2026-08-13",
        });
    });

    integrationTest("requires activation command keys and replay results together", async () => {
        const { loan } = await seedLoan("tenant-activation-shape", "pair");

        await expectConstraintViolation(sql`
            UPDATE loans
            SET activation_idempotency_key = 'activation-pair-key'
            WHERE id = ${loan.id}
        `);
        await expectConstraintViolation(sql`
            UPDATE loans
            SET activation_result = ${JSON.stringify({ publicId: loan.publicId })}::jsonb
            WHERE id = ${loan.id}
        `);
    });

    integrationTest("keeps activation command keys unique within a tenant", async () => {
        const first = await seedLoan("tenant-activation-unique", "first");
        const second = await seedLoan("tenant-activation-unique", "second");
        await db.execute(sql`
            UPDATE loans
            SET activation_idempotency_key = 'shared-activation-key',
                activation_result = ${JSON.stringify({ publicId: first.loan.publicId })}::jsonb
            WHERE id = ${first.loan.id}
        `);

        const duplicate = async () => db.execute(sql`
            UPDATE loans
            SET activation_idempotency_key = 'shared-activation-key',
                activation_result = ${JSON.stringify({ publicId: second.loan.publicId })}::jsonb
            WHERE id = ${second.loan.id}
        `);
        await expect(duplicate()).rejects.toMatchObject({ cause: { code: "23505" } });
    });

    integrationTest("allows the same activation command key in different tenants", async () => {
        const first = await seedLoan("tenant-activation-a", "first");
        const second = await seedLoan("tenant-activation-b", "second");

        await db.execute(sql`
            UPDATE loans
            SET activation_idempotency_key = 'cross-tenant-key',
                activation_result = ${JSON.stringify({ publicId: first.loan.publicId })}::jsonb
            WHERE id = ${first.loan.id}
        `);
        await db.execute(sql`
            UPDATE loans
            SET activation_idempotency_key = 'cross-tenant-key',
                activation_result = ${JSON.stringify({ publicId: second.loan.publicId })}::jsonb
            WHERE id = ${second.loan.id}
        `);
    });

    integrationTest("rejects a loan policy outside day or week", async () => {
        const { loan } = await seedLoan("tenant-policy", "unit");
        await expectConstraintViolation(sql`UPDATE loans SET interest_period_unit = 'month' WHERE id = ${loan.id}`);
    });

    integrationTest("rejects a period length other than one", async () => {
        const { loan } = await seedLoan("tenant-policy", "length");
        await expectConstraintViolation(sql`UPDATE loans SET interest_period_length = 2 WHERE id = ${loan.id}`);
    });

    integrationTest("rejects advance interest outside zero or one periods", async () => {
        const { loan } = await seedLoan("tenant-policy", "advance");
        await expectConstraintViolation(sql`UPDATE loans SET advance_interest_periods = 2 WHERE id = ${loan.id}`);
    });

    integrationTest("rejects a refundable advance-interest policy", async () => {
        const { loan } = await seedLoan("tenant-policy", "refund");
        await expectConstraintViolation(sql`UPDATE loans SET advance_interest_refund_policy = 'prorated' WHERE id = ${loan.id}`);
    });

    integrationTest("persists the quoted period on rate and accrual snapshots", async () => {
        const { actor, loan } = await seedLoan("tenant-snapshot", "weekly");
        const ratePeriods = await db.execute(sql`
            INSERT INTO loan_interest_rate_periods
                (tenant_id, loan_id, effective_date, rate_type, rate, period_unit, period_length, created_by_user_id)
            VALUES
                ('tenant-snapshot', ${loan.id}, '2026-08-13', 'percent', 12.0000, 'week', 1, ${actor.id})
            RETURNING id
        `);
        const ratePeriodId = Number(ratePeriods[0]!.id);

        await db.execute(sql`
            INSERT INTO loan_interest_accruals
                (tenant_id, loan_id, interest_rate_period_id, accrual_date, opening_principal,
                 rate_mode, rate, interest_amount, status, period_start_date, period_end_date,
                 period_day_index, period_unit, period_length, contractual_interest_amount,
                 cumulative_interest_amount, daily_increment_amount, created_by_user_id)
            VALUES
                ('tenant-snapshot', ${loan.id}, ${ratePeriodId}, '2026-08-15', 5000.00,
                 'percent', 12.0000, 85.71, 'accruing', '2026-08-13', '2026-08-20',
                 3, 'week', 1, 600.00, 257.14, 85.71, ${actor.id})
        `);

        const result = await db.execute(sql`
            SELECT period_start_date, period_end_date, period_day_index, period_unit, period_length,
                   contractual_interest_amount, cumulative_interest_amount, daily_increment_amount
            FROM loan_interest_accruals WHERE loan_id = ${loan.id}
        `);
        expect(result[0]).toMatchObject({
            period_start_date: "2026-08-13",
            period_end_date: "2026-08-20",
            period_day_index: 3,
            period_unit: "week",
            period_length: 1,
            contractual_interest_amount: "600.00",
            cumulative_interest_amount: "257.14",
            daily_increment_amount: "85.71",
        });
    });

    integrationTest("enforces tenant-safe settlement preview ownership", async () => {
        const { loan } = await seedLoan("tenant-preview-a", "owner");

        const insertCrossTenant = async () => db.execute(sql`
            INSERT INTO loan_settlement_previews
                (tenant_id, loan_id, as_of_date, outstanding_principal, due_interest,
                 accrued_not_due_interest, outstanding_fees, outstanding_penalties,
                 non_refundable_advance_interest, settlement_total, balance_version,
                 preview_hash, status, expires_at)
            VALUES
                ('tenant-preview-b', ${loan.id}, '2026-08-15', 5000.00, 0.00,
                 257.14, 0.00, 0.00, 0.00, 5257.14, 'balance-v1',
                 'preview-hash', 'ready', now() + interval '5 minutes')
        `);

        await expect(insertCrossTenant()).rejects.toMatchObject({ cause: { code: "23503" } });
    });

    integrationTest("requires settlement preview hash and expiry and rejects unsupported status", async () => {
        const { loan } = await seedLoan("tenant-preview", "lifecycle");
        const baseColumns = sql`
            (tenant_id, loan_id, as_of_date, outstanding_principal, due_interest,
             accrued_not_due_interest, outstanding_fees, outstanding_penalties,
             non_refundable_advance_interest, settlement_total, balance_version,
             preview_hash, status, expires_at)
        `;

        const insertWithoutHash = async () => db.execute(sql`
            INSERT INTO loan_settlement_previews ${baseColumns}
            VALUES ('tenant-preview', ${loan.id}, '2026-08-15', 5000.00, 0.00, 257.14,
                    0.00, 0.00, 0.00, 5257.14, 'balance-v1', NULL, 'ready', now() + interval '5 minutes')
        `);
        const insertWithoutExpiry = async () => db.execute(sql`
            INSERT INTO loan_settlement_previews ${baseColumns}
            VALUES ('tenant-preview', ${loan.id}, '2026-08-15', 5000.00, 0.00, 257.14,
                    0.00, 0.00, 0.00, 5257.14, 'balance-v1', 'hash', 'ready', NULL)
        `);

        await expect(insertWithoutHash()).rejects.toMatchObject({ cause: { code: "23502" } });
        await expect(insertWithoutExpiry()).rejects.toMatchObject({ cause: { code: "23502" } });
        await expectConstraintViolation(sql`
            INSERT INTO loan_settlement_previews ${baseColumns}
            VALUES ('tenant-preview', ${loan.id}, '2026-08-15', 5000.00, 0.00, 257.14,
                    0.00, 0.00, 0.00, 5257.14, 'balance-v1', 'hash', 'draft', now() + interval '5 minutes')
        `);
    });
});
