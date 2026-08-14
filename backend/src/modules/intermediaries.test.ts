import { beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { Elysia } from "elysia";
import { db } from "../db";
import { borrowers, intermediaries, intermediaryCollections, loans, users } from "../db/schema";
import { intermediariesRoute } from "./intermediaries";

const integrationEnabled = Boolean(process.env.TEST_DATABASE_URL);
const integrationTest = integrationEnabled ? test : test.skip;

async function resetTables() {
    await db.execute(sql`SET client_min_messages TO WARNING`);
    await db.execute(sql`TRUNCATE TABLE
        audit_logs, loan_intermediary_assignments, intermediary_bank_accounts,
        intermediaries, loans, borrowers, users RESTART IDENTITY CASCADE`);
}

async function authToken(user: { id: number; email: string; role: string | null; tenantId: string }) {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const unsigned = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ id: user.id, email: user.email, role: user.role, tenantId: user.tenantId })}`;
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(process.env.JWT_SECRET ?? "dev_jwt_secret_change_me"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signature = Buffer.from(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(unsigned))).toString("base64url");
    return `${unsigned}.${signature}`;
}

async function jsonRequest(app: { handle(request: Request): Response | Promise<Response> }, path: string, token: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${token}`);
    if (init.body) headers.set("content-type", "application/json");
    const response = await app.handle(new Request(`http://localhost${path}`, { ...init, headers }));
    const text = await response.text();
    return { response, body: text ? JSON.parse(text) : null };
}

describe("intermediary settlement REST contract", () => {
    if (integrationEnabled) beforeEach(resetTables);

    test("protects manual intermediary workflow endpoints", async () => {
        const app = new Elysia().use(intermediariesRoute);
        for (const path of ["/intermediaries", "/intermediaries/00000000-0000-0000-0000-000000000000", "/intermediaries/00000000-0000-0000-0000-000000000000/held-balance", "/intermediary-collections", "/intermediary-remittances"]) {
            const response = await app.handle(new Request(`http://localhost${path}`));
            expect(response.status).toBe(401);
        }
    });

    // Break caught: REST accepts open schemas/missing command keys or leaks raw account/internal IDs.
    integrationTest("serves strict profile, bank-account, assignment, end, and managed-loan routes", async () => {
        const actor = await db.insert(users).values({
            tenantId: "tenant-routes", email: "routes@intermediary-profile.test", role: "owner",
        }).returning().then((rows) => rows[0]!);
        const borrower = await db.insert(borrowers).values({
            tenantId: actor.tenantId, ownerUserId: actor.id, name: "Route Borrower",
        }).returning().then((rows) => rows[0]!);
        const loan = await db.insert(loans).values({
            tenantId: actor.tenantId, ownerUserId: actor.id, borrowerId: borrower.id,
            principalAmount: "1000.00", interestRate: "0.00", repaymentType: "floating",
            outstandingPrincipal: "1000.00", outstandingInterest: "0.00", outstandingFees: "0.00", status: "active",
        }).returning().then((rows) => rows[0]!);
        const intermediary = await db.insert(intermediaries).values({
            tenantId: actor.tenantId, ownerUserId: actor.id, name: "Route Intermediary",
            normalizedName: "route intermediary", aliases: ["Route Alias"], createdByUserId: actor.id, updatedByUserId: actor.id,
        }).returning().then((rows) => rows[0]!);
        const app = new Elysia().use(intermediariesRoute);
        const token = await authToken(actor);

        const inactive = await db.insert(intermediaries).values({
            tenantId: actor.tenantId, ownerUserId: actor.id, name: "Dormant Route Intermediary",
            normalizedName: "dormant route intermediary", aliases: ["Dormant Route Alias"], status: "inactive",
            createdByUserId: actor.id, updatedByUserId: actor.id,
        }).returning().then((rows) => rows[0]!);
        const activeOnlyCandidate = await jsonRequest(app, "/intermediaries?q=Dormant%20Route%20Alias", token);
        expect(activeOnlyCandidate.body).toEqual([]);
        const allStatusCandidate = await jsonRequest(app, "/intermediaries?q=Dormant%20Route%20Alias&status=all", token);
        expect(allStatusCandidate.body).toEqual([expect.objectContaining({
            publicId: inactive.publicId, name: "Dormant Route Intermediary", status: "inactive",
        })]);

        const legacyCreateWithExtra = await jsonRequest(app, "/intermediary-remittances", token, {
            method: "POST",
            headers: { "idempotency-key": "route-legacy-remittance" },
            body: JSON.stringify({
                intermediaryPublicId: intermediary.publicId,
                grossAmount: "10.00",
                receivedAt: "2026-01-01T00:00:00.000Z",
                legacyIgnoredField: "preserve normalization behavior",
            }),
        });
        expect(legacyCreateWithExtra.response.status).toBe(200);
        expect(legacyCreateWithExtra.body).toMatchObject({ grossAmount: "10.00", status: "draft" });

        const invalidAccount = await jsonRequest(app, `/intermediaries/${intermediary.publicId}/bank-accounts`, token, {
            method: "PUT",
            headers: { "idempotency-key": "route-bank-invalid" },
            body: JSON.stringify({ bankName: "SCB", accountName: "Route Intermediary", accountNumber: "1111222233", rawAccountNumber: "must reject" }),
        });
        expect(invalidAccount.response.status).toBe(422);

        const missingBankCode = await jsonRequest(app, `/intermediaries/${intermediary.publicId}/bank-accounts`, token, {
            method: "PUT",
            headers: { "idempotency-key": "route-bank-missing-code" },
            body: JSON.stringify({ bankName: "SCB", accountName: "Route Intermediary", accountNumber: "1111222233" }),
        });
        expect(missingBankCode.response.status).toBe(422);

        const malformedBankCode = await jsonRequest(app, `/intermediaries/${intermediary.publicId}/bank-accounts`, token, {
            method: "PUT",
            headers: { "idempotency-key": "route-bank-malformed-code" },
            body: JSON.stringify({ bankCode: "scb free text", bankName: "SCB", accountName: "Route Intermediary", accountNumber: "1111222233" }),
        });
        expect(malformedBankCode.response.status).toBe(422);

        const exposedFourDigitAccount = await jsonRequest(app, `/intermediaries/${intermediary.publicId}/bank-accounts`, token, {
            method: "PUT",
            headers: { "idempotency-key": "route-bank-four-digits" },
            body: JSON.stringify({ bankCode: "SCB", bankName: "SCB", accountName: "Route Intermediary", accountNumber: "1234" }),
        });
        expect(exposedFourDigitAccount.response.status).toBe(422);

        const missingBankKey = await jsonRequest(app, `/intermediaries/${intermediary.publicId}/bank-accounts`, token, {
            method: "PUT",
            body: JSON.stringify({ bankCode: "SCB", bankName: "SCB", accountName: "Route Intermediary", accountNumber: "1111222233" }),
        });
        expect(missingBankKey.response.status).toBe(400);
        expect(missingBankKey.body).toMatchObject({ code: "IDEMPOTENCY_KEY_REQUIRED" });

        const account = await jsonRequest(app, `/intermediaries/${intermediary.publicId}/bank-accounts`, token, {
            method: "PUT",
            headers: { "idempotency-key": "route-bank-1", "x-request-id": "req-route-bank" },
            body: JSON.stringify({ bankCode: "SCB", bankName: "Siam Commercial Bank", accountName: "Route Intermediary", accountNumber: "111-1-22223-3" }),
        });
        expect(account.response.status).toBe(200);
        expect(account.body).toMatchObject({ maskedAccountNumber: "•••• 2233" });
        expect(account.body).not.toHaveProperty("accountNumber");
        expect(account.body).not.toHaveProperty("accountNumberHash");
        expect(account.body).not.toHaveProperty("accountNumberLast4");

        const invalidRole = await jsonRequest(app, `/loans/${loan.publicId}/intermediary-assignments`, token, {
            method: "POST",
            headers: { "idempotency-key": "route-role-invalid" },
            body: JSON.stringify({ intermediaryPublicId: intermediary.publicId, role: "courier", effectiveFrom: "2026-01-01T00:00:00.000Z" }),
        });
        expect(invalidRole.response.status).toBe(422);

        const missingAssignmentKey = await jsonRequest(app, `/loans/${loan.publicId}/intermediary-assignments`, token, {
            method: "POST",
            body: JSON.stringify({ intermediaryPublicId: intermediary.publicId, role: "both", effectiveFrom: "2026-01-01T00:00:00.000Z" }),
        });
        expect(missingAssignmentKey.response.status).toBe(400);

        const assigned = await jsonRequest(app, `/loans/${loan.publicId}/intermediary-assignments`, token, {
            method: "POST",
            headers: { "idempotency-key": "route-assignment-1" },
            body: JSON.stringify({ intermediaryPublicId: intermediary.publicId, role: "both", effectiveFrom: "2026-01-01T00:00:00.000Z" }),
        });
        expect(assigned.response.status).toBe(200);
        expect(assigned.body).toMatchObject({ loanPublicId: loan.publicId, intermediaryPublicId: intermediary.publicId, role: "both", status: "active" });
        expect(assigned.body).not.toHaveProperty("loanId");
        expect(assigned.body).not.toHaveProperty("intermediaryId");

        const managed = await jsonRequest(app, `/intermediaries/${intermediary.publicId}/managed-loans?role=collection`, token);
        expect(managed.response.status).toBe(200);
        expect(managed.body).toEqual([expect.objectContaining({
            publicId: loan.publicId,
            borrowerName: "Route Borrower",
            roles: ["both"],
            assignments: [expect.objectContaining({ publicId: assigned.body.publicId, role: "both" })],
        })]);

        const profile = await jsonRequest(app, `/intermediaries/${intermediary.publicId}`, token);
        expect(profile.response.status).toBe(200);
        expect(profile.body).toMatchObject({
            publicId: intermediary.publicId,
            bankAccounts: [{ publicId: account.body.publicId, maskedAccountNumber: "•••• 2233" }],
            assignments: [expect.objectContaining({ publicId: assigned.body.publicId, status: "active" })],
        });
        expect(JSON.stringify(profile.body)).not.toContain("1111222233");

        await db.insert(intermediaryCollections).values({
            tenantId: actor.tenantId, ownerUserId: actor.id, intermediaryId: intermediary.id,
            borrowerId: borrower.id, loanId: loan.id, amount: "9007199254740993.01",
            borrowerPaidAt: new Date("2026-01-15T00:00:00.000Z"), status: "pending_remittance",
            idempotencyKey: "route-held-pending", createdByUserId: actor.id, updatedByUserId: actor.id,
        });
        const held = await jsonRequest(app, `/intermediaries/${intermediary.publicId}/held-balance`, token);
        expect(held.response.status).toBe(200);
        expect(held.body).toEqual({
            intermediaryPublicId: intermediary.publicId,
            fundingReceived: "0.00", borrowerPayout: "0.00", advanceInterestReturned: "0.00",
            disbursementHeldBalance: "0.00", collectionHeldBalance: "9007199254740993.01",
            totalHeldBalance: "9007199254740993.01",
        });
        expect(Object.keys(held.body).sort()).toEqual([
            "advanceInterestReturned", "borrowerPayout", "collectionHeldBalance", "disbursementHeldBalance",
            "fundingReceived", "intermediaryPublicId", "totalHeldBalance",
        ]);

        const ended = await jsonRequest(app, `/intermediary-assignments/${assigned.body.publicId}/end`, token, {
            method: "POST",
            headers: { "idempotency-key": "route-assignment-end-1" },
            body: JSON.stringify({ effectiveTo: "2026-02-01T00:00:00.000Z", reason: "Responsibility changed" }),
        });
        expect(ended.response.status).toBe(200);
        expect(ended.body).toMatchObject({ publicId: assigned.body.publicId, status: "ended", effectiveTo: "2026-02-01T00:00:00.000Z" });

        const assignedReplayAfterEnd = await jsonRequest(app, `/loans/${loan.publicId}/intermediary-assignments`, token, {
            method: "POST",
            headers: { "idempotency-key": "route-assignment-1" },
            body: JSON.stringify({ intermediaryPublicId: intermediary.publicId, role: "both", effectiveFrom: "2026-01-01T00:00:00.000Z" }),
        });
        expect(assignedReplayAfterEnd.response.status).toBe(200);
        expect(assignedReplayAfterEnd.body).toEqual(assigned.body);
    });
});
