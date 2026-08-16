import { beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { Elysia } from "elysia";
import { db } from "../db";
import { borrowers, intermediaries, loanSchedules, loans, transactions, users } from "../db/schema";
import { intermediariesRoute } from "./intermediaries";
import { loansRoute } from "./loans";

const NIL = "00000000-0000-0000-0000-000000000000";
const integrationEnabled = Boolean(process.env.TEST_DATABASE_URL);
const integrationTest = integrationEnabled ? test : test.skip;

async function resetTables() {
    await db.execute(sql`TRUNCATE TABLE audit_logs, payment_intermediary_attributions, loan_commission_participants, transactions, intermediaries, loans, borrowers, users RESTART IDENTITY CASCADE`);
}

async function authToken(user: typeof users.$inferSelect) {
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

describe("loan agent REST contracts", () => {
    if (integrationEnabled) beforeEach(resetTables);
    test("protects participant, commission, and attribution endpoints", async () => {
        const app = new Elysia().use(loansRoute).use(intermediariesRoute);
        const requests = [
            new Request(`http://localhost/loans/${NIL}/commission-participants`),
            new Request(`http://localhost/loans/${NIL}/commission/preview`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ paymentPublicIds: [NIL] }) }),
            new Request(`http://localhost/payments/${NIL}/intermediary-attributions`),
        ];
        for (const request of requests) expect((await app.handle(request)).status).toBe(401);
    });

    test("keeps new write bodies closed and confirmation-gated", async () => {
        const app = new Elysia().use(loansRoute).use(intermediariesRoute);
        // An invalid bearer still reaches schema validation only after authentication;
        // the advertised route schema must not silently discard extra command fields.
        const response = await app.handle(new Request(`http://localhost/loans/${NIL}/commission-participants`, {
            method: "POST",
            headers: { authorization: "Bearer invalid", "content-type": "application/json" },
            body: JSON.stringify({ intermediaryPublicId: NIL, commissionRate: "10.00", role: "collector", effectiveFrom: "2026-08-16T00:00:00.000Z", unexpected: true }),
        }));
        expect([401, 422]).toContain(response.status);
    });

    integrationTest("wires exact participant, commission, and attribution commands through tenant-scoped services", async () => {
        const actor = await db.insert(users).values({ tenantId: "loan-agent-routes", email: "owner@loan-agent-routes.test", role: "owner" }).returning().then((rows) => rows[0]!);
        const foreign = await db.insert(users).values({ tenantId: "loan-agent-routes-foreign", email: "foreign@loan-agent-routes.test", role: "owner" }).returning().then((rows) => rows[0]!);
        const borrower = await db.insert(borrowers).values({ tenantId: actor.tenantId, ownerUserId: actor.id, name: "Route Borrower" }).returning().then((rows) => rows[0]!);
        const loan = await db.insert(loans).values({ tenantId: actor.tenantId, ownerUserId: actor.id, borrowerId: borrower.id, principalAmount: "100.00", interestRate: "0.00", repaymentType: "floating", status: "active" }).returning().then((rows) => rows[0]!);
        const scheduleRows = await db.insert(loanSchedules).values([
            { tenantId: actor.tenantId, loanId: loan.id, installmentNo: 1, dueDate: "2026-08-17", scheduledPrincipal: "80.00", scheduledInterest: "20.00", scheduledTotal: "100.00", paidTotal: "100.00", remainingDue: "0.00", status: "paid" },
            { tenantId: actor.tenantId, loanId: loan.id, installmentNo: 2, dueDate: "2026-08-18", scheduledPrincipal: "80.00", scheduledInterest: "20.00", scheduledTotal: "100.00", paidTotal: "0.00", remainingDue: "100.00", status: "pending" },
        ]).returning();
        const intermediary = await db.insert(intermediaries).values({ tenantId: actor.tenantId, ownerUserId: actor.id, name: "Route Agent", normalizedName: "route-agent", createdByUserId: actor.id, updatedByUserId: actor.id }).returning().then((rows) => rows[0]!);
        const payment = await db.insert(transactions).values({ tenantId: actor.tenantId, ownerUserId: actor.id, loanId: loan.id, scheduleId: scheduleRows[0]!.id, amount: "100.00", principalComponent: "80.00", interestComponent: "20.00", type: "repayment", entryType: "repayment", idempotencyKey: "route-payment", postedAt: new Date("2026-08-17T00:00:00.000Z") }).returning().then((rows) => rows[0]!);
        const app = new Elysia().use(loansRoute).use(intermediariesRoute);
        const token = await authToken(actor);

        const missingConfirmation = await jsonRequest(app, `/loans/${loan.publicId}/commission-participants`, token, {
            method: "POST", headers: { "idempotency-key": "participant-missing-confirmation" },
            body: JSON.stringify({ intermediaryPublicId: intermediary.publicId, commissionRate: "30.00", role: "collector", effectiveFrom: "2026-08-16T00:00:00.000Z" }),
        });
        expect(missingConfirmation.response.status).toBe(422);

        const added = await jsonRequest(app, `/loans/${loan.publicId}/commission-participants`, token, {
            method: "POST", headers: { "idempotency-key": "participant-add", "x-correlation-id": "0198c481-3e2b-7000-8000-000000000501" },
            body: JSON.stringify({ intermediaryPublicId: intermediary.publicId, commissionRate: "30.00", role: "collector", effectiveFrom: "2026-08-16T00:00:00.000Z", confirmed: true }),
        });
        expect(added.response.status).toBe(200);
        expect(added.body).toMatchObject({ loanPublicId: loan.publicId, intermediaryPublicId: intermediary.publicId, commissionRate: "30.00", correlationId: "0198c481-3e2b-7000-8000-000000000501" });
        expect(added.body.auditPublicId).toMatch(/^[0-9a-f-]{36}$/u);

        const preview = await jsonRequest(app, `/loans/${loan.publicId}/commission/preview`, token, {
            method: "POST", body: JSON.stringify({ paymentPublicIds: [payment.publicId] }),
        });
        expect(preview.response.status).toBe(200);
        expect(preview.body).toMatchObject({ interestAmount: "20.00", totalCommission: "6.00", participants: [{ commissionRate: "30.00", commissionAmount: "6.00" }] });
        const detail = await jsonRequest(app, `/loans/${loan.publicId}`, token);
        expect(detail.response.status).toBe(200);
        expect(detail.body).toMatchObject({
            commissionParticipantCount: 1,
            commissionParticipants: [{ commissionRate: "30.00" }],
            commissionSummary: { interestAmount: "20.00", totalCommission: "6.00" },
        });
        const schedule = await jsonRequest(app, `/loans/${loan.publicId}/schedule`, token);
        expect(schedule.response.status).toBe(200);
        expect(schedule.body).toEqual([
            expect.objectContaining({ publicId: scheduleRows[0]!.publicId, commissionAmount: "6.00" }),
            expect.objectContaining({ publicId: scheduleRows[1]!.publicId, commissionAmount: "0.00" }),
        ]);
        const updated = await jsonRequest(app, `/loans/${loan.publicId}/commission-participants/${added.body.publicId}`, token, {
            method: "PATCH", headers: { "idempotency-key": "participant-update" },
            body: JSON.stringify({ commissionRate: "25.00", role: "collector", effectiveFrom: "2026-08-18T00:00:00.000Z", confirmed: true }),
        });
        expect(updated.response.status).toBe(200);
        expect(updated.body).toMatchObject({ previousParticipantPublicId: added.body.publicId, commissionRate: "25.00", status: "active" });
        const ended = await jsonRequest(app, `/loans/${loan.publicId}/commission-participants/${updated.body.publicId}/end`, token, {
            method: "POST", headers: { "idempotency-key": "participant-end" },
            body: JSON.stringify({ effectiveTo: "2026-08-19T00:00:00.000Z", reason: "Agreement ended", confirmed: true }),
        });
        expect(ended.response.status).toBe(200);
        expect(ended.body).toMatchObject({ previousParticipantPublicId: updated.body.publicId, status: "ended" });
        await db.update(intermediaries).set({ status: "inactive" }).where(sql`${intermediaries.id} = ${intermediary.id}`);
        const historicalParticipants = await jsonRequest(app, `/loans/${loan.publicId}/commission-participants`, token);
        expect(historicalParticipants.body).toEqual([
            expect.objectContaining({ publicId: ended.body.publicId, intermediaryName: "Route Agent", intermediaryAliases: [] }),
        ]);

        const foreignList = await jsonRequest(app, `/loans/${loan.publicId}/commission-participants`, await authToken(foreign));
        expect(foreignList.response.status).toBe(404);
        expect(foreignList.body).toMatchObject({ code: "LOAN_NOT_FOUND" });

        const attributed = await jsonRequest(app, `/payments/${payment.publicId}/intermediary-attributions`, token, {
            method: "POST", headers: { "idempotency-key": "attribution-create" },
            body: JSON.stringify({ sourceKind: "intermediary", intermediaryPublicId: intermediary.publicId, amount: "40.00", confirmed: true }),
        });
        expect(attributed.response.status).toBe(200);
        expect(attributed.body).toMatchObject({ paymentPublicId: payment.publicId, intermediaryPublicId: intermediary.publicId, amount: "40.00" });
        expect(attributed.body).toHaveProperty("auditPublicId");
        expect(attributed.body).toHaveProperty("correlationId");

        const reversed = await jsonRequest(app, `/payment-intermediary-attributions/${attributed.body.publicId}/reverse`, token, {
            method: "POST", headers: { "idempotency-key": "attribution-reverse" },
            body: JSON.stringify({ reason: "Wrong source", confirmed: true }),
        });
        expect(reversed.response.status).toBe(200);
        expect(reversed.body).toMatchObject({ amount: "-40.00", reversedAttributionPublicId: attributed.body.publicId, reason: "Wrong source" });
        expect(typeof reversed.body.amount).toBe("string");
    });
});
