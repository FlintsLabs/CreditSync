import { afterAll, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { inspectLoanOriginationSchema } from "./loan-origination-schema-contract";

const backendRoot = `${import.meta.dir}/../../`;
const migrationTag = "0038_production_loan_schema_reconciliation";
const databaseUrl = process.env.TEST_DATABASE_URL;
const integrationTest = databaseUrl ? test : test.skip;

const expectedMissingObjects = [
    "loans.interest_period_unit",
    "loans.interest_period_length",
    "loans.advance_interest_periods",
    "loans.advance_interest_refund_policy",
    "loans.interest_period_anchor_date",
    "loans.single_payment_due_date",
    "loans.single_payment_fixed_agreed_interest",
    "loans.single_payment_interest_policy",
    "loans.single_payment_retroactive_rate_type",
    "loans.single_payment_retroactive_rate",
    "loans.single_payment_late_penalty_mode",
    "loans.single_payment_late_penalty_amount_per_day",
    "loans.single_payment_late_penalty_grace_days",
    "loans.floating_accrual_cycle",
    "loans.activation_idempotency_key",
    "loans.activation_result",
    "loans.loans_single_payment_terms_check",
    "loans.loans_floating_accrual_cycle_check",
    "loans.loans_single_payment_money_check",
    "loans.loans_interest_period_unit_check",
    "loans.loans_interest_period_length_check",
    "loans.loans_advance_interest_periods_check",
    "loans.loans_advance_interest_refund_policy_check",
    "loans.loans_interest_period_policy_completeness_check",
    "loans.loans_activation_command_completeness_check",
    "loans.loans_tenant_activation_idempotency_unique",
];

async function applySqlFile(sql: ReturnType<typeof postgres>, path: string) {
    const content = await Bun.file(path).text();
    for (const statement of content.split("--> statement-breakpoint")) {
        if (statement.trim()) await sql.unsafe(statement);
    }
}

async function resetAndApplyThrough0030(sql: ReturnType<typeof postgres>) {
    await sql.unsafe("DROP SCHEMA public CASCADE");
    await sql.unsafe("DROP SCHEMA IF EXISTS drizzle CASCADE");
    await sql.unsafe("CREATE SCHEMA public");
    const journal = await Bun.file(`${backendRoot}drizzle/meta/_journal.json`).json() as { entries: Array<{ idx: number; tag: string }> };
    for (const entry of journal.entries.filter((candidate) => candidate.idx <= 30)) {
        await applySqlFile(sql, `${backendRoot}drizzle/${entry.tag}.sql`);
    }
    await sql.unsafe("CREATE SCHEMA drizzle; CREATE TABLE drizzle.__drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint NOT NULL)");
    await sql.unsafe(`
        DO $$
        DECLARE name text;
        BEGIN
            FOREACH name IN ARRAY ARRAY[
                'loans_single_payment_terms_check', 'loans_floating_accrual_cycle_check',
                'loans_single_payment_money_check', 'loans_interest_period_unit_check',
                'loans_interest_period_length_check', 'loans_advance_interest_periods_check',
                'loans_advance_interest_refund_policy_check', 'loans_interest_period_policy_completeness_check',
                'loans_activation_command_completeness_check'
            ] LOOP
                IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.loans'::regclass AND conname = name) THEN
                    EXECUTE format('ALTER TABLE public.loans DROP CONSTRAINT %I', name);
                END IF;
            END LOOP;
            IF to_regclass('public.loans_tenant_activation_idempotency_unique') IS NOT NULL THEN
                DROP INDEX public.loans_tenant_activation_idempotency_unique;
            END IF;
        END $$;
    `);
    await sql.unsafe(`
        ALTER TABLE public.loans
            DROP COLUMN IF EXISTS interest_period_unit,
            DROP COLUMN IF EXISTS interest_period_length,
            DROP COLUMN IF EXISTS advance_interest_periods,
            DROP COLUMN IF EXISTS advance_interest_refund_policy,
            DROP COLUMN IF EXISTS interest_period_anchor_date,
            DROP COLUMN IF EXISTS single_payment_due_date,
            DROP COLUMN IF EXISTS single_payment_fixed_agreed_interest,
            DROP COLUMN IF EXISTS single_payment_interest_policy,
            DROP COLUMN IF EXISTS single_payment_retroactive_rate_type,
            DROP COLUMN IF EXISTS single_payment_retroactive_rate,
            DROP COLUMN IF EXISTS single_payment_late_penalty_mode,
            DROP COLUMN IF EXISTS single_payment_late_penalty_amount_per_day,
            DROP COLUMN IF EXISTS single_payment_late_penalty_grace_days,
            DROP COLUMN IF EXISTS floating_accrual_cycle,
            DROP COLUMN IF EXISTS activation_idempotency_key,
            DROP COLUMN IF EXISTS activation_result
    `);
    await sql.unsafe("DROP FUNCTION IF EXISTS public.validate_floating_interest_paid_cache() CASCADE");
}

async function restoreFullyMigratedSchema() {
    const sql = postgres(databaseUrl!, { max: 1 });
    try {
        await sql.unsafe("DROP SCHEMA public CASCADE");
        await sql.unsafe("DROP SCHEMA IF EXISTS drizzle CASCADE");
        await sql.unsafe("CREATE SCHEMA public");
        await migrate(drizzle(sql), { migrationsFolder: `${backendRoot}drizzle` });
    } finally {
        await sql.end();
    }
}

afterAll(async () => {
    if (databaseUrl) await restoreFullyMigratedSchema();
});

async function seedHistoricalFloatingLoan(sql: ReturnType<typeof postgres>) {
    await sql`INSERT INTO users (tenant_id, email, role) VALUES ('tenant-production-drift', 'owner@production-drift.test', 'owner')`;
    await sql`
        INSERT INTO borrowers (tenant_id, owner_user_id, name)
        SELECT tenant_id, id, 'Production drift borrower' FROM users WHERE email = 'owner@production-drift.test'
    `;
    const loans = await sql<{ id: number; public_id: string }[]>`
        INSERT INTO loans (tenant_id, owner_user_id, borrower_id, principal_amount, interest_rate,
            repayment_type, status, start_date, outstanding_principal, outstanding_interest,
            outstanding_fees, daily_interest_mode, daily_interest_rate, first_day_treatment, interest_start_date)
        SELECT 'tenant-production-drift', users.id, borrowers.id, 7500.00, 0,
            'floating', 'active', DATE '2026-08-01', 7500.00, 125.50, 0.00,
            'percent', 12.0000, 'start_next_day', DATE '2026-08-02'
        FROM users JOIN borrowers USING (tenant_id)
        WHERE users.email = 'owner@production-drift.test'
        RETURNING id, public_id
    `;
    const loan = loans[0]!;
    const users = await sql<{ id: number }[]>`SELECT id FROM users WHERE email = 'owner@production-drift.test'`;
    const periods = await sql<{ id: number }[]>`
        INSERT INTO loan_interest_rate_periods (tenant_id, loan_id, effective_date, rate_type, rate, created_by_user_id)
        VALUES ('tenant-production-drift', ${loan.id}, DATE '2026-08-02', 'percent', 12.0000, ${users[0]!.id})
        RETURNING id
    `;
    const accruals = await sql<{ public_id: string; interest_amount: string }[]>`
        INSERT INTO loan_interest_accruals (tenant_id, loan_id, interest_rate_period_id, accrual_date,
            opening_principal, rate_mode, rate, period_start_date, period_end_date, period_day_index,
            period_days, cumulative_interest_amount, interest_amount, paid_amount, accrued_penalty,
            paid_penalty, status, created_by_user_id)
        VALUES ('tenant-production-drift', ${loan.id}, ${periods[0]!.id}, DATE '2026-08-16', 7500.00,
            'percent', 12.0000, DATE '2026-08-02', DATE '2026-08-09', 7, 7, 125.50, 12.33,
            0.00, 0.00, 0.00, 'accruing', ${users[0]!.id})
        RETURNING public_id, interest_amount
    `;
    return { loan, accrual: accruals[0]! };
}

async function snapshotTargetCatalog(sql: ReturnType<typeof postgres>) {
    const [columns, constraints, index] = await Promise.all([
        sql`
            SELECT column_name, data_type, udt_name, is_nullable, numeric_precision, numeric_scale, ordinal_position
            FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'loans'
              AND column_name = ANY(${sql.array([
                  "interest_period_unit", "interest_period_length", "advance_interest_periods",
                  "advance_interest_refund_policy", "interest_period_anchor_date", "single_payment_due_date",
                  "single_payment_fixed_agreed_interest", "single_payment_interest_policy",
                  "single_payment_retroactive_rate_type", "single_payment_retroactive_rate",
                  "single_payment_late_penalty_mode", "single_payment_late_penalty_amount_per_day",
                  "single_payment_late_penalty_grace_days", "floating_accrual_cycle",
                  "activation_idempotency_key", "activation_result",
              ])}::text[])
            ORDER BY ordinal_position
        `,
        sql`
            SELECT conname, contype, convalidated, pg_get_constraintdef(oid, true) AS definition
            FROM pg_constraint
            WHERE conrelid = 'public.loans'::regclass
              AND conname = ANY(${sql.array([
                  "loans_term_months_check", "loans_one_funding_source_check", "loans_single_payment_terms_check",
                  "loans_floating_accrual_cycle_check", "loans_single_payment_money_check",
                  "loans_interest_period_unit_check", "loans_interest_period_length_check",
                  "loans_advance_interest_periods_check", "loans_advance_interest_refund_policy_check",
                  "loans_interest_period_policy_completeness_check", "loans_activation_command_completeness_check",
              ])}::name[])
            ORDER BY conname
        `,
        sql`
            SELECT i.indexname, i.indexdef, c.oid::regclass::text AS index_relation
            FROM pg_indexes AS i
            JOIN pg_class AS c ON c.relname = i.indexname AND c.relnamespace = 'public'::regnamespace
            WHERE i.schemaname = 'public' AND i.tablename = 'loans'
              AND i.indexname = 'loans_tenant_activation_idempotency_unique'
        `,
    ]);
    return { columns: Array.from(columns), constraints: Array.from(constraints), index: Array.from(index) };
}

async function expectRejectedWithoutCatalogChange(sql: ReturnType<typeof postgres>, setup: () => Promise<void>) {
    await resetAndApplyThrough0030(sql);
    await setup();
    const before = await snapshotTargetCatalog(sql);
    await expect(applySqlFile(sql, `${backendRoot}drizzle/${migrationTag}.sql`)).rejects.toThrow(/0038|incompatible/i);
    expect(await snapshotTargetCatalog(sql)).toEqual(before);
}

integrationTest("reconciles the production-shaped 2026-08-16 drift repeatably without changing financial rows", async () => {
    const sql = postgres(databaseUrl!, { max: 1 });
    try {
        await resetAndApplyThrough0030(sql);
        const seeded = await seedHistoricalFloatingLoan(sql);
        const before = await inspectLoanOriginationSchema(sql);
        expect(before.objects.filter((object) => object.state !== "compatible").map((object) => object.name)).toEqual(expectedMissingObjects);
        expect(before.objects
            .filter((object) => object.name === "loans.loans_term_months_check" || object.name === "loans.loans_one_funding_source_check")
            .map((object) => `${object.name}:${object.state}`))
            .toEqual([
                "loans.loans_term_months_check:compatible",
                "loans.loans_one_funding_source_check:compatible",
            ]);

        const financialBefore = await sql`
            SELECT public_id, principal_amount, outstanding_principal, outstanding_interest, status
            FROM loans WHERE id = ${seeded.loan.id}
        `;
        const accrualBefore = await sql`
            SELECT public_id, interest_amount, paid_amount, status
            FROM loan_interest_accruals WHERE public_id = ${seeded.accrual.public_id}
        `;

        await applySqlFile(sql, `${backendRoot}drizzle/${migrationTag}.sql`);
        const after = await inspectLoanOriginationSchema(sql);
        expect(after.compatible).toBe(true);
        const financialAfterFirst = await sql`
            SELECT public_id, principal_amount, outstanding_principal, outstanding_interest, status
            FROM loans WHERE id = ${seeded.loan.id}
        `;
        const accrualAfterFirst = await sql`
            SELECT public_id, interest_amount, paid_amount, status
            FROM loan_interest_accruals WHERE public_id = ${seeded.accrual.public_id}
        `;
        expect(financialAfterFirst.length).toBe(1);
        expect(accrualAfterFirst.length).toBe(1);
        expect(Array.from(financialAfterFirst)).toEqual(Array.from(financialBefore));
        expect(Array.from(accrualAfterFirst)).toEqual(Array.from(accrualBefore));

        await applySqlFile(sql, `${backendRoot}drizzle/${migrationTag}.sql`);
        expect(await inspectLoanOriginationSchema(sql)).toMatchObject({ compatible: true });
        const financialAfterSecond = await sql`
            SELECT public_id, principal_amount, outstanding_principal, outstanding_interest, status
            FROM loans WHERE id = ${seeded.loan.id}
        `;
        const accrualAfterSecond = await sql`
            SELECT public_id, interest_amount, paid_amount, status
            FROM loan_interest_accruals WHERE public_id = ${seeded.accrual.public_id}
        `;
        expect(financialAfterSecond.length).toBe(1);
        expect(accrualAfterSecond.length).toBe(1);
        expect(Array.from(financialAfterSecond)).toEqual(Array.from(financialBefore));
        expect(Array.from(accrualAfterSecond)).toEqual(Array.from(accrualBefore));
    } finally {
        await sql.end();
    }
});

integrationTest("rejects an incompatible complex same-named constraint before any DDL", async () => {
    const sql = postgres(databaseUrl!, { max: 1 });
    try {
        await expectRejectedWithoutCatalogChange(sql, async () => {
            await sql.unsafe(`ALTER TABLE public.loans ADD CONSTRAINT loans_single_payment_terms_check CHECK ((term_months IS NULL OR term_months > 0) AND term_months IS NOT NULL)`);
        });
    } finally { await sql.end(); }
});

integrationTest("rejects a subtly incompatible simple same-named constraint", async () => {
    const sql = postgres(databaseUrl!, { max: 1 });
    try {
        await expectRejectedWithoutCatalogChange(sql, async () => {
            await sql.unsafe(`ALTER TABLE public.loans ADD COLUMN interest_period_unit text`);
            await sql.unsafe(`ALTER TABLE public.loans ADD CONSTRAINT loans_interest_period_unit_check CHECK (interest_period_unit IS NULL OR interest_period_unit IN ('day', 'week', 'month'))`);
        });
    } finally { await sql.end(); }
});

for (const [label, definition] of [
    ["wrong non-unique", `CREATE INDEX loans_tenant_activation_idempotency_unique ON public.loans (tenant_id, activation_idempotency_key) WHERE activation_idempotency_key IS NOT NULL`],
    ["reversed keys", `CREATE UNIQUE INDEX loans_tenant_activation_idempotency_unique ON public.loans (activation_idempotency_key, tenant_id) WHERE activation_idempotency_key IS NOT NULL`],
    ["missing key", `CREATE UNIQUE INDEX loans_tenant_activation_idempotency_unique ON public.loans (tenant_id) WHERE activation_idempotency_key IS NOT NULL`],
] as const) {
    integrationTest(`rejects a ${label} same-named index`, async () => {
        const sql = postgres(databaseUrl!, { max: 1 });
        try {
            await expectRejectedWithoutCatalogChange(sql, async () => {
                await sql.unsafe(`ALTER TABLE public.loans ADD COLUMN activation_idempotency_key text`);
                await sql.unsafe(definition);
            });
        } finally { await sql.end(); }
    });
}

integrationTest("rejects a correctly typed NOT NULL target column", async () => {
    const sql = postgres(databaseUrl!, { max: 1 });
    try {
        await expectRejectedWithoutCatalogChange(sql, async () => {
            await sql.unsafe(`ALTER TABLE public.loans ADD COLUMN activation_result jsonb NOT NULL DEFAULT '{}'::jsonb`);
        });
    } finally { await sql.end(); }
});

integrationTest("aborts before changing objects when activation_result has an incompatible type", async () => {
    const sql = postgres(databaseUrl!, { max: 1 });
    try {
        await expectRejectedWithoutCatalogChange(sql, async () => {
            await sql.unsafe("ALTER TABLE public.loans ADD COLUMN activation_result text");
        });
    } finally {
        await sql.end();
    }
});
