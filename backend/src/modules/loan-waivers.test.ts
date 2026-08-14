import { beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { Elysia } from "elysia";
import { db } from "../db";
import { auditLogs, borrowers, loanOpeningBalanceComponents, loanRestructures, loanSchedules, loans, transactions, users } from "../db/schema";
import { loansRoute } from "./loans";

const integrationTest = process.env.TEST_DATABASE_URL ? test : test.skip;

async function tokenFor(user: { id: number; email: string; role: string | null; tenantId: string }) {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const header = encode({ alg: "HS256", typ: "JWT" });
    const payload = encode({ id: user.id, email: user.email, role: user.role, tenantId: user.tenantId });
    const unsigned = `${header}.${payload}`;
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(process.env.JWT_SECRET ?? "dev_jwt_secret_change_me"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signature = Buffer.from(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(unsigned))).toString("base64url");
    return `${unsigned}.${signature}`;
}

async function call(app: { handle(request: Request): Response | Promise<Response> }, path: string, token: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${token}`);
    if (init.body) headers.set("content-type", "application/json");
    const response = await app.handle(new Request(`http://localhost${path}`, { ...init, headers }));
    const text = await response.text();
    return { response, body: text ? JSON.parse(text) : null };
}

async function seedReplacement() {
    const tenantId = `tenant-waiver-rest-${crypto.randomUUID()}`;
    const user = await db.insert(users).values({ tenantId, email: `${crypto.randomUUID()}@example.test`, role: "owner" }).returning().then(rows => rows[0]!);
    const borrower = await db.insert(borrowers).values({ tenantId, ownerUserId: user.id, name: "Waiver REST borrower" }).returning().then(rows => rows[0]!);
    const oldLoan = await db.insert(loans).values({ tenantId, ownerUserId: user.id, borrowerId: borrower.id, principalAmount: "5000.00", interestRate: "0.00", repaymentType: "daily", termMonths: 1, startDate: "2026-07-01", outstandingPrincipal: "5000.00", outstandingInterest: "0.00", outstandingFees: "0.00", status: "restructured" }).returning().then(rows => rows[0]!);
    const newLoan = await db.insert(loans).values({ tenantId, ownerUserId: user.id, borrowerId: borrower.id, principalAmount: "5000.00", interestRate: "5.00", repaymentType: "daily", termMonths: 1, startDate: "2026-08-01", outstandingPrincipal: "5000.00", outstandingInterest: "700.00", outstandingFees: "50.00", status: "active", clonedFromLoanId: oldLoan.id }).returning().then(rows => rows[0]!);
    const audit = await db.insert(auditLogs).values({ tenantId, entityType: "loan_restructure", entityId: oldLoan.publicId, action: "seed", actorSource: "system", correlationId: "seed" }).returning().then(rows => rows[0]!);
    const restructure = await db.insert(loanRestructures).values({ tenantId, oldLoanId: oldLoan.id, newLoanId: newLoan.id, settlementDate: "2026-08-01", oldBalanceVersion: `v1:${"a".repeat(64)}`, status: "executed", previewHash: `v1:${"b".repeat(64)}`, requestHash: "c".repeat(64), requestedReplacementTerms: {}, grossPrincipal: "5000.00", grossInterest: "500.00", grossFees: "50.00", grossPenalty: "25.00", netPrincipal: "5000.00", netInterest: "500.00", netFees: "50.00", netPenalty: "25.00", cashDirection: "none", cashAmount: "0.00", reason: "seed", createdActorSource: "system", executeActorSource: "system", correlationId: "seed", executeIdempotencyKey: crypto.randomUUID(), executeRequestHash: "d".repeat(64), executedAuditPublicId: audit.publicId, preExecutionOldLoanState: { status: "active", outstandingPrincipal: "5000.00", outstandingInterest: "500.00", outstandingFees: "50.00", nextDueDate: null }, expiresAt: new Date("2026-09-01"), executedAt: new Date("2026-08-01") }).returning().then(rows => rows[0]!);
    await db.insert(loanOpeningBalanceComponents).values([
        { tenantId, restructureId: restructure.id, loanId: newLoan.id, componentKind: "carried_principal", amount: "5000.00", sourceType: "loan", sourcePublicId: oldLoan.publicId, createdByUserId: user.id },
        { tenantId, restructureId: restructure.id, loanId: newLoan.id, componentKind: "carried_interest", amount: "500.00", sourceType: "loan_restructure", sourcePublicId: restructure.publicId, createdByUserId: user.id },
        { tenantId, restructureId: restructure.id, loanId: newLoan.id, componentKind: "carried_fee", amount: "50.00", sourceType: "loan_restructure", sourcePublicId: restructure.publicId, createdByUserId: user.id },
        { tenantId, restructureId: restructure.id, loanId: newLoan.id, componentKind: "carried_penalty", amount: "25.00", sourceType: "loan_restructure", sourcePublicId: restructure.publicId, createdByUserId: user.id },
        { tenantId, restructureId: restructure.id, loanId: newLoan.id, componentKind: "new_contract_interest", amount: "200.00", sourceType: "loan_restructure", sourcePublicId: restructure.publicId, createdByUserId: user.id },
    ]);
    await db.insert(loanSchedules).values({ tenantId, loanId: newLoan.id, installmentNo: 1, dueDate: "2026-08-31", scheduledPrincipal: "5000.00", scheduledInterest: "200.00", scheduledFee: "0.00", scheduledTotal: "5200.00", paidTotal: "0.00", paidPenalty: "0.00", remainingDue: "5200.00", status: "pending" });
    return { tenantId, user, newLoan };
}

describe("loan waiver REST contract", () => {
    if (process.env.TEST_DATABASE_URL) beforeEach(async () => {
        await db.execute(sql`TRUNCATE TABLE audit_logs, loan_restructure_waivers, loan_waiver_previews, loan_opening_balance_components, loan_restructures, transactions, loan_schedules, loans, borrowers, users RESTART IDENTITY CASCADE`);
    });
    test("mounts waiver and durable early-settlement endpoints", () => {
        const app = new Elysia().use(loansRoute);
        const routes = app.routes.map((route) => `${route.method} ${route.path}`);
        expect(routes).toEqual(expect.arrayContaining([
            "GET /loans/:id/waivers",
            "GET /loans/waivers/:id",
            "POST /loans/:id/waivers/preview",
            "POST /loans/waivers/:id/execute",
            "POST /loans/waivers/:id/reverse",
            "POST /loans/:id/early-settlement/preview",
            "POST /loans/early-settlement/:previewId/execute",
        ]));
    });

    test("keeps principal outside the public waiver schema", () => {
        const preview = loansRoute.routes.find((route) => route.method === "POST" && route.path === "/loans/:id/waivers/preview");
        expect(preview).toBeDefined();
        const schema = JSON.stringify(preview?.hooks.body);
        expect(schema).toContain("interest");
        expect(schema).toContain("penalty");
        expect(schema).not.toContain("principal");
    });

    integrationTest("executes, reads, stales, reverses and early-settles through exact public contracts", async () => {
        const seeded = await seedReplacement();
        const app = new Elysia().use(loansRoute);
        const token = await tokenFor(seeded.user);
        const preview = await call(app, `/loans/${seeded.newLoan.publicId}/waivers/preview`, token, { method: "POST", body: JSON.stringify({ component: "fee", amount: "10.00", reason: "assistance" }) });
        expect(preview.response.status).toBe(200);
        expect(preview.body).toMatchObject({ loanPublicId: seeded.newLoan.publicId, component: "fee", amount: "10.00", availableAmount: "50.00", remainingAmount: "40.00" });

        const executeInit = { method: "POST", headers: { "idempotency-key": "waiver-rest-execute", "x-correlation-id": "corr-waiver-rest" }, body: JSON.stringify({ confirmed: true, previewHash: preview.body.previewHash, expectedBalanceVersion: preview.body.balanceVersion, reason: "assistance" }) };
        const executed = await call(app, `/loans/waivers/${preview.body.publicId}/execute`, token, executeInit);
        expect(executed.response.status).toBe(200);
        expect(executed.body).toMatchObject({ status: "executed", component: "fee", amount: "10.00", correlationId: "corr-waiver-rest" });
        expect((await call(app, `/loans/waivers/${preview.body.publicId}/execute`, token, executeInit)).body).toEqual(executed.body);
        expect((await call(app, `/loans/${seeded.newLoan.publicId}/waivers`, token)).body[0]).toMatchObject({ publicId: executed.body.publicId, amount: "10.00" });
        expect((await call(app, `/loans/waivers/${executed.body.publicId}`, token)).body).not.toHaveProperty("loanId");

        const stalePreview = await call(app, `/loans/${seeded.newLoan.publicId}/waivers/preview`, token, { method: "POST", body: JSON.stringify({ component: "interest", amount: "20.00", reason: "stale proof" }) });
        await db.insert(transactions).values({ tenantId: seeded.tenantId, ownerUserId: seeded.user.id, loanId: seeded.newLoan.id, amount: "1.00", principalComponent: "0.00", interestComponent: "1.00", feeComponent: "0.00", penaltyComponent: "0.00", entryType: "repayment", idempotencyKey: crypto.randomUUID(), recordedByUserId: seeded.user.id });
        const stale = await call(app, `/loans/waivers/${stalePreview.body.publicId}/execute`, token, { method: "POST", headers: { "idempotency-key": "waiver-rest-stale" }, body: JSON.stringify({ confirmed: true, previewHash: stalePreview.body.previewHash, expectedBalanceVersion: stalePreview.body.balanceVersion, reason: "stale proof" }) });
        expect(stale.response.status).toBe(409);
        expect(stale.body).toMatchObject({ code: "STALE_WAIVER_PREVIEW" });

        const reversed = await call(app, `/loans/waivers/${executed.body.publicId}/reverse`, token, { method: "POST", headers: { "idempotency-key": "waiver-rest-reverse", "x-correlation-id": "corr-waiver-reverse" }, body: JSON.stringify({ reason: "entered in error" }) });
        expect(reversed.response.status).toBe(409);
        expect(reversed.body).toMatchObject({ code: "WAIVER_REVERSAL_BLOCKED" });

        const early = await call(app, `/loans/${seeded.newLoan.publicId}/early-settlement/preview`, token, { method: "POST", body: JSON.stringify({ settlementDate: "2026-08-10" }) });
        expect(early.response.status).toBe(200);
        expect(early.body).toMatchObject({ proposedWaiver: "200.00", reason: "early_settlement_unearned_interest" });
        const earlyExecution = await call(app, `/loans/early-settlement/${early.body.publicId}/execute`, token, { method: "POST", headers: { "idempotency-key": "early-rest-execute" }, body: JSON.stringify({ confirmed: true, previewHash: early.body.previewHash, expectedBalanceVersion: early.body.balanceVersion }) });
        expect(earlyExecution.response.status).toBe(200);
        expect(earlyExecution.body).toMatchObject({ component: "new_interest", amount: "200.00" });
    });
});
