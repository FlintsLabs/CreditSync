import { beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { Elysia } from "elysia";
import { db } from "../db";
import { borrowers, loanDisbursementEvents, loans, users } from "../db/schema";
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

async function seedRouteLoan(tenantId = `tenant-rest-${crypto.randomUUID()}`) {
    const user = await db.insert(users).values({ tenantId, email: `${crypto.randomUUID()}@example.test`, role: "owner" }).returning().then(rows => rows[0]!);
    const borrower = await db.insert(borrowers).values({ tenantId, ownerUserId: user.id, name: "REST restructure borrower" }).returning().then(rows => rows[0]!);
    const loan = await db.insert(loans).values({
        tenantId, ownerUserId: user.id, borrowerId: borrower.id, principalAmount: "5000.00", interestRate: "10.00",
        repaymentType: "single_payment", termMonths: 1, startDate: "2026-08-01", singlePaymentDueDate: "2026-08-10",
        singlePaymentFixedAgreedInterest: "500.00", singlePaymentInterestPolicy: "fixed_only", singlePaymentLatePenaltyMode: "none",
        outstandingPrincipal: "5000.00", outstandingInterest: "500.00", outstandingFees: "0.00", status: "active",
    }).returning().then(rows => rows[0]!);
    await db.insert(loanDisbursementEvents).values({ tenantId, loanId: loan.id, grossAmount: "5000.00", loanAttributedAmount: "5000.00", channel: "bank_transfer", status: "posted", disbursedAt: new Date("2026-08-01T03:00:00Z"), postedAt: new Date("2026-08-01T03:01:00Z"), postIdempotencyKey: crypto.randomUUID(), createdByUserId: user.id });
    return { user, loan };
}

describe("loan restructure REST contract", () => {
    if (process.env.TEST_DATABASE_URL) beforeEach(async () => {
        await db.execute(sql`TRUNCATE TABLE audit_logs, loan_restructure_waivers, loan_waiver_previews, loan_opening_balance_components, loan_restructures, loan_disbursement_events, transactions, loan_schedules, loans, borrowers, users RESTART IDENTITY CASCADE`);
    });
    test("mounts the tenant-scoped restructure read and command surface", () => {
        const app = new Elysia().use(loansRoute);
        const routes = app.routes.map((route) => `${route.method} ${route.path}`);
        expect(routes).toEqual(expect.arrayContaining([
            "GET /loans/:id/restructures",
            "GET /loans/restructures/:restructureId",
            "POST /loans/:id/restructures/preview",
            "POST /loans/restructures/:restructureId/execute",
            "POST /loans/restructures/:restructureId/reverse",
        ]));
    });

    test("rejects unknown preview fields with the stable validation envelope", async () => {
        const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
        const header = encode({ alg: "HS256", typ: "JWT" });
        const payload = encode({ id: 1, email: "owner@example.test", role: "owner", tenantId: "tenant-rest-contract" });
        const unsigned = `${header}.${payload}`;
        const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(process.env.JWT_SECRET ?? "dev_jwt_secret_change_me"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
        const signature = Buffer.from(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(unsigned))).toString("base64url");
        const response = await new Elysia().use(loansRoute).handle(new Request(`http://localhost/loans/${crypto.randomUUID()}/restructures/preview`, {
            method: "POST",
            headers: { authorization: `Bearer ${unsigned}.${signature}`, "content-type": "application/json" },
            body: JSON.stringify({ unexpected: true }),
        }));
        expect(response.status).toBe(422);
        expect(await response.json()).toMatchObject({ code: "VALIDATION_ERROR" });

        const nested = await new Elysia().use(loansRoute).handle(new Request(`http://localhost/loans/${crypto.randomUUID()}/restructures/preview`, {
            method: "POST",
            headers: { authorization: `Bearer ${unsigned}.${signature}`, "content-type": "application/json" },
            body: JSON.stringify({
                settlementDate: "2026-08-15", additionalPrincipal: "0.00", reason: "closed schema proof",
                replacementTerms: { repaymentType: "single_payment", startDate: "2026-08-15", termMonths: 1, interestRate: "0.00", singlePayment: { dueDate: "2026-09-15", fixedAgreedInterest: "0.00", interestPolicy: "fixed_only", latePenalty: { mode: "none", surprise: true } } },
            }),
        }));
        expect(nested.status, await nested.clone().text()).toBe(422);
        expect(await nested.json()).toMatchObject({ code: "VALIDATION_ERROR" });
    });

    integrationTest("preserves exact DTOs, confirmation, idempotency, read models, lineage, and tenant hiding", async () => {
        const seeded = await seedRouteLoan();
        const app = new Elysia().use(loansRoute);
        const token = await tokenFor(seeded.user);
        const requestBody = {
            settlementDate: "2026-08-15", additionalPrincipal: "1000.00", reason: "customer requested installments",
            waivers: { interest: { amount: "100.00", reason: "hardship" } },
            replacementTerms: { repaymentType: "single_payment", startDate: "2026-08-15", termMonths: 1, interestRate: "4.00", singlePayment: { dueDate: "2026-09-15", fixedAgreedInterest: "240.00", interestPolicy: "fixed_only", latePenalty: { mode: "none" } } },
        };
        const preview = await call(app, `/loans/${seeded.loan.publicId}/restructures/preview`, token, { method: "POST", body: JSON.stringify(requestBody) });
        expect(preview.response.status).toBe(200);
        expect(preview.body).toMatchObject({ oldLoanPublicId: seeded.loan.publicId, replacementPrincipal: "6000.00", cash: { direction: "payout", amount: "1000.00" }, balance: { grossPrincipal: "5000.00", grossInterest: "500.00", waivedInterest: "100.00" } });

        const missingConfirmation = await call(app, `/loans/restructures/${preview.body.publicId}/execute`, token, { method: "POST", headers: { "idempotency-key": "rest-restructure-confirmation" }, body: JSON.stringify({ confirmed: false, previewHash: preview.body.previewHash, expectedBalanceVersion: preview.body.oldBalanceVersion, reason: "approved" }) });
        expect(missingConfirmation.response.status).toBe(400);
        expect(missingConfirmation.body).toMatchObject({ code: "RESTRUCTURE_CONFIRMATION_REQUIRED" });

        const executeInit = { method: "POST", headers: { "idempotency-key": "rest-restructure-execute", "x-correlation-id": "corr-rest-restructure" }, body: JSON.stringify({ confirmed: true, previewHash: preview.body.previewHash, expectedBalanceVersion: preview.body.oldBalanceVersion, reason: "approved" }) };
        const executed = await call(app, `/loans/restructures/${preview.body.publicId}/execute`, token, executeInit);
        expect(executed.response.status).toBe(200);
        expect(executed.body).toMatchObject({ status: "executed", oldLoanPublicId: seeded.loan.publicId, correlationId: "corr-rest-restructure" });
        expect(executed.body.auditPublicIds).toHaveLength(1);
        expect((await call(app, `/loans/restructures/${preview.body.publicId}/execute`, token, executeInit)).body).toEqual(executed.body);

        const list = await call(app, `/loans/${executed.body.newLoanPublicId}/restructures`, token);
        expect(list.response.status).toBe(200);
        expect(list.body[0]).toMatchObject({ publicId: preview.body.publicId, components: { net: { principal: "5000.00", interest: "400.00" }, additionalPrincipal: "1000.00" } });
        expect(list.body[0].openingComponents.every((item: Record<string, unknown>) => !Object.hasOwn(item, "loanId"))).toBe(true);

        const oldDetail = await call(app, `/loans/${seeded.loan.publicId}`, token);
        const newDetail = await call(app, `/loans/${executed.body.newLoanPublicId}`, token);
        expect(oldDetail.body.restructureLineage).toMatchObject({ restructuredToPublicId: executed.body.newLoanPublicId });
        expect(newDetail.body.restructureLineage).toMatchObject({ restructuredFromPublicId: seeded.loan.publicId });
        expect(newDetail.body.openingBalanceComponents).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "additional_principal", amount: "1000.00" })]));

        const reversed = await call(app, `/loans/restructures/${preview.body.publicId}/reverse`, token, { method: "POST", headers: { "idempotency-key": "rest-restructure-reverse", "x-correlation-id": "corr-rest-reverse" }, body: JSON.stringify({ reason: "agreement restored" }) });
        expect(reversed.response.status).toBe(200);
        expect(reversed.body).toMatchObject({ status: "reversed", correlationId: "corr-rest-reverse" });

        const outsider = await seedRouteLoan(`tenant-other-${crypto.randomUUID()}`);
        const hidden = await call(app, `/loans/restructures/${preview.body.publicId}`, await tokenFor(outsider.user));
        expect(hidden.response.status).toBe(404);
        expect(hidden.body).toMatchObject({ code: "RESTRUCTURE_NOT_FOUND" });
    });
});
