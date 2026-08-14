import { beforeEach, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { Elysia } from "elysia";
import { db } from "../db";
import {
    auditLogs,
    borrowers,
    loanInterestAccruals,
    loanInterestRatePeriods,
    loans,
    transactions,
    users,
} from "../db/schema";
import { loansRoute } from "./loans";
import { loanSettlementRoutes } from "./loan-settlement-routes";

const integrationEnabled = Boolean(process.env.TEST_DATABASE_URL);
const integrationTest = integrationEnabled ? test : test.skip;

async function resetApplicationTables() {
    await db.execute(sql`SET client_min_messages TO WARNING`);
    await db.execute(sql`TRUNCATE TABLE
        audit_logs, fund_ledger_entries, payment_match_allocations,
        payment_match_proposals, payment_evidence, transactions,
        payment_intakes, loan_settlement_previews, loan_disbursements,
        loan_interest_accruals, loan_interest_rate_periods,
        loan_funding_allocations, loan_schedules, loans,
        borrower_aliases, borrowers, bank_profiles, users
        RESTART IDENTITY CASCADE`);
}

async function seedRouteLoan() {
    const tenantId = "tenant-settlement-route";
    const actor = await db.insert(users).values({
        tenantId,
        email: `${crypto.randomUUID()}@example.test`,
        role: "owner",
    }).returning().then((rows) => rows[0]!);
    const borrower = await db.insert(borrowers).values({
        tenantId,
        ownerUserId: actor.id,
        name: "Settlement route borrower",
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
        interestPeriodUnit: "week",
        interestPeriodLength: 1,
        advanceInterestPeriods: 0,
        advanceInterestRefundPolicy: "non_refundable",
        interestPeriodAnchorDate: "2026-08-13",
        outstandingPrincipal: "5000.00",
        outstandingInterest: "0.00",
        outstandingFees: "0.00",
        status: "active",
    }).returning().then((rows) => rows[0]!);
    await db.insert(loanInterestRatePeriods).values({
        tenantId,
        loanId: loan.id,
        effectiveDate: "2026-08-13",
        rateType: "percent",
        rate: "12.0000",
        periodUnit: "week",
        periodLength: 1,
        createdByUserId: actor.id,
    });
    return { actor, loan };
}

async function authToken(user: { id: number; email: string; role: string | null; tenantId: string }) {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const header = encode({ alg: "HS256", typ: "JWT" });
    const payload = encode({ id: user.id, email: user.email, role: user.role, tenantId: user.tenantId });
    const unsigned = `${header}.${payload}`;
    const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(process.env.JWT_SECRET ?? "dev_jwt_secret_change_me"),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
    );
    const signature = Buffer.from(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(unsigned))).toString("base64url");
    return `${unsigned}.${signature}`;
}

async function jsonRequest(
    app: { handle(request: Request): Response | Promise<Response> },
    path: string,
    token: string,
    init: RequestInit = {},
) {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${token}`);
    if (init.body) headers.set("content-type", "application/json");
    const response = await app.handle(new Request(`http://localhost${path}`, { ...init, headers }));
    const text = await response.text();
    return { response, body: text ? JSON.parse(text) : null, text };
}

describe("loan settlement REST adapter", () => {
    if (integrationEnabled) beforeEach(resetApplicationTables);

    // Break caught: HTTP drops exact DTOs, confirmation, idempotency, or command audit identifiers.
    integrationTest("previews and executes exact settlement through authenticated closed schemas", async () => {
        const seeded = await seedRouteLoan();
        const token = await authToken(seeded.actor);
        const app = new Elysia().use(loanSettlementRoutes);

        const preview = await jsonRequest(app, "/loan-settlements/preview", token, {
            method: "POST",
            body: JSON.stringify({ loanPublicId: seeded.loan.publicId, asOfDate: "2026-08-15" }),
        });
        expect(preview.response.status, preview.text).toBe(200);
        expect(preview.body).toMatchObject({
            id: preview.body.publicId,
            loanPublicId: seeded.loan.publicId,
            outstandingPrincipal: "5000.00",
            accruedNotDueInterest: "257.14",
            settlementTotal: "5257.14",
        });
        expect(preview.body).not.toHaveProperty("loanId");

        const missingConfirmation = await jsonRequest(
            app,
            `/loan-settlements/${preview.body.publicId}/execute`,
            token,
            {
                method: "POST",
                headers: { "idempotency-key": "route-settlement-missing-confirmation" },
                body: JSON.stringify({
                    previewHash: preview.body.previewHash,
                    confirmed: false,
                    reason: "Must confirm explicitly",
                }),
            },
        );
        expect(missingConfirmation.response.status).toBe(400);
        expect(missingConfirmation.body).toMatchObject({ code: "SETTLEMENT_CONFIRMATION_REQUIRED" });

        const executed = await jsonRequest(
            app,
            `/loan-settlements/${preview.body.publicId}/execute`,
            token,
            {
                method: "POST",
                headers: {
                    "idempotency-key": "route-settlement-execute",
                    "x-request-id": "route-settlement-request",
                    "x-correlation-id": "route-settlement-correlation",
                },
                body: JSON.stringify({
                    previewHash: preview.body.previewHash,
                    confirmed: true,
                    reason: "REST exact close-out",
                }),
            },
        );
        expect(executed.response.status, executed.text).toBe(200);
        expect(executed.body).toMatchObject({
            status: "executed",
            settlementTotal: "5257.14",
            correlationId: "route-settlement-correlation",
            transaction: {
                amount: "5257.14",
                principalComponent: "5000.00",
                interestComponent: "257.14",
            },
        });
        expect(await db.select().from(transactions).where(eq(transactions.loanId, seeded.loan.id))).toHaveLength(1);
        expect(await db.select().from(auditLogs).where(and(
            eq(auditLogs.entityId, preview.body.publicId),
            eq(auditLogs.action, "executed"),
        ))).toEqual([expect.objectContaining({
            requestId: "route-settlement-request",
            correlationId: "route-settlement-correlation",
        })]);
    });

    // Break caught: listing a paid floating loan tries to materialize more interest and fails the entire read.
    integrationTest("lists a settled floating loan with settled payment health without new financial records", async () => {
        const seeded = await seedRouteLoan();
        const token = await authToken(seeded.actor);
        const app = new Elysia().use(loanSettlementRoutes).use(loansRoute);
        const preview = await jsonRequest(app, "/loan-settlements/preview", token, {
            method: "POST",
            body: JSON.stringify({ loanPublicId: seeded.loan.publicId, asOfDate: "2026-08-15" }),
        });
        const executed = await jsonRequest(
            app,
            `/loan-settlements/${preview.body.publicId}/execute`,
            token,
            {
                method: "POST",
                headers: { "idempotency-key": "route-settlement-list-health" },
                body: JSON.stringify({
                    previewHash: preview.body.previewHash,
                    confirmed: true,
                    reason: "Verify settled loan health reads",
                }),
            },
        );
        expect(executed.response.status, executed.text).toBe(200);
        const accrualsBefore = await db.select().from(loanInterestAccruals)
            .where(eq(loanInterestAccruals.loanId, seeded.loan.id))
            .orderBy(loanInterestAccruals.id);
        const transactionsBefore = await db.select().from(transactions)
            .where(eq(transactions.loanId, seeded.loan.id))
            .orderBy(transactions.id);

        const listedResponse = await app.handle(new Request("http://localhost/loans", {
            headers: { authorization: `Bearer ${token}` },
        }));

        expect(listedResponse.status).toBe(200);
        expect(await listedResponse.json()).toEqual([
            expect.objectContaining({
                publicId: seeded.loan.publicId,
                status: "paid",
                paymentHealth: {
                    status: "settled",
                    dueTodayAmount: "0.00",
                    overdueAmount: "0.00",
                    accruingInterestAmount: "171.43",
                    overdueItemCount: 0,
                    maxOverdueDays: 0,
                },
            }),
        ]);
        expect(await db.select().from(loanInterestAccruals)
            .where(eq(loanInterestAccruals.loanId, seeded.loan.id))
            .orderBy(loanInterestAccruals.id)).toEqual(accrualsBefore);
        expect(await db.select().from(transactions)
            .where(eq(transactions.loanId, seeded.loan.id))
            .orderBy(transactions.id)).toEqual(transactionsBefore);
    });

    // Break caught: extra or malformed fields reach a destructive settlement command despite a closed public contract.
    integrationTest("rejects extra preview and execute fields at the REST boundary", async () => {
        const seeded = await seedRouteLoan();
        const token = await authToken(seeded.actor);
        const app = new Elysia().use(loanSettlementRoutes);

        const extraPreview = await jsonRequest(app, "/loan-settlements/preview", token, {
            method: "POST",
            body: JSON.stringify({
                loanPublicId: seeded.loan.publicId,
                asOfDate: "2026-08-15",
                outstandingPrincipal: "0.00",
            }),
        });
        expect(extraPreview.response.status).toBe(422);

        const preview = await jsonRequest(app, "/loan-settlements/preview", token, {
            method: "POST",
            body: JSON.stringify({ loanPublicId: seeded.loan.publicId, asOfDate: "2026-08-15" }),
        });
        const extraExecute = await jsonRequest(
            app,
            `/loan-settlements/${preview.body.publicId}/execute`,
            token,
            {
                method: "POST",
                headers: { "idempotency-key": "route-settlement-extra-field" },
                body: JSON.stringify({
                    previewHash: preview.body.previewHash,
                    confirmed: true,
                    reason: "Closed schema check",
                    settlementTotal: "0.00",
                }),
            },
        );
        expect(extraExecute.response.status).toBe(422);
        expect(await db.select().from(transactions).where(eq(transactions.loanId, seeded.loan.id))).toHaveLength(0);
    });
});
