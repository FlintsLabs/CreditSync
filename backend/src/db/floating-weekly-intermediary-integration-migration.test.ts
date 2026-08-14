import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";

const backendRoot = `${import.meta.dir}/../../`;
const mainParent = "5268363";
const integrationTag = "0036_floating_weekly_intermediary_integration";
const removedBranchTags = [
    "0027_floating_interest_period_policy",
    "0028_intermediary_assignments_disbursement_groups",
    "0029_floating_interest_accrual_immutability",
] as const;
const authoritativeMainTail = [
    "0027_single_payment_restructure",
    "0028_floating_weekly_period_snapshots",
    "0029_floating_penalty_snapshots",
    "0030_floating_penalty_ledger",
    "0031_loan_waiver_previews",
    "0032_restructure_external_credit_allocation",
    "0033_early_settlement_waiver_scope",
    "0034_waiver_schedule_provenance",
    "0035_disbursement_restructure_relation",
] as const;
const authoritativeHashes: Record<(typeof authoritativeMainTail)[number], string> = {
    "0027_single_payment_restructure": "8c27192d3c621f990886a984c7c559bf14d4fe461f40f0988d9e188f92ac8c40",
    "0028_floating_weekly_period_snapshots": "37b066173ebfe4688f68dfff81d79c5fcfa9955428e86a219c93194b62bd59b5",
    "0029_floating_penalty_snapshots": "888cebc1338add134666299dae8de32bb7743c24c6e5072850810abd548bb10b",
    "0030_floating_penalty_ledger": "75075b3514b429aab3be538ad1ae7a11d43083f908e25ca354a020863da3a9d4",
    "0031_loan_waiver_previews": "481f291802947742537c40a327427b7ed047b45f4d90eca769731f9877b3804f",
    "0032_restructure_external_credit_allocation": "2fe7dc33d08138d4c7258a79af41c4c2b9e60c4f91c284aa5b6f4b970944af1d",
    "0033_early_settlement_waiver_scope": "64888da4a6064537514b7cb18badb2d6bd5fe4784630400d846b58cab5ddba25",
    "0034_waiver_schedule_provenance": "f760c242234bd58d035ef9f4d61b43dca7857f81475de8e75630edcf1de5c8ab",
    "0035_disbursement_restructure_relation": "39c5688bd53fdf3bb2603481f63b29e72c8d4d427b6d2ceb0c4664bcae78ffde",
};

type Journal = { entries: Array<{ idx: number; when: number; tag: string }> };

async function journal(): Promise<Journal> {
    return Bun.file(`${backendRoot}drizzle/meta/_journal.json`).json();
}

function sha256(value: string | Uint8Array) {
    return createHash("sha256").update(value).digest("hex");
}

describe("floating weekly and intermediary integration migration lineage", () => {
    test("keeps immutable main 0027 through 0035 followed by one monotonic 0036 tail", async () => {
        // Break caught: a deployed main migration is replaced/reordered, or Drizzle skips 0036 because its timestamp predates 0035.
        const entries = (await journal()).entries;
        expect(entries.slice(27).map((entry) => entry.tag)).toEqual([
            ...authoritativeMainTail,
            integrationTag,
        ]);
        expect(entries.slice(27).map((entry) => entry.idx)).toEqual([27, 28, 29, 30, 31, 32, 33, 34, 35, 36]);
        const integrationEntry = entries.at(-1)!;
        expect(integrationEntry.when).toBeGreaterThan(Math.max(...entries.slice(0, -1).map((entry) => entry.when)));
        expect(entries.filter((entry) => entry.tag === integrationTag)).toHaveLength(1);
    });

    test("removes the branch-local migration lineage instead of replaying it", async () => {
        // Break caught: one of the development-only 0027-0029 migrations is deployed after main under a stale tag or filename.
        const entries = (await journal()).entries;
        for (const tag of removedBranchTags) {
            expect(entries.some((entry) => entry.tag === tag)).toBe(false);
            expect(await Bun.file(`${backendRoot}drizzle/${tag}.sql`).exists()).toBe(false);
        }
        expect(await Bun.file(`${backendRoot}drizzle/${integrationTag}.sql`).exists()).toBe(true);
    });

    test("keeps authoritative main migration bytes identical to merge parent 5268363", async () => {
        // Break caught: semantic integration silently edits immutable production migration history.
        for (const tag of authoritativeMainTail) {
            const relativePath = `backend/drizzle/${tag}.sql`;
            const current = await Bun.file(`${backendRoot}drizzle/${tag}.sql`).text();
            const parent = Bun.spawnSync(["git", "show", `${mainParent}:${relativePath}`], {
                cwd: `${backendRoot}..`,
                stdout: "pipe",
                stderr: "pipe",
            });
            expect(parent.exitCode, new TextDecoder().decode(parent.stderr)).toBe(0);
            expect(current).toBe(new TextDecoder().decode(parent.stdout));
            expect(sha256(current)).toBe(authoritativeHashes[tag]);
        }
    });

    test("chains the integration snapshot directly from main 0035", async () => {
        // Break caught: generated metadata describes the removed branch lineage or a schema before main 0035.
        const [mainSnapshot, integrationSnapshot] = await Promise.all([
            Bun.file(`${backendRoot}drizzle/meta/0035_snapshot.json`).json(),
            Bun.file(`${backendRoot}drizzle/meta/0036_snapshot.json`).json(),
        ]);
        expect(integrationSnapshot.prevId).toBe(mainSnapshot.id);
        expect(integrationSnapshot.tables["public.loan_settlement_previews"]).toBeDefined();
        expect(integrationSnapshot.tables["public.intermediated_disbursement_groups"]).toBeDefined();
        for (const name of [
            "loans_single_payment_terms_check",
            "loans_floating_accrual_cycle_check",
            "loans_single_payment_money_check",
        ]) expect(integrationSnapshot.tables["public.loans"].checkConstraints).toHaveProperty(name);
    });
});

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

if (!testDatabaseUrl) {
    test.skip("main-through-0035 PostgreSQL upgrade boundary (TEST_DATABASE_URL is not set)", () => {});
} else {
    test("upgrades a seeded main-through-0035 database with only 0036 and preserves financial rows", async () => {
        // Break caught: 0036 cannot follow deployed main, mutates posted money/snapshots, or omits an integration table.
        const postgres = (await import("postgres")).default;
        const sql = postgres(testDatabaseUrl, { max: 1 });
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
            const entries = (await journal()).entries;
            for (const entry of entries.filter((candidate) => candidate.idx <= 35)) {
                await applySqlFile(`${backendRoot}drizzle/${entry.tag}.sql`);
            }

            await sql`INSERT INTO users (tenant_id, email, role) VALUES ('tenant-upgrade-0036', 'owner@upgrade-0036.test', 'owner')`;
            await sql`
                INSERT INTO borrowers (tenant_id, owner_user_id, name)
                SELECT tenant_id, id, 'Upgrade boundary borrower' FROM users WHERE email = 'owner@upgrade-0036.test'
            `;
            const seededLoans = await sql<{ id: number; public_id: string; repayment_type: string; principal_amount: string }[]>`
                INSERT INTO loans (
                    tenant_id, owner_user_id, borrower_id, principal_amount, interest_rate,
                    repayment_type, status, start_date, outstanding_principal, outstanding_interest,
                    outstanding_fees, single_payment_due_date, single_payment_fixed_agreed_interest,
                    single_payment_interest_policy, single_payment_late_penalty_mode,
                    daily_interest_mode, daily_interest_rate, first_day_treatment,
                    interest_start_date, floating_accrual_cycle
                )
                SELECT 'tenant-upgrade-0036', users.id, borrowers.id, fixture.principal, 0,
                    fixture.repayment_type, 'active', DATE '2026-08-01', fixture.principal, fixture.outstanding_interest,
                    fixture.outstanding_fees, fixture.single_due_date, fixture.single_interest,
                    fixture.single_policy, fixture.single_penalty_mode,
                    fixture.daily_mode, fixture.daily_rate, fixture.first_day_treatment,
                    fixture.interest_start_date, fixture.floating_cycle
                FROM users JOIN borrowers USING (tenant_id)
                CROSS JOIN (VALUES
                    (1100.00::numeric, 'single_payment'::text, 100.00::numeric, 5.00::numeric, DATE '2026-09-01', 100.00::numeric, 'fixed_only'::text, 'none'::text, NULL::text, NULL::numeric, NULL::text, NULL::date, NULL::text),
                    (1200.00::numeric, 'single_payment'::text, 0.00::numeric, 0.00::numeric, DATE '2026-10-01', 120.00::numeric, 'fixed_only'::text, 'none'::text, NULL::text, NULL::numeric, NULL::text, NULL::date, NULL::text),
                    (5000.00::numeric, 'floating'::text, 325.71::numeric, 0.00::numeric, NULL::date, NULL::numeric, NULL::text, NULL::text, 'percent'::text, 12.0000::numeric, 'none'::text, DATE '2026-08-13', 'weekly'::text),
                    (2000.00::numeric, 'floating'::text, 30.00::numeric, 0.00::numeric, NULL::date, NULL::numeric, NULL::text, NULL::text, 'per_thousand'::text, 15.0000::numeric, 'none'::text, DATE '2026-08-14', 'daily'::text),
                    (2001.00::numeric, 'floating'::text, 4.29::numeric, 0.00::numeric, NULL::date, NULL::numeric, NULL::text, NULL::text, 'per_thousand'::text, 15.0000::numeric, 'none'::text, DATE '2026-08-21', 'weekly'::text)
                ) AS fixture(principal, repayment_type, outstanding_interest, outstanding_fees, single_due_date, single_interest, single_policy, single_penalty_mode, daily_mode, daily_rate, first_day_treatment, interest_start_date, floating_cycle)
                WHERE users.email = 'owner@upgrade-0036.test'
                RETURNING id, public_id, repayment_type, principal_amount
            `;
            const singleLoans = seededLoans.filter((loan) => loan.repayment_type === "single_payment");
            const weeklyFloatingLoan = seededLoans.find((loan) => loan.principal_amount === "5000.00")!;
            const dailyFloatingLoan = seededLoans.find((loan) => loan.principal_amount === "2000.00")!;
            const perThousandWeeklyLoan = seededLoans.find((loan) => loan.principal_amount === "2001.00")!;
            const actor = (await sql<{ id: number }[]>`SELECT id FROM users WHERE email = 'owner@upgrade-0036.test'`)[0]!;

            const ratePeriods = await sql<{ id: number; loan_id: number }[]>`
                INSERT INTO loan_interest_rate_periods (
                    tenant_id, loan_id, effective_date, rate_type, rate, created_by_user_id
                ) VALUES
                    ('tenant-upgrade-0036', ${weeklyFloatingLoan.id}, DATE '2026-08-13', 'percent', 12.0000, ${actor.id}),
                    ('tenant-upgrade-0036', ${dailyFloatingLoan.id}, DATE '2026-08-14', 'per_thousand', 15.0000, ${actor.id}),
                    ('tenant-upgrade-0036', ${perThousandWeeklyLoan.id}, DATE '2026-08-21', 'per_thousand', 15.0000, ${actor.id})
                RETURNING id, loan_id
            `;
            const weeklyRatePeriod = ratePeriods.find((period) => period.loan_id === weeklyFloatingLoan.id)!;
            const dailyRatePeriod = ratePeriods.find((period) => period.loan_id === dailyFloatingLoan.id)!;
            const perThousandWeeklyRatePeriod = ratePeriods.find((period) => period.loan_id === perThousandWeeklyLoan.id)!;

            await sql`
                INSERT INTO loan_schedules (
                    tenant_id, loan_id, installment_no, due_date, scheduled_principal,
                    scheduled_interest, scheduled_fee, scheduled_total, paid_total,
                    paid_penalty, remaining_due, overdue_days, status
                ) VALUES ('tenant-upgrade-0036', ${singleLoans[0]!.id}, 1, DATE '2026-09-01', 1100.00, 100.00, 5.00, 1205.00, 205.00, 0.00, 1000.00, 0, 'partial')
            `;
            await sql`
                INSERT INTO transactions (
                    tenant_id, owner_user_id, loan_id, amount, principal_component,
                    interest_component, fee_component, penalty_component, transaction_date,
                    entry_type, idempotency_key, posted_at
                ) VALUES ('tenant-upgrade-0036', ${actor.id}, ${singleLoans[0]!.id}, 205.00, 100.00, 100.00, 5.00, 0.00,
                    TIMESTAMP '2026-08-14 03:00:00', 'repayment', 'upgrade-0036-payment', TIMESTAMP '2026-08-14 03:00:00')
            `;
            await sql`
                INSERT INTO loan_interest_accruals (
                    tenant_id, loan_id, interest_rate_period_id, accrual_date, opening_principal, rate_mode, rate,
                    period_start_date, period_end_date, period_day_index, period_days,
                    cumulative_interest_amount, interest_amount, paid_amount,
                    accrued_penalty, paid_penalty, status, created_by_user_id
                ) VALUES
                    ('tenant-upgrade-0036', ${weeklyFloatingLoan.id}, ${weeklyRatePeriod.id}, DATE '2026-08-15', 5000.00, 'percent', 12.0000,
                        DATE '2026-08-13', DATE '2026-08-20', 3, 7, 257.14, 85.71, 0.00, 2.00, 0.00, 'accruing', ${actor.id}),
                    ('tenant-upgrade-0036', ${weeklyFloatingLoan.id}, ${weeklyRatePeriod.id}, DATE '2026-08-16', 4000.00, 'percent', 12.0000,
                        DATE '2026-08-13', DATE '2026-08-20', 4, 7, 325.71, 68.57, 0.00, 0.00, 0.00, 'accruing', ${actor.id}),
                    ('tenant-upgrade-0036', ${perThousandWeeklyLoan.id}, ${perThousandWeeklyRatePeriod.id}, DATE '2026-08-21', 2001.00, 'per_thousand', 15.0000,
                        DATE '2026-08-21', DATE '2026-08-28', 1, 7, 4.29, 4.29, 0.00, 1.01, 0.00, 'accruing', ${actor.id})
            `;
            const audit = await sql<{ public_id: string }[]>`
                INSERT INTO audit_logs (tenant_id, entity_type, entity_id, action, actor_user_id, actor_source, correlation_id)
                VALUES ('tenant-upgrade-0036', 'loan_restructure', 'upgrade-0036', 'executed', ${actor.id}, 'web', 'upgrade-0036-restructure')
                RETURNING public_id
            `;
            const restructure = await sql<{ id: number }[]>`
                INSERT INTO loan_restructures (
                    tenant_id, old_loan_id, new_loan_id, settlement_date, old_balance_version,
                    status, preview_hash, request_hash, requested_replacement_terms,
                    gross_principal, gross_interest, gross_fees, gross_penalty,
                    waived_interest, waived_fees, waived_penalty, net_principal, net_interest, net_fees, net_penalty,
                    external_settlement_credits, additional_principal, cash_direction, cash_amount,
                    reason, created_actor_source, execute_actor_source, correlation_id,
                    execute_idempotency_key, execute_request_hash, executed_audit_public_id,
                    pre_execution_old_loan_state, expires_at, executed_at, created_by_user_id, executed_by_user_id
                ) VALUES ('tenant-upgrade-0036', ${singleLoans[0]!.id}, ${singleLoans[1]!.id}, DATE '2026-08-14', 'balance-upgrade-0036',
                    'executed', 'preview-upgrade-0036', 'request-upgrade-0036', '{}'::jsonb,
                    1100.00, 100.00, 5.00, 0.00, 0.00, 0.00, 0.00, 1100.00, 100.00, 5.00, 0.00,
                    0.00, 0.00, 'none', 0.00, 'approved upgrade fixture', 'web', 'web', 'upgrade-0036-restructure',
                    'execute-upgrade-0036', 'execute-hash-upgrade-0036', ${audit[0]!.public_id}::uuid,
                    '{"status":"active","outstandingPrincipal":"1100.00","outstandingInterest":"100.00","outstandingFees":"5.00","nextDueDate":null}'::jsonb,
                    now() + interval '1 hour', now(), ${actor.id}, ${actor.id}) RETURNING id
            `;
            await sql`
                INSERT INTO loan_opening_balance_components (
                    tenant_id, restructure_id, loan_id, component_kind, amount, source_type, source_public_id, created_by_user_id
                ) VALUES ('tenant-upgrade-0036', ${restructure[0]!.id}, ${singleLoans[1]!.id}, 'carried_principal', 1100.00, 'loan', ${singleLoans[0]!.public_id}::uuid, ${actor.id})
            `;

            const capture = async () => ({
                transactions: await sql`SELECT id, public_id, tenant_id, loan_id, amount, principal_component, interest_component, fee_component, penalty_component, transaction_date, entry_type, idempotency_key, posted_at FROM transactions ORDER BY id`,
                loanSchedules: await sql`SELECT id, public_id, tenant_id, loan_id, installment_no, due_date, scheduled_principal, scheduled_interest, scheduled_fee, scheduled_total, paid_total, paid_penalty, remaining_due, overdue_days, status FROM loan_schedules ORDER BY id`,
                openingBalances: await sql`SELECT id, public_id, tenant_id, restructure_id, loan_id, component_kind, amount, source_type, source_public_id, status FROM loan_opening_balance_components ORDER BY id`,
                restructures: await sql`SELECT id, public_id, status, gross_principal, gross_interest, gross_fees, gross_penalty, waived_interest, waived_fees, waived_penalty, net_principal, net_interest, net_fees, net_penalty, external_settlement_credits, additional_principal, cash_direction, cash_amount FROM loan_restructures ORDER BY id`,
                floatingAccruals: await sql`SELECT id, public_id, tenant_id, loan_id, interest_rate_period_id, accrual_date, opening_principal, rate_mode, rate, cumulative_interest_amount, interest_amount, paid_amount, accrued_penalty, paid_penalty, status FROM loan_interest_accruals ORDER BY id`,
            });
            const before = await capture();

            await applySqlFile(`${backendRoot}drizzle/${integrationTag}.sql`);

            const after = await capture();
            expect(after.transactions).toEqual(before.transactions);
            expect(after.loanSchedules).toEqual(before.loanSchedules);
            expect(after.openingBalances).toEqual(before.openingBalances);
            expect(after.restructures).toEqual(before.restructures);
            expect(after.floatingAccruals).toEqual(before.floatingAccruals);
            const integrationTables = await sql<{ table_name: string }[]>`
                SELECT table_name FROM information_schema.tables
                WHERE table_schema = 'public' AND table_name IN ('loan_settlement_previews', 'intermediated_disbursement_groups')
                ORDER BY table_name
            `;
            expect(integrationTables.map((row) => row.table_name)).toEqual(expect.arrayContaining([
                "loan_settlement_previews",
                "intermediated_disbursement_groups",
            ]));
            const loanBackfill = await sql`
                SELECT id, interest_period_unit, interest_period_length, advance_interest_periods,
                    advance_interest_refund_policy, interest_period_anchor_date::text AS interest_period_anchor_date
                FROM loans WHERE id IN (${weeklyFloatingLoan.id}, ${dailyFloatingLoan.id}) ORDER BY id
            `;
            expect(loanBackfill.find((loan) => loan.id === weeklyFloatingLoan.id)).toMatchObject({
                interest_period_unit: "week",
                interest_period_length: 1,
                advance_interest_periods: 0,
                advance_interest_refund_policy: "non_refundable",
                interest_period_anchor_date: "2026-08-13",
            });
            expect(loanBackfill.find((loan) => loan.id === dailyFloatingLoan.id)).toMatchObject({
                interest_period_unit: "day",
                interest_period_length: 1,
                advance_interest_periods: 0,
                advance_interest_refund_policy: "non_refundable",
                interest_period_anchor_date: "2026-08-14",
            });
            const ratePeriodBackfill = await sql`
                SELECT loan_id, period_unit, period_length
                FROM loan_interest_rate_periods
                WHERE id IN (${weeklyRatePeriod.id}, ${dailyRatePeriod.id}, ${perThousandWeeklyRatePeriod.id}) ORDER BY id
            `;
            expect([...ratePeriodBackfill]).toEqual([
                { loan_id: weeklyFloatingLoan.id, period_unit: "week", period_length: 1 },
                { loan_id: dailyFloatingLoan.id, period_unit: "day", period_length: 1 },
                { loan_id: perThousandWeeklyLoan.id, period_unit: "week", period_length: 1 },
            ]);
            const accrualProjection = await sql`
                SELECT accrual_date::text AS accrual_date, period_unit, period_length,
                    contractual_interest_amount, cumulative_interest_amount, daily_increment_amount
                FROM loan_interest_accruals ORDER BY accrual_date, id
            `;
            expect([...accrualProjection]).toEqual([
                { accrual_date: "2026-08-15", period_unit: "week", period_length: 1, contractual_interest_amount: "600.00", cumulative_interest_amount: "257.14", daily_increment_amount: "85.71" },
                { accrual_date: "2026-08-16", period_unit: "week", period_length: 1, contractual_interest_amount: "480.00", cumulative_interest_amount: "325.71", daily_increment_amount: "68.57" },
                { accrual_date: "2026-08-21", period_unit: "week", period_length: 1, contractual_interest_amount: "30.02", cumulative_interest_amount: "4.29", daily_increment_amount: "4.29" },
            ]);
        } finally {
            await sql.end();
        }
    });

    test("applies the complete journal through 0036 to an empty database", async () => {
        // Break caught: the consolidated migration only upgrades a seeded database but fails a clean install.
        const postgres = (await import("postgres")).default;
        const sql = postgres(testDatabaseUrl, { max: 1 });
        try {
            await sql.unsafe("DROP SCHEMA public CASCADE");
            await sql.unsafe("DROP SCHEMA IF EXISTS drizzle CASCADE");
            await sql.unsafe("CREATE SCHEMA public");
            for (const entry of (await journal()).entries) {
                const content = await Bun.file(`${backendRoot}drizzle/${entry.tag}.sql`).text();
                for (const statement of content.split("--> statement-breakpoint")) {
                    if (statement.trim()) await sql.unsafe(statement);
                }
            }
            const tables = await sql<{ table_name: string }[]>`
                SELECT table_name FROM information_schema.tables
                WHERE table_schema = 'public' AND table_name IN ('loan_settlement_previews', 'intermediated_disbursement_groups')
            `;
            expect(tables).toHaveLength(2);
        } finally {
            await sql.end();
        }
    });
}
