import { beforeEach, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { sql } from "drizzle-orm";
import { db } from "../db";
import { bankProfiles, borrowers, loans, users } from "../db/schema";
import { loansRoute } from "./loans";

const integrationEnabled = Boolean(process.env.TEST_DATABASE_URL);
const integrationTest = integrationEnabled ? test : test.skip;

async function resetApplicationTables() {
    await db.execute(sql`TRUNCATE TABLE
        audit_logs, loan_disbursement_evidence, loan_disbursement_evidence_intents,
        loan_disbursement_events, loan_funding_allocations, loan_schedules, loans,
        borrowers, bank_loans, bank_profiles, files, users
        RESTART IDENTITY CASCADE`);
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
    return { response, body: text ? JSON.parse(text) : null };
}

describe("loan disbursement REST adapter", () => {
    if (integrationEnabled) beforeEach(resetApplicationTables);

    integrationTest("creates, updates, posts, lists, and reverses a public-id disbursement through the shared service", async () => {
        const actor = await db.insert(users).values({ tenantId: "tenant-disbursement-route", email: "route@example.test", role: "owner" }).returning().then((rows) => rows[0]!);
        const borrower = await db.insert(borrowers).values({ tenantId: actor.tenantId, ownerUserId: actor.id, name: "Route borrower" }).returning().then((rows) => rows[0]!);
        const loan = await db.insert(loans).values({ tenantId: actor.tenantId, ownerUserId: actor.id, borrowerId: borrower.id, principalAmount: "100.00", interestRate: "0.00", repaymentType: "floating", outstandingPrincipal: "100.00", status: "active" }).returning().then((rows) => rows[0]!);
        const sourceProfile = await db.insert(bankProfiles).values({ tenantId: actor.tenantId, name: "Route source", type: "bank" }).returning().then((rows) => rows[0]!);
        const token = await authToken(actor);
        const app = new Elysia().use(loansRoute);
        const created = await jsonRequest(app, `/loans/${loan.publicId}/disbursements`, token, {
            method: "POST", body: JSON.stringify({ grossAmount: "120.00", loanAttributedAmount: "100.00", channel: "bank_transfer", sourceBankProfilePublicId: sourceProfile.publicId, note: "Grouped transfer", payeeHint: "Borrower", disbursedAt: "2026-08-10T00:00:00.000Z" }),
        });
        expect(created.response.status).toBe(200);
        expect(created.body).toMatchObject({ id: created.body.publicId, grossAmount: "120.00", loanAttributedAmount: "100.00", sourceBankProfilePublicId: sourceProfile.publicId, status: "draft" });
        const updated = await jsonRequest(app, `/loans/${loan.publicId}/disbursements/${created.body.publicId}`, token, {
            method: "PUT", body: JSON.stringify({ payeeHint: "Updated payee" }),
        });
        expect(updated.response.status).toBe(200);
        expect(updated.body).toMatchObject({ publicId: created.body.publicId, payeeHint: "Updated payee" });
        const posted = await jsonRequest(app, `/loans/${loan.publicId}/disbursements/${created.body.publicId}/post`, token, {
            method: "POST", headers: { "idempotency-key": "route-disbursement-post" }, body: JSON.stringify({}),
        });
        expect(posted.response.status).toBe(200);
        expect(posted.body).toMatchObject({ publicId: created.body.publicId, sourceBankProfilePublicId: sourceProfile.publicId, status: "posted", auditPublicId: expect.any(String), correlationId: expect.any(String) });
        const listed = await jsonRequest(app, `/loans/${loan.publicId}/disbursements`, token);
        expect(listed.body).toMatchObject({ loanPublicId: loan.publicId, summary: { approvedPrincipal: "100.00", netDisbursed: "100.00", variance: "0.00", status: "matched" } });
        const reversed = await jsonRequest(app, `/loans/${loan.publicId}/disbursements/${created.body.publicId}/reverse`, token, {
            method: "POST", headers: { "idempotency-key": "route-disbursement-reverse" }, body: JSON.stringify({ reason: "Transfer recalled" }),
        });
        expect(reversed.response.status).toBe(200);
        expect(reversed.body).toMatchObject({ status: "reversed", reversedEventPublicId: created.body.publicId, auditPublicId: expect.any(String), correlationId: expect.any(String) });
    });

    integrationTest("rejects malformed public money and unsafe draft fields at the route boundary", async () => {
        const actor = await db.insert(users).values({ tenantId: "tenant-disbursement-invalid", email: "invalid@example.test", role: "owner" }).returning().then((rows) => rows[0]!);
        const token = await authToken(actor);
        const app = new Elysia().use(loansRoute);
        const result = await jsonRequest(app, "/loans/not-a-uuid/disbursements", token, {
            method: "POST", body: JSON.stringify({ grossAmount: "100", loanAttributedAmount: "100.00", channel: "wire", disbursedAt: "invalid" }),
        });
        expect(result.response.status).toBe(422);
    });

    integrationTest("rejects evidence IDs on draft commands and requires the dedicated prepare-finalize lifecycle", async () => {
        const actor = await db.insert(users).values({ tenantId: "tenant-disbursement-evidence-boundary", email: "evidence-boundary@example.test", role: "owner" }).returning().then((rows) => rows[0]!);
        const borrower = await db.insert(borrowers).values({ tenantId: actor.tenantId, ownerUserId: actor.id, name: "Evidence boundary borrower" }).returning().then((rows) => rows[0]!);
        const loan = await db.insert(loans).values({ tenantId: actor.tenantId, ownerUserId: actor.id, borrowerId: borrower.id, principalAmount: "100.00", interestRate: "0.00", repaymentType: "floating", outstandingPrincipal: "100.00", status: "active" }).returning().then((rows) => rows[0]!);
        const token = await authToken(actor);
        const app = new Elysia().use(loansRoute);
        const result = await jsonRequest(app, `/loans/${loan.publicId}/disbursements`, token, {
            method: "POST", body: JSON.stringify({ grossAmount: "100.00", loanAttributedAmount: "100.00", channel: "cash", disbursedAt: "2026-08-10T00:00:00.000Z", evidenceFilePublicIds: ["0198c481-3e2b-7000-8000-000000000098"] }),
        });
        expect(result.response.status).toBe(400);
        expect(result.body).toMatchObject({ code: "EVIDENCE_ATTACH_AFTER_DRAFT" });
    });

    integrationTest("returns not found when an event-scoped route is rooted under another accessible loan", async () => {
        const actor = await db.insert(users).values({ tenantId: "tenant-disbursement-parent", email: "parent@example.test", role: "owner" }).returning().then((rows) => rows[0]!);
        const borrower = await db.insert(borrowers).values({ tenantId: actor.tenantId, ownerUserId: actor.id, name: "Parent check borrower" }).returning().then((rows) => rows[0]!);
        const [actualLoan, wrongLoan] = await db.insert(loans).values([
            { tenantId: actor.tenantId, ownerUserId: actor.id, borrowerId: borrower.id, principalAmount: "100.00", interestRate: "0.00", repaymentType: "floating", outstandingPrincipal: "100.00", status: "active" },
            { tenantId: actor.tenantId, ownerUserId: actor.id, borrowerId: borrower.id, principalAmount: "100.00", interestRate: "0.00", repaymentType: "floating", outstandingPrincipal: "100.00", status: "active" },
        ]).returning();
        const token = await authToken(actor);
        const app = new Elysia().use(loansRoute);
        const created = await jsonRequest(app, `/loans/${actualLoan!.publicId}/disbursements`, token, {
            method: "POST", body: JSON.stringify({ grossAmount: "100.00", loanAttributedAmount: "100.00", channel: "cash", disbursedAt: "2026-08-10T00:00:00.000Z" }),
        });
        for (const request of [
            { path: `/loans/${wrongLoan!.publicId}/disbursements/${created.body.publicId}`, init: { method: "PUT", body: JSON.stringify({ payeeHint: "wrong parent" }) } },
            { path: `/loans/${wrongLoan!.publicId}/disbursements/${created.body.publicId}/evidence/upload-intents`, init: { method: "POST", body: JSON.stringify({ mimeType: "image/png", size: 4, sha256: "c".repeat(64) }) } },
            { path: `/loans/${wrongLoan!.publicId}/disbursements/${created.body.publicId}/evidence/0198c481-3e2b-7000-8000-000000000099/finalize`, init: { method: "POST", body: JSON.stringify({}) } },
            { path: `/loans/${wrongLoan!.publicId}/disbursements/${created.body.publicId}/post`, init: { method: "POST", headers: { "idempotency-key": "wrong-parent-post" }, body: JSON.stringify({}) } },
            { path: `/loans/${wrongLoan!.publicId}/disbursements/${created.body.publicId}/reverse`, init: { method: "POST", headers: { "idempotency-key": "wrong-parent-reverse" }, body: JSON.stringify({ reason: "wrong parent" }) } },
        ]) {
            const result = await jsonRequest(app, request.path, token, request.init);
            expect(result.response.status).toBe(404);
            expect(result.body).toMatchObject({ code: "DISBURSEMENT_NOT_FOUND" });
        }
    });
});
