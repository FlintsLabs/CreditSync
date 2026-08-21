import { afterAll, expect, test } from "bun:test";
import Decimal from "decimal.js";
import postgres from "postgres";
import { Elysia } from "elysia";
import { and, eq, sql } from "drizzle-orm";
import { drizzle as drizzleClient } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db } from "../db";
import { auditLogs, loanDisbursementEvents, loanSchedules, loans, users } from "../db/schema";
import { loansRoute } from "./loans";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integrationTest = databaseUrl ? test : test.skip;
const backendRoot = `${import.meta.dir}/../../`;
const migrationJournalPath = `${backendRoot}drizzle/meta/_journal.json`;
const migration0038 = `${backendRoot}drizzle/0038_production_loan_schema_reconciliation.sql`;
const migration0032 = `${backendRoot}drizzle/0032_restructure_external_credit_allocation.sql`;
const migration0039 = `${backendRoot}drizzle/0039_loan_agents_commission_attribution.sql`;
const migration0042 = `${backendRoot}drizzle/0042_atomic_loan_replacement.sql`;
const migration0044 = `${backendRoot}drizzle/0044_atomic_loan_replacement_hardening.sql`;
const migration0045 = `${backendRoot}drizzle/0045_atomic_loan_replacement_proposal.sql`;
const migration0046 = `${backendRoot}drizzle/0046_payment_start_date.sql`;
const tenantId = "tenant-task-3-regression";
const productionLoanColumns = [
    "interest_period_unit", "interest_period_length", "advance_interest_periods", "advance_interest_refund_policy",
    "interest_period_anchor_date", "single_payment_due_date", "single_payment_fixed_agreed_interest",
    "single_payment_interest_policy", "single_payment_retroactive_rate_type", "single_payment_retroactive_rate",
    "single_payment_late_penalty_mode", "single_payment_late_penalty_amount_per_day", "single_payment_late_penalty_grace_days",
    "floating_accrual_cycle", "activation_idempotency_key", "activation_result",
] as const;
const productionLoanConstraints = [
    "loans_single_payment_terms_check",
    "loans_floating_accrual_cycle_check", "loans_single_payment_money_check", "loans_interest_period_unit_check",
    "loans_interest_period_length_check", "loans_advance_interest_periods_check", "loans_advance_interest_refund_policy_check",
    "loans_interest_period_policy_completeness_check", "loans_activation_command_completeness_check",
] as const;
const preservedProductionLoanConstraints = ["loans_term_months_check", "loans_one_funding_source_check"] as const;
const canonicalProductionLoanConstraints = [...productionLoanConstraints, ...preservedProductionLoanConstraints] as const;

afterAll(async () => {
    if (!databaseUrl) return;
    const client = postgres(databaseUrl, { max: 1 });
    try {
        await client.unsafe("DROP SCHEMA public CASCADE");
        await client.unsafe("DROP SCHEMA IF EXISTS drizzle CASCADE");
        await client.unsafe("CREATE SCHEMA public");
        await migrate(drizzleClient(client), { migrationsFolder: `${backendRoot}drizzle` });
    } finally {
        await client.end();
    }
});

const loanTermProjection = (row: typeof loans.$inferSelect) => ({
    principalAmount: row.principalAmount, interestRate: row.interestRate, repaymentType: row.repaymentType,
    dailyInterestMode: row.dailyInterestMode, dailyInterestRate: row.dailyInterestRate, firstDayTreatment: row.firstDayTreatment,
    interestStartDate: row.interestStartDate, interestPeriodUnit: row.interestPeriodUnit, interestPeriodLength: row.interestPeriodLength,
    advanceInterestPeriods: row.advanceInterestPeriods, advanceInterestRefundPolicy: row.advanceInterestRefundPolicy,
    interestPeriodAnchorDate: row.interestPeriodAnchorDate, dailyTermUnit: row.dailyTermUnit, dailyTermValue: row.dailyTermValue,
    dailyEntryMode: row.dailyEntryMode, dailyInterestInputMode: row.dailyInterestInputMode,
    dailyInterestInputValue: row.dailyInterestInputValue, dailyFlatRatePercent: row.dailyFlatRatePercent,
    singlePaymentDueDate: row.singlePaymentDueDate, singlePaymentFixedAgreedInterest: row.singlePaymentFixedAgreedInterest,
    singlePaymentInterestPolicy: row.singlePaymentInterestPolicy, singlePaymentRetroactiveRateType: row.singlePaymentRetroactiveRateType,
    singlePaymentRetroactiveRate: row.singlePaymentRetroactiveRate, singlePaymentLatePenaltyMode: row.singlePaymentLatePenaltyMode,
    singlePaymentLatePenaltyAmountPerDay: row.singlePaymentLatePenaltyAmountPerDay,
    singlePaymentLatePenaltyGraceDays: row.singlePaymentLatePenaltyGraceDays, termMonths: row.termMonths,
    installmentAmount: row.installmentAmount, totalInstallments: row.totalInstallments, startDate: row.startDate,
    nextDueDate: row.nextDueDate, gracePeriodDays: row.gracePeriodDays, lateFeeMode: row.lateFeeMode,
    lateFeeAmount: row.lateFeeAmount, outstandingPrincipal: row.outstandingPrincipal,
    outstandingInterest: row.outstandingInterest, outstandingFees: row.outstandingFees, status: row.status,
    activationIdempotencyKey: row.activationIdempotencyKey, activationResult: row.activationResult,
    createdAt: row.createdAt, updatedAt: row.updatedAt,
});

const scheduleProjection = (rows: Array<typeof loanSchedules.$inferSelect>) => rows.map((row) => ({
    installmentNo: row.installmentNo, dueDate: row.dueDate, scheduledPrincipal: row.scheduledPrincipal,
    scheduledInterest: row.scheduledInterest, scheduledFee: row.scheduledFee, scheduledTotal: row.scheduledTotal,
    paidTotal: row.paidTotal, paidPenalty: row.paidPenalty, overdueDays: row.overdueDays,
    remainingDue: row.remainingDue, status: row.status, createdAt: row.createdAt, updatedAt: row.updatedAt,
}));

async function applySqlFile(client: ReturnType<typeof postgres>, path: string) {
    const content = await Bun.file(path).text();
    for (const statement of content.split("--> statement-breakpoint")) {
        if (statement.trim()) await client.unsafe(statement);
    }
}

async function postgresError(query: PromiseLike<unknown>) {
    try {
        await query;
        return undefined;
    } catch (error) {
        return error;
    }
}

async function resetAndApplyMigrations(maxIdx?: number) {
    const client = postgres(databaseUrl!, { max: 1 });
    await client.unsafe("DROP SCHEMA public CASCADE");
    await client.unsafe("DROP SCHEMA IF EXISTS drizzle CASCADE");
    await client.unsafe("CREATE SCHEMA public");
    const journal = await Bun.file(migrationJournalPath).json() as { entries: Array<{ idx: number; tag: string }> };
    for (const entry of journal.entries.filter((candidate) => maxIdx === undefined || candidate.idx <= maxIdx)) {
        await applySqlFile(client, `${backendRoot}drizzle/${entry.tag}.sql`);
    }
    await client.unsafe("CREATE SCHEMA drizzle; CREATE TABLE drizzle.__drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint NOT NULL)");
    return client;
}

async function createCapturedProductionDrift(client: ReturnType<typeof postgres>) {
    // The authenticated detail path selects the complete loan_restructures
    // row through Drizzle, so the four external-credit columns from 0032 are
    // the only later non-0038 captured objects it needs. The caller applies
    // that migration explicitly before this drift is constructed; no other
    // 0031-0037 migration object is replayed here.
    await client.unsafe(`
        DO $$
        DECLARE name text;
        BEGIN
            FOREACH name IN ARRAY ARRAY[${productionLoanConstraints.map((name) => `'${name}'`).join(", ")}] LOOP
                IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.loans'::regclass AND conname = name) THEN
                    EXECUTE format('ALTER TABLE public.loans DROP CONSTRAINT %I', name);
                END IF;
            END LOOP;
        END $$;
        DROP INDEX IF EXISTS public.loans_tenant_activation_idempotency_unique;
        ALTER TABLE public.loans
            ${productionLoanColumns.map((name) => `DROP COLUMN IF EXISTS ${name}`).join(",\n            ")};
    `);
}

async function assertCapturedProductionDrift(client: ReturnType<typeof postgres>) {
    const catalog = await client<{ object_name: string; object_kind: string }[]>`
        SELECT attname AS object_name, 'column' AS object_kind
        FROM pg_attribute
        WHERE attrelid = 'public.loans'::regclass AND attname = ANY(${client.array([...productionLoanColumns])}) AND NOT attisdropped
        UNION ALL
        SELECT conname, 'constraint'
        FROM pg_constraint
        WHERE conrelid = 'public.loans'::regclass AND conname = ANY(${client.array([...productionLoanConstraints])})
        UNION ALL
        SELECT 'loans_tenant_activation_idempotency_unique', 'index'
        WHERE to_regclass('public.loans_tenant_activation_idempotency_unique') IS NOT NULL
        ORDER BY object_kind, object_name
    `;
    expect(Array.from(catalog)).toEqual([]);
    const preserved = await client<{ conname: string; convalidated: boolean }[]>`
        SELECT conname, convalidated
        FROM pg_constraint
        WHERE conrelid = 'public.loans'::regclass
          AND conname = ANY(${client.array([...preservedProductionLoanConstraints])})
        ORDER BY conname
    `;
    expect(Array.from(preserved)).toEqual([
        { conname: "loans_one_funding_source_check", convalidated: true },
        { conname: "loans_term_months_check", convalidated: true },
    ]);
}

async function authToken(user: { id: number; email: string; role: string | null; tenantId: string }) {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const unsigned = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ id: user.id, email: user.email, role: user.role, tenantId: user.tenantId })}`;
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(process.env.JWT_SECRET ?? "dev_jwt_secret_change_me"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return `${unsigned}.${Buffer.from(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(unsigned))).toString("base64url")}`;
}

async function jsonRequest(app: { handle(request: Request): Response | Promise<Response> }, path: string, token: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${token}`);
    if (init.body) headers.set("content-type", "application/json");
    const response = await app.handle(new Request(`http://localhost${path}`, { ...init, headers }));
    const text = await response.text();
    let body: unknown = null;
    try { body = text ? JSON.parse(text) : null; } catch { }
    return { response, body: body as any, text };
}

async function seedOwnerAndBorrower(client: ReturnType<typeof postgres>, email = "task-3-owner@example.test") {
    const owner = await client<{ id: number; email: string; role: string; tenant_id: string }[]>`
        INSERT INTO users (tenant_id, email, role) VALUES (${tenantId}, ${email}, 'owner') RETURNING id, email, role, tenant_id
    `;
    const borrower = await client<{ id: number; public_id: string }[]>`
        INSERT INTO borrowers (tenant_id, owner_user_id, name) VALUES (${tenantId}, ${owner[0]!.id}, 'Task 3 regression borrower') RETURNING id, public_id
    `;
    return { owner: owner[0]!, borrower: borrower[0]! };
}

integrationTest("repairs the actual authenticated loan detail read on the same historical row and public UUID", async () => {
    // Start from the authoritative 0030 base. Apart from the explicit 0032
    // compatibility statements below, restructure tables are already in that
    // base. The captured drift is constructed explicitly, not by replaying
    // every later migration and deleting their objects.
    const client = await resetAndApplyMigrations(30);
    try {
        await applySqlFile(client, migration0032);
        // Current authenticated detail also inspects commission participants,
        // replacement lineage, and payment_start_date; these objects are
        // independent from the 0038 drift.
        for (const compatibilityMigration of [migration0039, migration0042, migration0044, migration0045, migration0046]) {
            await applySqlFile(client, compatibilityMigration);
        }
        await createCapturedProductionDrift(client);
        await assertCapturedProductionDrift(client);
        const seeded = await seedOwnerAndBorrower(client, "task-3-detail@example.test");
        const historical = await client<{ id: number; public_id: string }[]>`
            INSERT INTO loans (tenant_id, owner_user_id, borrower_id, principal_amount, interest_rate, repayment_type,
                term_months, installment_amount, total_installments, start_date, outstanding_principal, outstanding_interest,
                outstanding_fees, status)
            VALUES (${tenantId}, ${seeded.owner.id}, ${seeded.borrower.id}, 7500.00, 0.00, 'daily', 1, 100.00, 75,
                DATE '2026-08-16', 7500.00, 0.00, 0.00, 'active')
            RETURNING id, public_id
        `;
        const historicalPublicId = historical[0]!.public_id;
        const catalogEvidence = await client<{ public_id: string; missing_columns: string[]; missing_constraints: string[]; missing_index: boolean }[]>`
            SELECT l.public_id,
                (SELECT array_agg(name ORDER BY name) FROM unnest(${client.array([...productionLoanColumns])}::text[]) AS expected(name)
                 WHERE NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = 'public.loans'::regclass AND a.attname = expected.name AND NOT a.attisdropped)) AS missing_columns,
                (SELECT array_agg(name ORDER BY name) FROM unnest(${client.array([...productionLoanConstraints])}::text[]) AS expected(name)
                 WHERE NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = 'public.loans'::regclass AND c.conname = expected.name)) AS missing_constraints,
                to_regclass('public.loans_tenant_activation_idempotency_unique') IS NULL AS missing_index
            FROM loans l WHERE l.id = ${historical[0]!.id}
        `;
        expect(Array.from(catalogEvidence)).toEqual([{
            public_id: historicalPublicId,
            missing_columns: [...productionLoanColumns].sort(),
            missing_constraints: [...productionLoanConstraints].sort(),
            missing_index: true,
        }]);
        const app = new Elysia().use(loansRoute);
        const token = await authToken({ id: seeded.owner.id, email: seeded.owner.email, role: seeded.owner.role, tenantId });

        const beforeRepair = await jsonRequest(app, `/loans/${historicalPublicId}`, token);
        expect(beforeRepair.response.status).toBe(500);
        expect(beforeRepair.response.status).not.toBe(404);

        await applySqlFile(client, migration0038);
        const canonicalConstraints = await client<{ conname: string; convalidated: boolean }[]>`
            SELECT conname, convalidated
            FROM pg_constraint
            WHERE conrelid = 'public.loans'::regclass
              AND conname = ANY(${client.array([...canonicalProductionLoanConstraints])})
            ORDER BY conname
        `;
        expect(Array.from(canonicalConstraints)).toEqual(
            [...canonicalProductionLoanConstraints].sort().map((conname) => ({ conname, convalidated: true })),
        );
        const afterRepair = await jsonRequest(app, `/loans/${historicalPublicId}`, token);
        expect(afterRepair.response.status, afterRepair.text).toBe(200);
        expect(afterRepair.body).toMatchObject({
            id: historicalPublicId,
            publicId: historicalPublicId,
            borrowerPublicId: seeded.borrower.public_id,
            principal: "7500.00",
            interestRate: "0.00",
            repaymentType: "daily",
            status: "active",
        });
        const persisted = await client<{ public_id: string; principal_amount: string; status: string }[]>`
            SELECT public_id, principal_amount, status FROM loans WHERE id = ${historical[0]!.id}
        `;
        expect(Array.from(persisted)).toEqual([{ public_id: historicalPublicId, principal_amount: "7500.00", status: "active" }]);
    } finally {
        await client.end();
    }
}, 30_000);

integrationTest("runs the approved zero-interest daily lifecycle and verifies explicit under-disbursement posting", async () => {
    const client = await resetAndApplyMigrations();
    try {
        const seeded = await seedOwnerAndBorrower(client, "task-3-lifecycle@example.test");
        const app = new Elysia().use(loansRoute);
        const token = await authToken({ id: seeded.owner.id, email: seeded.owner.email, role: seeded.owner.role, tenantId });
        const terms = {
            principal: "7500.00", interestRate: "0.00", termMonths: 1, repaymentType: "daily",
            startDate: "2026-08-16", dailyEntry: { durationUnit: "days", durationValue: 75, entryMode: "daily_payment", dailyPayment: "100.00" },
        };

        const preview = await jsonRequest(app, "/loans/preview", token, { method: "POST", body: JSON.stringify(terms) });
        expect(preview.response.status, preview.text).toBe(200);
        expect(preview.body.schedule).toHaveLength(75);
        expect(preview.body.schedule[0].dueDate).toBe("2026-08-17");
        expect(preview.body.schedule.at(-1).dueDate).toBe("2026-10-30");
        expect(preview.body.schedule.at(-1).remainingPrincipal).toBe("0.00");
        expect(preview.body.dailyLoanCalculation.totalInterest).toBe("0.00");

        const draft = await jsonRequest(app, "/loans", token, { method: "POST", headers: { "x-request-id": "task-3-draft", "x-correlation-id": "task-3-draft-correlation" }, body: JSON.stringify({ ...terms, borrowerPublicId: seeded.borrower.public_id }) });
        expect(draft.response.status, draft.text).toBe(200);
        const loanPublicId = draft.body.publicId;
        expect(draft.body).toMatchObject({ status: "draft", principal: "7500.00" });
        const loanDraftAudits = await client<{ action: string; actor_source: string; actor_user_id: number; request_id: string; correlation_id: string; payload: { before: unknown; after: unknown } }[]>`
            SELECT action, actor_source, actor_user_id, request_id, correlation_id, payload
            FROM audit_logs
            WHERE entity_type = 'loan' AND entity_id = ${loanPublicId} AND action = 'draft_created'
        `;
        expect(Array.from(loanDraftAudits)).toEqual([{
            action: "draft_created", actor_source: "web", actor_user_id: seeded.owner.id,
            request_id: "task-3-draft", correlation_id: "task-3-draft-correlation",
            payload: { before: null, after: expect.objectContaining({ publicId: loanPublicId, status: "draft", principal: "7500.00" }) },
        }]);

        const activated = await jsonRequest(app, `/loans/${loanPublicId}/activate`, token, { method: "POST", headers: { "idempotency-key": "task-3-loan-activate-20260816" } });
        expect(activated.response.status, activated.text).toBe(200);
        const replay = await jsonRequest(app, `/loans/${loanPublicId}/activate`, token, { method: "POST", headers: { "idempotency-key": "task-3-loan-activate-20260816" } });
        expect(replay.response.status, replay.text).toBe(200);
        expect(replay.body).toEqual(activated.body);

        const loan = await db.query.loans.findFirst({ where: eq(loans.publicId, loanPublicId) });
        const schedules = await db.select().from(loanSchedules).where(eq(loanSchedules.loanId, loan!.id)).orderBy(loanSchedules.installmentNo);
        expect(schedules).toHaveLength(75);
        expect(schedules[0]!.dueDate).toBe("2026-08-17");
        expect(schedules.at(-1)!.dueDate).toBe("2026-10-30");
        expect(schedules.every((row) => row.scheduledPrincipal === "100.00" && row.scheduledInterest === "0.00" && row.scheduledTotal === "100.00" && row.remainingDue === "100.00")).toBe(true);
        expect(schedules.reduce((sum, row) => sum.plus(row.scheduledPrincipal), new Decimal(0)).toFixed(2)).toBe("7500.00");
        expect(schedules.reduce((sum, row) => sum.plus(row.scheduledInterest), new Decimal(0)).toFixed(2)).toBe("0.00");
        expect(schedules.at(-1)!.remainingDue).toBe("100.00");
        expect(await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, loanPublicId), eq(auditLogs.action, "activated")))).toHaveLength(1);

        const termsBeforeDisbursement = loanTermProjection(loan!);
        const scheduleBeforeDisbursement = scheduleProjection(schedules);
        expect(scheduleBeforeDisbursement).toHaveLength(75);

        const disbursement = await jsonRequest(app, `/loans/${loanPublicId}/disbursements`, token, { method: "POST", headers: { "x-request-id": "task-3-disbursement-draft", "x-correlation-id": "task-3-disbursement-correlation" }, body: JSON.stringify({ grossAmount: "4000.00", loanAttributedAmount: "4000.00", channel: "bank_transfer", note: "Task 3 approved draft", disbursedAt: "2026-08-16T09:00:00.000Z" }) });
        expect(disbursement.response.status, disbursement.text).toBe(200);
        expect(disbursement.body).toMatchObject({ grossAmount: "4000.00", loanAttributedAmount: "4000.00", channel: "bank_transfer", status: "draft", disbursedAt: "2026-08-16T09:00:00.000Z" });
        const listed = await jsonRequest(app, `/loans/${loanPublicId}/disbursements`, token);
        expect(listed.response.status, listed.text).toBe(200);
        expect(listed.body).toMatchObject({ summary: { approvedPrincipal: "7500.00", netDisbursed: "0.00", variance: "-7500.00", status: "under_disbursed" }, events: [expect.objectContaining({ publicId: disbursement.body.publicId, grossAmount: "4000.00", loanAttributedAmount: "4000.00", status: "draft", disbursedAt: "2026-08-16T09:00:00.000Z" })] });
        const persistedDraft = await client<{ disbursed_at: Date }[]>`SELECT disbursed_at FROM loan_disbursement_events WHERE public_id = ${disbursement.body.publicId}`;
        expect(persistedDraft).toHaveLength(1);
        expect(persistedDraft[0]!.disbursed_at.toISOString()).toBe("2026-08-16T09:00:00.000Z");
        const draftAudits = await client<{ action: string; actor_source: string; actor_user_id: number; request_id: string; correlation_id: string; payload: unknown }[]>`
            SELECT action, actor_source, actor_user_id, request_id, correlation_id, payload
            FROM audit_logs
            WHERE entity_type = 'loan_disbursement' AND entity_id = ${disbursement.body.publicId} AND action = 'draft_created'
        `;
        expect(Array.from(draftAudits)).toEqual([{
            action: "draft_created", actor_source: "web", actor_user_id: seeded.owner.id,
            request_id: "task-3-disbursement-draft", correlation_id: "task-3-disbursement-correlation",
            payload: { loanPublicId, grossAmount: "4000.00", loanAttributedAmount: "4000.00" },
        }]);
        const termsAfterDisbursement = loanTermProjection((await db.query.loans.findFirst({ where: eq(loans.id, loan!.id) }))!);
        const scheduleAfterDisbursement = scheduleProjection(await db.select().from(loanSchedules).where(eq(loanSchedules.loanId, loan!.id)).orderBy(loanSchedules.installmentNo));
        expect(termsAfterDisbursement).toEqual(termsBeforeDisbursement);
        expect(scheduleAfterDisbursement).toEqual(scheduleBeforeDisbursement);

        const firstSchedule = schedules[0]!;
        expect(String(await postgresError(client`UPDATE loan_schedules SET scheduled_total = scheduled_total + 1 WHERE id = ${firstSchedule.id}`))).toMatch(/immutable/i);
        expect(String(await postgresError(client`DELETE FROM loan_schedules WHERE id = ${firstSchedule.id}`))).toMatch(/immutable/i);
        const schedulesAfterMutationAttempts = scheduleProjection(await db.select().from(loanSchedules).where(eq(loanSchedules.loanId, loan!.id)).orderBy(loanSchedules.installmentNo));
        expect(schedulesAfterMutationAttempts).toHaveLength(75);
        expect(schedulesAfterMutationAttempts).toEqual(scheduleBeforeDisbursement);
        // Posting is deliberately exercised only after the draft inspection above,
        // representing the separate human-confirmation step in production.
        const posted = await jsonRequest(app, `/loans/${loanPublicId}/disbursements/${disbursement.body.publicId}/post`, token, { method: "POST", headers: { "x-request-id": "task-3-disbursement-post", "idempotency-key": "task-3-disbursement-post-20260816" }, body: JSON.stringify({}) });
        expect(posted.response.status, posted.text).toBe(200);
        expect(posted.body).toMatchObject({ publicId: disbursement.body.publicId, status: "posted", auditPublicId: expect.any(String), correlationId: "task-3-disbursement-post" });
        const postedReplay = await jsonRequest(app, `/loans/${loanPublicId}/disbursements/${disbursement.body.publicId}/post`, token, { method: "POST", headers: { "x-request-id": "task-3-disbursement-post-replay", "idempotency-key": "task-3-disbursement-post-20260816" }, body: JSON.stringify({}) });
        expect(postedReplay.response.status, postedReplay.text).toBe(200);
        expect(postedReplay.body).toMatchObject({ publicId: disbursement.body.publicId, status: "posted", duplicate: true, auditPublicId: null });
        const postedAudits = await client<{ action: string; actor_source: string; actor_user_id: number; request_id: string; correlation_id: string; payload: unknown }[]>`
            SELECT action, actor_source, actor_user_id, request_id, correlation_id, payload
            FROM audit_logs
            WHERE entity_type = 'loan_disbursement' AND entity_id = ${disbursement.body.publicId} AND action = 'posted'
        `;
        expect(Array.from(postedAudits)).toEqual([{
            action: "posted", actor_source: "web", actor_user_id: seeded.owner.id,
            request_id: "task-3-disbursement-post", correlation_id: "task-3-disbursement-post",
            payload: { idempotencyKey: "task-3-disbursement-post-20260816", grossAmount: "4000.00", loanAttributedAmount: "4000.00" },
        }]);
        expect(await db.select().from(loanDisbursementEvents).where(and(eq(loanDisbursementEvents.loanId, loan!.id), eq(loanDisbursementEvents.status, "posted")))).toHaveLength(1);
        const postedListed = await jsonRequest(app, `/loans/${loanPublicId}/disbursements`, token);
        expect(postedListed.body).toMatchObject({ summary: { approvedPrincipal: "7500.00", netDisbursed: "4000.00", variance: "-3500.00", status: "under_disbursed" } });
        const termsAfterPost = loanTermProjection((await db.query.loans.findFirst({ where: eq(loans.id, loan!.id) }))!);
        const schedulesAfterPost = scheduleProjection(await db.select().from(loanSchedules).where(eq(loanSchedules.loanId, loan!.id)).orderBy(loanSchedules.installmentNo));
        expect(termsAfterPost).toEqual(termsBeforeDisbursement);
        expect(schedulesAfterPost).toEqual(scheduleBeforeDisbursement);
        expect(await db.select().from(loanDisbursementEvents).where(and(eq(loanDisbursementEvents.loanId, loan!.id), eq(loanDisbursementEvents.status, "reversed")))).toHaveLength(0);
        const termsAfter = await db.query.loans.findFirst({ where: eq(loans.id, loan!.id) });
        expect(termsAfter).toMatchObject({ principalAmount: "7500.00", installmentAmount: "100.00", totalInstallments: 75, outstandingPrincipal: "7500.00" });
    } finally {
        await client.end();
    }
}, 30_000);
