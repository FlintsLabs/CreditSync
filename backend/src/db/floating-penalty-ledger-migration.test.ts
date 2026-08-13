import { expect, test } from "bun:test";

const backendRoot = `${import.meta.dir}/../../`;
const migrationTag = "0030_floating_penalty_ledger";
const migrationPath = `${backendRoot}drizzle/${migrationTag}.sql`;
const journalPath = `${backendRoot}drizzle/meta/_journal.json`;
const testDatabaseUrl = process.env.TEST_DATABASE_URL;

if (!testDatabaseUrl) {
    test.skip("floating penalty ledger PostgreSQL cutover (TEST_DATABASE_URL is not set)", () => {});
} else {
    test("cuts legacy floating state over exactly and enforces append-only provenance", async () => {
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

            const journal = await Bun.file(journalPath).json() as {
                entries: Array<{ idx: number; tag: string }>;
            };
            const targetIndex = journal.entries.find((entry) => entry.tag === migrationTag)?.idx;
            expect(targetIndex).toBe(30);
            for (const entry of journal.entries.filter((candidate) => candidate.idx < targetIndex!)) {
                await applySqlFile(`${backendRoot}drizzle/${entry.tag}.sql`);
            }

            await sql`
                INSERT INTO users (tenant_id, email, role)
                VALUES ('tenant-a', 'actor@floating-ledger.test', 'owner')
            `;
            await sql`
                INSERT INTO borrowers (tenant_id, owner_user_id, name)
                SELECT tenant_id, id, 'Floating ledger borrower'
                FROM users WHERE email = 'actor@floating-ledger.test'
            `;
            const seededLoans = await sql<{ id: number; principal_amount: string }[]>`
                INSERT INTO loans (
                    tenant_id, owner_user_id, borrower_id, principal_amount, interest_rate,
                    repayment_type, status, start_date, outstanding_principal,
                    daily_interest_mode, daily_interest_rate, first_day_treatment,
                    interest_start_date, floating_accrual_cycle, late_fee_mode,
                    late_fee_amount, grace_period_days
                )
                SELECT
                    'tenant-a', users.id, borrowers.id, fixture.principal, 0,
                    'floating', 'active', fixture.start_date, fixture.principal,
                    'percent', 1, fixture.first_day_treatment,
                    fixture.start_date, fixture.cycle, fixture.late_fee_mode,
                    fixture.late_fee_amount, 0
                FROM users
                JOIN borrowers ON borrowers.tenant_id = users.tenant_id
                CROSS JOIN (
                    VALUES
                        (1000::numeric, ((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Bangkok')::date - 40), 'daily'::text, 'none'::text, 'daily_percent'::text, 1::numeric),
                        (2000::numeric, ((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Bangkok')::date - 20), 'daily'::text, 'none'::text, 'none'::text, 0::numeric),
                        (3000::numeric, ((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Bangkok')::date - 5), 'daily'::text, 'none'::text, 'none'::text, 0::numeric),
                        (4000::numeric, ((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Bangkok')::date - 5), 'weekly'::text, 'deduct'::text, 'none'::text, 0::numeric),
                        (5000::numeric, ((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Bangkok')::date - 5), 'daily'::text, 'none'::text, 'none'::text, 0::numeric)
                ) AS fixture(principal, start_date, cycle, first_day_treatment, late_fee_mode, late_fee_amount)
                WHERE users.email = 'actor@floating-ledger.test'
                RETURNING id, principal_amount
            `;
            const loanId = (principal: string) => seededLoans.find((loan) => loan.principal_amount === principal)!.id;
            const mainLoanId = loanId("1000");
            const fifoLoanId = loanId("2000");
            const zeroLoanId = loanId("3000");
            const weeklyDeductLoanId = loanId("4000");
            const emptyLoanId = loanId("5000");

            const mainAccruals = await sql<{ id: number }[]>`
                INSERT INTO loan_interest_accruals (
                    tenant_id, loan_id, accrual_date, opening_principal, rate_mode, rate,
                    period_start_date, period_end_date, period_day_index, period_days,
                    cumulative_interest_amount, interest_amount, paid_amount,
                    accrued_penalty, paid_penalty, status
                ) VALUES
                    (
                        'tenant-a', ${mainLoanId},
                        (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Bangkok')::date - 36,
                        1000, 'percent', 1,
                        (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Bangkok')::date - 37,
                        (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Bangkok')::date - 30,
                        1, 7, 100, 100, 30, 12.34, 5, 'partially_paid'
                    ),
                    (
                        'tenant-a', ${mainLoanId},
                        (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Bangkok')::date - 35,
                        1000, 'percent', 1,
                        (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Bangkok')::date - 37,
                        (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Bangkok')::date - 30,
                        2, 7, 150, 50, 30, 7.66, 3, 'partially_paid'
                    )
                RETURNING id
            `;
            await sql`
                INSERT INTO loan_interest_accruals (
                    tenant_id, loan_id, accrual_date, opening_principal, rate_mode, rate,
                    interest_amount, paid_amount, accrued_penalty, paid_penalty, status
                ) VALUES
                    (
                        'tenant-a', ${fifoLoanId},
                        (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Bangkok')::date - 12,
                        2000, 'percent', 1, 10, 0, 5, 5, 'accrued'
                    ),
                    (
                        'tenant-a', ${fifoLoanId},
                        (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Bangkok')::date - 11,
                        2000, 'percent', 1, 10, 0, 10, 10, 'accrued'
                    ),
                    (
                        'tenant-a', ${zeroLoanId},
                        (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Bangkok')::date + 5,
                        3000, 'percent', 1, 40, 0, 0, 0, 'accrued'
                    ),
                    (
                        'tenant-a', ${weeklyDeductLoanId},
                        (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Bangkok')::date - 5,
                        4000, 'percent', 1, 10, 10, 0, 0, 'paid'
                    )
            `;

            const mainTransactions = await sql<{ id: number }[]>`
                INSERT INTO transactions (
                    tenant_id, owner_user_id, loan_id, amount, principal_component,
                    interest_component, fee_component, penalty_component,
                    transaction_date, entry_type, posted_at
                )
                SELECT 'tenant-a', users.id, ${mainLoanId}, fixture.amount,
                    fixture.principal, fixture.interest, 0, fixture.penalty,
                    fixture.effective_at, 'repayment', fixture.effective_at
                FROM users
                CROSS JOIN (
                    VALUES
                        (60::numeric, 25::numeric, 30::numeric, 5::numeric,
                            ((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Bangkok')::date - 2)::timestamp - interval '7 hours'),
                        (33::numeric, 0::numeric, 30::numeric, 3::numeric,
                            ((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Bangkok')::date - 1)::timestamp - interval '7 hours')
                ) AS fixture(amount, principal, interest, penalty, effective_at)
                WHERE users.email = 'actor@floating-ledger.test'
                RETURNING id
            `;
            const fifoTransactions = await sql<{ id: number }[]>`
                INSERT INTO transactions (
                    tenant_id, owner_user_id, loan_id, amount, principal_component,
                    interest_component, fee_component, penalty_component,
                    transaction_date, entry_type, posted_at
                )
                SELECT 'tenant-a', users.id, ${fifoLoanId}, fixture.amount,
                    0, 0, 0, fixture.amount, fixture.effective_at, 'repayment', fixture.effective_at
                FROM users
                CROSS JOIN (
                    VALUES
                        (10::numeric, ((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Bangkok')::date + 2)::timestamp - interval '7 hours'),
                        (5::numeric, ((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Bangkok')::date + 1)::timestamp - interval '7 hours')
                ) AS fixture(amount, effective_at)
                WHERE users.email = 'actor@floating-ledger.test'
                RETURNING id
            `;

            await applySqlFile(migrationPath);

            const cutoverDate = (await sql<{ cutover_date: string }[]>`
                SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Bangkok')::date::text AS cutover_date
            `)[0]!.cutover_date;
            const checkpoints = await sql<{
                loan_id: number;
                due_date: string;
                penalty_date: string;
                amount: string;
                opening_interest_basis: string;
                reason: string;
            }[]>`
                SELECT loan_id, due_date::text, penalty_date::text, amount::text,
                    opening_interest_basis::text, reason
                FROM floating_penalty_ledger_entries
                WHERE tenant_id = 'tenant-a' AND entry_type = 'legacy_cutover'
                ORDER BY loan_id
            `;
            expect(checkpoints).toHaveLength(5);
            expect(checkpoints.map((checkpoint) => checkpoint.loan_id)).toEqual(
                [mainLoanId, fifoLoanId, zeroLoanId, weeklyDeductLoanId, emptyLoanId].sort((a, b) => a - b),
            );
            for (const checkpoint of checkpoints) {
                expect(checkpoint.due_date).toBe(cutoverDate);
                expect(checkpoint.penalty_date).toBe(cutoverDate);
                expect(checkpoint.amount).toBe("0");
                expect(checkpoint.opening_interest_basis).toBe("0");
                expect(checkpoint.reason.trim().length).toBeGreaterThan(0);
            }

            const mainSnapshot = await sql<{
                due_date: string;
                penalty_date: string;
                amount: string;
                opening_interest_basis: string;
                reason: string;
            }[]>`
                SELECT due_date::text, penalty_date::text, amount::text,
                    opening_interest_basis::text, reason
                FROM floating_penalty_ledger_entries
                WHERE tenant_id = 'tenant-a' AND loan_id = ${mainLoanId}
                    AND entry_type = 'legacy_snapshot'
            `;
            expect([...mainSnapshot]).toEqual([{
                due_date: (await sql<{ value: string }[]>`SELECT (${cutoverDate}::date - 30)::text AS value`)[0]!.value,
                penalty_date: cutoverDate,
                amount: "27.00",
                opening_interest_basis: "90",
                reason: "Migrated exact legacy floating penalty state at the Bangkok cutover",
            }]);

            const zeroSnapshots = await sql<{
                loan_id: number;
                amount: string;
                opening_interest_basis: string;
            }[]>`
                SELECT loan_id, amount::text, opening_interest_basis::text
                FROM floating_penalty_ledger_entries
                WHERE tenant_id = 'tenant-a' AND entry_type = 'legacy_snapshot'
                    AND loan_id IN (${zeroLoanId}, ${weeklyDeductLoanId})
                ORDER BY loan_id
            `;
            expect([...zeroSnapshots]).toEqual([
                { loan_id: zeroLoanId, amount: "0", opening_interest_basis: "40" },
                { loan_id: weeklyDeductLoanId, amount: "0", opening_interest_basis: "0" },
            ].sort((left, right) => left.loan_id - right.loan_id));
            expect((await sql`
                SELECT 1 FROM floating_penalty_ledger_entries
                WHERE tenant_id = 'tenant-a' AND loan_id = ${emptyLoanId}
                    AND entry_type = 'legacy_snapshot'
            `).count).toBe(0);

            const migratedComponentTotals = await sql<{ component: string; amount: string }[]>`
                SELECT component, SUM(amount)::text AS amount
                FROM floating_transaction_allocations
                WHERE tenant_id = 'tenant-a' AND loan_id = ${mainLoanId}
                GROUP BY component ORDER BY component
            `;
            expect([...migratedComponentTotals]).toEqual([
                { component: "interest", amount: "60" },
                { component: "penalty", amount: "8" },
            ]);
            const fifoAllocations = await sql<{
                transaction_id: number;
                due_date: string;
                effective_date: string;
                amount: string;
            }[]>`
                SELECT transaction_id, due_date::text, effective_date::text, amount::text
                FROM floating_transaction_allocations
                WHERE tenant_id = 'tenant-a' AND loan_id = ${fifoLoanId}
                ORDER BY transaction_id
            `;
            expect([...fifoAllocations]).toEqual([
                {
                    transaction_id: fifoTransactions[0]!.id,
                    due_date: (await sql<{ value: string }[]>`SELECT (${cutoverDate}::date - 11)::text AS value`)[0]!.value,
                    effective_date: (await sql<{ value: string }[]>`SELECT (${cutoverDate}::date + 2)::text AS value`)[0]!.value,
                    amount: "10",
                },
                {
                    transaction_id: fifoTransactions[1]!.id,
                    due_date: (await sql<{ value: string }[]>`SELECT (${cutoverDate}::date - 12)::text AS value`)[0]!.value,
                    effective_date: (await sql<{ value: string }[]>`SELECT (${cutoverDate}::date + 1)::text AS value`)[0]!.value,
                    amount: "5",
                },
            ]);
            expect((await sql`
                SELECT 1 FROM audit_logs
                WHERE tenant_id = 'tenant-a' AND action = 'floating_penalty_ledger_migrated'
            `).count).toBe(5);

            const mainAudit = (await sql<{ public_id: string }[]>`
                SELECT public_id FROM audit_logs
                WHERE tenant_id = 'tenant-a'
                    AND correlation_id = ${`floating-penalty-ledger-migration-0030:${(await sql<{ public_id: string }[]>`SELECT public_id FROM loans WHERE id = ${mainLoanId}`)[0]!.public_id}`}
            `)[0]!.public_id;
            const fifoAudit = (await sql<{ public_id: string }[]>`
                SELECT public_id FROM audit_logs
                WHERE tenant_id = 'tenant-a'
                    AND correlation_id = ${`floating-penalty-ledger-migration-0030:${(await sql<{ public_id: string }[]>`SELECT public_id FROM loans WHERE id = ${fifoLoanId}`)[0]!.public_id}`}
            `)[0]!.public_id;

            const baseAssessment = (await sql<{ id: number }[]>`
                INSERT INTO floating_penalty_ledger_entries (
                    tenant_id, loan_id, due_date, penalty_date, entry_type, amount,
                    opening_interest_basis, late_fee_mode, late_fee_value, grace_period_days,
                    adjusts_entry_id, source_transaction_id, reason, idempotency_key,
                    audit_public_id, actor_source, request_id, correlation_id
                ) VALUES (
                    'tenant-a', ${mainLoanId}, ${cutoverDate}::date + 20, ${cutoverDate}::date + 21,
                    'fixed_assessment', 10, 90, 'fixed', 10, 0,
                    NULL, NULL, NULL, 'fixed-once-1', ${mainAudit}, 'system', 'test', 'test-fixed'
                ) RETURNING id
            `)[0]!;
            expect(await postgresError(sql`
                INSERT INTO floating_penalty_ledger_entries (
                    tenant_id, loan_id, due_date, penalty_date, entry_type, amount,
                    opening_interest_basis, late_fee_mode, late_fee_value, grace_period_days,
                    reason, idempotency_key, audit_public_id, actor_source, request_id, correlation_id
                ) VALUES (
                    'tenant-a', ${mainLoanId}, ${cutoverDate}::date + 20, ${cutoverDate}::date + 22,
                    'fixed_assessment', 10, 90, 'fixed', 10, 0,
                    NULL, 'fixed-once-2', ${mainAudit}, 'system', 'test', 'test-fixed-duplicate'
                )
            `)).toMatchObject({ code: "23505" });
            expect(await postgresError(sql`
                INSERT INTO floating_penalty_ledger_entries (
                    tenant_id, loan_id, due_date, penalty_date, entry_type, amount,
                    opening_interest_basis, late_fee_mode, late_fee_value, grace_period_days,
                    reason, idempotency_key, audit_public_id, actor_source, request_id, correlation_id
                ) VALUES (
                    'tenant-a', ${mainLoanId}, ${cutoverDate}::date - 30, ${cutoverDate}::date + 1,
                    'legacy_snapshot', 27, 90, 'daily_percent', 1, 0,
                    'duplicate', 'legacy-snapshot-duplicate', ${mainAudit}, 'system', 'test', 'test-snapshot-duplicate'
                )
            `)).toMatchObject({ code: "23505" });
            expect(await postgresError(sql`
                INSERT INTO floating_penalty_ledger_entries (
                    tenant_id, loan_id, due_date, penalty_date, entry_type, amount,
                    opening_interest_basis, late_fee_mode, late_fee_value, grace_period_days,
                    reason, idempotency_key, audit_public_id, actor_source, request_id, correlation_id
                ) VALUES (
                    'tenant-a', ${mainLoanId}, ${cutoverDate}::date + 1, ${cutoverDate}::date + 1,
                    'legacy_cutover', 0, 0, 'none', 0, 0,
                    'duplicate', 'legacy-cutover-duplicate', ${mainAudit}, 'system', 'test', 'test-cutover-duplicate'
                )
            `)).toMatchObject({ code: "23505" });
            expect(await postgresError(sql`
                INSERT INTO floating_penalty_ledger_entries (
                    tenant_id, loan_id, due_date, penalty_date, entry_type, amount,
                    opening_interest_basis, late_fee_mode, late_fee_value, grace_period_days,
                    reason, idempotency_key, audit_public_id, actor_source, request_id, correlation_id
                ) VALUES (
                    'tenant-a', ${emptyLoanId}, ${cutoverDate}::date + 10, ${cutoverDate}::date,
                    'legacy_snapshot', 0, 0, 'none', 0, 0,
                    NULL, 'missing-legacy-reason', ${mainAudit}, 'system', 'test', 'test-missing-reason'
                )
            `)).toMatchObject({ code: "23514" });

            expect(await postgresError(sql`
                INSERT INTO floating_penalty_ledger_entries (
                    tenant_id, loan_id, due_date, penalty_date, entry_type, amount,
                    opening_interest_basis, late_fee_mode, late_fee_value, grace_period_days,
                    adjusts_entry_id, reason, idempotency_key, audit_public_id,
                    actor_source, request_id, correlation_id
                ) VALUES (
                    'tenant-a', ${fifoLoanId}, ${cutoverDate}::date + 20, ${cutoverDate}::date + 21,
                    'adjustment', -1, 90, 'fixed', 10, 0,
                    ${baseAssessment.id}, 'cross-loan', 'cross-loan-adjustment', ${fifoAudit},
                    'system', 'test', 'test-cross-loan-adjustment'
                )
            `)).toMatchObject({ code: "23503" });
            expect(String(await postgresError(sql`
                INSERT INTO floating_penalty_ledger_entries (
                    tenant_id, loan_id, due_date, penalty_date, entry_type, amount,
                    opening_interest_basis, late_fee_mode, late_fee_value, grace_period_days,
                    adjusts_entry_id, reason, idempotency_key, audit_public_id,
                    actor_source, request_id, correlation_id
                ) VALUES (
                    'tenant-a', ${mainLoanId}, ${cutoverDate}::date + 20, ${cutoverDate}::date + 22,
                    'adjustment', -1, 90, 'fixed', 10, 0,
                    ${baseAssessment.id}, 'wrong date', 'wrong-date-adjustment', ${mainAudit},
                    'system', 'test', 'test-wrong-date-adjustment'
                )
            `))).toMatch(/same assessment coordinates/);
            expect(await postgresError(sql`
                INSERT INTO floating_penalty_ledger_entries (
                    tenant_id, loan_id, due_date, penalty_date, entry_type, amount,
                    opening_interest_basis, late_fee_mode, late_fee_value, grace_period_days,
                    adjusts_entry_id, reason, idempotency_key, audit_public_id,
                    actor_source, request_id, correlation_id
                ) VALUES (
                    'tenant-a', ${mainLoanId}, ${cutoverDate}::date + 20, ${cutoverDate}::date + 21,
                    'adjustment', -1, 90, 'fixed', 10, 0,
                    ${baseAssessment.id}, NULL, 'missing-adjustment-reason', ${mainAudit},
                    'system', 'test', 'test-missing-adjustment-reason'
                )
            `)).toMatchObject({ code: "23514" });

            const crossLoanTransactionId = fifoTransactions[0]!.id;
            expect(await postgresError(sql`
                INSERT INTO floating_transaction_allocations (
                    tenant_id, loan_id, transaction_id, due_date, component,
                    interest_accrual_id, effective_date, allocation_order, entry_type,
                    amount, reversed_allocation_id, reason, idempotency_key,
                    audit_public_id, actor_source, request_id, correlation_id
                ) VALUES (
                    'tenant-a', ${mainLoanId}, ${crossLoanTransactionId}, ${cutoverDate}::date,
                    'penalty', NULL, ${cutoverDate}::date, 99, 'payment', 1, NULL, NULL,
                    'cross-loan-allocation', ${mainAudit}, 'system', 'test', 'test-cross-loan-allocation'
                )
            `)).toMatchObject({ code: "23503" });
            const newPayment = (await sql<{ id: number }[]>`
                INSERT INTO transactions (
                    tenant_id, loan_id, amount, principal_component, interest_component,
                    fee_component, penalty_component, transaction_date, entry_type, posted_at
                ) VALUES (
                    'tenant-a', ${mainLoanId}, 2, 0, 2, 0, 0,
                    CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'repayment', CURRENT_TIMESTAMP AT TIME ZONE 'UTC'
                ) RETURNING id
            `)[0]!;
            expect(await postgresError(sql`
                INSERT INTO floating_transaction_allocations (
                    tenant_id, loan_id, transaction_id, due_date, component,
                    interest_accrual_id, effective_date, allocation_order, entry_type,
                    amount, reversed_allocation_id, reason, idempotency_key,
                    audit_public_id, actor_source, request_id, correlation_id
                ) VALUES (
                    'tenant-a', ${mainLoanId}, ${newPayment.id}, ${cutoverDate}::date - 12,
                    'interest', (SELECT id FROM loan_interest_accruals WHERE loan_id = ${fifoLoanId} ORDER BY id LIMIT 1),
                    ${cutoverDate}::date, 1, 'payment', 2, NULL, NULL,
                    'cross-loan-interest-target', ${mainAudit}, 'system', 'test', 'test-cross-interest-target'
                )
            `)).toMatchObject({ code: "23503" });

            expect(String(await postgresError(sql`
                UPDATE loan_interest_accruals
                SET paid_amount = paid_amount + 1
                WHERE id = ${mainAccruals[0]!.id}
            `))).toMatch(/paid_amount cache does not match floating interest allocations/);
            expect(await postgresError(sql.begin(async (transaction) => {
                await transaction`
                    INSERT INTO floating_transaction_allocations (
                        tenant_id, loan_id, transaction_id, due_date, component,
                        interest_accrual_id, effective_date, allocation_order, entry_type,
                        amount, reversed_allocation_id, reason, idempotency_key,
                        audit_public_id, actor_source, request_id, correlation_id
                    ) VALUES (
                        'tenant-a', ${mainLoanId}, ${newPayment.id}, ${cutoverDate}::date - 30,
                        'interest', ${mainAccruals[0]!.id}, ${cutoverDate}::date, 1,
                        'payment', 2, NULL, NULL, 'valid-new-interest-allocation',
                        ${mainAudit}, 'system', 'test', 'test-valid-new-interest'
                    )
                `;
                await transaction`
                    UPDATE loan_interest_accruals SET paid_amount = paid_amount + 2
                    WHERE id = ${mainAccruals[0]!.id}
                `;
            }))).toBeUndefined();

            const migratedAllocation = (await sql<{
                id: number;
                transaction_id: number;
                due_date: string;
                component: string;
                interest_accrual_id: number;
                effective_date: string;
                amount: string;
            }[]>`
                SELECT id, transaction_id, due_date::text, component, interest_accrual_id,
                    effective_date::text, amount::text
                FROM floating_transaction_allocations
                WHERE tenant_id = 'tenant-a' AND transaction_id = ${mainTransactions[0]!.id}
                    AND component = 'interest'
                ORDER BY allocation_order LIMIT 1
            `)[0]!;
            const reversalTransaction = (await sql<{ id: number }[]>`
                INSERT INTO transactions (
                    tenant_id, loan_id, amount, principal_component, interest_component,
                    fee_component, penalty_component, transaction_date, entry_type,
                    reversed_transaction_id, posted_at
                ) VALUES (
                    'tenant-a', ${mainLoanId}, -60, -25, -30, 0, -5,
                    CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'reversal', ${mainTransactions[0]!.id},
                    CURRENT_TIMESTAMP AT TIME ZONE 'UTC'
                ) RETURNING id
            `)[0]!;
            expect(await postgresError(sql`
                INSERT INTO floating_transaction_allocations (
                    tenant_id, loan_id, transaction_id, due_date, component,
                    interest_accrual_id, effective_date, allocation_order, entry_type,
                    amount, reversed_allocation_id, reason, idempotency_key,
                    audit_public_id, actor_source, request_id, correlation_id
                ) VALUES (
                    'tenant-a', ${mainLoanId}, ${reversalTransaction.id}, ${migratedAllocation.due_date},
                    ${migratedAllocation.component}, ${migratedAllocation.interest_accrual_id}, ${cutoverDate},
                    1, 'reversal', ${`-${migratedAllocation.amount}`}, ${migratedAllocation.id}, NULL,
                    'missing-reversal-reason', ${mainAudit}, 'system', 'test', 'test-missing-reversal-reason'
                )
            `)).toMatchObject({ code: "23514" });
            expect(String(await postgresError(sql`
                INSERT INTO floating_transaction_allocations (
                    tenant_id, loan_id, transaction_id, due_date, component,
                    interest_accrual_id, effective_date, allocation_order, entry_type,
                    amount, reversed_allocation_id, reason, idempotency_key,
                    audit_public_id, actor_source, request_id, correlation_id
                ) VALUES (
                    'tenant-a', ${mainLoanId}, ${reversalTransaction.id}, ${migratedAllocation.due_date},
                    ${migratedAllocation.component}, ${migratedAllocation.interest_accrual_id}, ${cutoverDate},
                    1, 'reversal', -1, ${migratedAllocation.id}, 'wrong amount',
                    'wrong-reversal-amount', ${mainAudit}, 'system', 'test', 'test-wrong-reversal-amount'
                )
            `))).toMatch(/exact negative/);
            expect(await postgresError(sql.begin(async (transaction) => {
                await transaction`
                    INSERT INTO floating_transaction_allocations (
                        tenant_id, loan_id, transaction_id, due_date, component,
                        interest_accrual_id, effective_date, allocation_order, entry_type,
                        amount, reversed_allocation_id, reason, idempotency_key,
                        audit_public_id, actor_source, request_id, correlation_id
                    ) VALUES (
                        'tenant-a', ${mainLoanId}, ${reversalTransaction.id}, ${migratedAllocation.due_date},
                        ${migratedAllocation.component}, ${migratedAllocation.interest_accrual_id}, ${cutoverDate},
                        1, 'reversal', ${`-${migratedAllocation.amount}`}, ${migratedAllocation.id}, 'operator correction',
                        'valid-reversal-allocation', ${mainAudit}, 'system', 'test', 'test-valid-reversal'
                    )
                `;
                await transaction`
                    UPDATE loan_interest_accruals SET paid_amount = paid_amount - ${migratedAllocation.amount}
                    WHERE id = ${migratedAllocation.interest_accrual_id}
                `;
            }))).toBeUndefined();

            expect(String(await postgresError(sql`
                UPDATE transactions SET amount = amount + 1 WHERE id = ${mainTransactions[1]!.id}
            `))).toMatch(/referenced transaction financial history is immutable/);
            expect(String(await postgresError(sql`
                DELETE FROM transactions WHERE id = ${mainTransactions[1]!.id}
            `))).toMatch(/referenced transaction financial history is immutable/);
            expect((await sql`
                UPDATE transactions SET notes = 'non-financial annotation'
                WHERE id = ${mainTransactions[1]!.id}
            `).count).toBe(1);

            const weeklyAccrualId = (await sql<{ id: number }[]>`
                SELECT id FROM loan_interest_accruals WHERE loan_id = ${weeklyDeductLoanId}
            `)[0]!.id;
            await sql`UPDATE loan_interest_accruals SET status = 'reversed' WHERE id = ${weeklyAccrualId}`;
            expect(await postgresError(sql`
                INSERT INTO loan_interest_accruals (
                    tenant_id, loan_id, accrual_date, opening_principal, rate_mode, rate,
                    interest_amount, paid_amount, accrued_penalty, paid_penalty, status
                ) VALUES (
                    'tenant-a', ${weeklyDeductLoanId},
                    (SELECT interest_start_date FROM loans WHERE id = ${weeklyDeductLoanId}),
                    4000, 'percent', 1, 10, 10, 0, 0, 'paid'
                )
            `)).toBeUndefined();
        } finally {
            await sql.end({ timeout: 5 });
        }
    });
}
