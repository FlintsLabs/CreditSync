import { beforeEach, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { sql } from "drizzle-orm";
import { db } from "../db";
import { users } from "../db/schema";
import { createBorrower } from "../services/borrower-service";
import { activateLoan, createLoanDraft } from "../services/loan-application-service";
import type { CommandContext } from "../services/command-context";
import { loansRoute } from "./loans";

const integrationTest = process.env.TEST_DATABASE_URL ? test : test.skip;
function context(actor: { id: number; tenantId: string }, key: string): CommandContext {
    return { tenantId: actor.tenantId, actorUserId: actor.id, actorSource: "web", requestId: `req-${key}`, correlationId: `corr-${key}`, idempotencyKey: key };
}
async function authToken(actor: { id: number; email: string; role: string | null; tenantId: string }) {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const unsigned = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ id: actor.id, email: actor.email, role: actor.role, tenantId: actor.tenantId })}`;
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(process.env.JWT_SECRET ?? "dev_jwt_secret_change_me"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return `${unsigned}.${Buffer.from(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(unsigned))).toString("base64url")}`;
}

describe("selected floating accrual payment routes", () => {
    if (process.env.TEST_DATABASE_URL) beforeEach(async () => {
        await db.execute(sql`SET client_min_messages TO WARNING`);
        await db.execute(sql`TRUNCATE TABLE loans, borrowers, users RESTART IDENTITY CASCADE`);
    });

    integrationTest("requires command context and confirmation, then previews and posts exact selected targets", async () => {
        const tenantId = `accrual-route-${crypto.randomUUID()}`;
        const actor = await db.insert(users).values({ tenantId, email: `${crypto.randomUUID()}@example.test`, role: "owner" }).returning().then((rows) => rows[0]!);
        const ctx = context(actor, "route-seed");
        const borrower = await createBorrower(ctx, { name: "Route Borrower" });
        const draft = await createLoanDraft(ctx, { borrowerPublicId: borrower.publicId, principal: "4000.00", interestRate: "0.00", repaymentType: "floating", termMonths: 1, startDate: "2026-09-30", floatingDailyInterest: { mode: "percent", rate: "2.0000", firstDayTreatment: "start_next_day", accrualCycle: "daily" } });
        await activateLoan(ctx, draft.publicId);
        const token = await authToken(actor);
        const app = new Elysia().use(loansRoute);
        const path = `/loans/${draft.publicId}/accrual-payments`;
        const body = { amount: "80.00", receivedAt: "2026-10-02T09:00:00+07:00", targets: [{ accrualDate: "2026-10-02", amount: "80.00" }] };
        const headers = { authorization: `Bearer ${token}`, "content-type": "application/json", "x-request-id": "route-request", "x-correlation-id": "route-correlation" };
        const missingContext = await app.handle(new Request(`http://localhost${path}/preview`, { method: "POST", headers: { authorization: headers.authorization, "content-type": headers["content-type"], "idempotency-key": "route-missing-context" }, body: JSON.stringify(body) }));
        expect(missingContext.status).toBe(400);
        const previewResponse = await app.handle(new Request(`http://localhost${path}/preview`, { method: "POST", headers: { ...headers, "idempotency-key": "route-preview" }, body: JSON.stringify(body) }));
        expect(previewResponse.status).toBe(200);
        const preview = await previewResponse.json() as { publicId: string; paymentIntakePublicId: string; status: string; totalAllocated: string };
        expect(preview).toMatchObject({ status: "ready", totalAllocated: "80.00" });
        const rejected = await app.handle(new Request(`http://localhost${path}/post`, { method: "POST", headers: { ...headers, "idempotency-key": "route-post-unconfirmed" }, body: JSON.stringify({ paymentIntakePublicId: preview.paymentIntakePublicId, proposalPublicId: preview.publicId, confirmed: false }) }));
        expect(rejected.status).toBe(422);
        const posted = await app.handle(new Request(`http://localhost${path}/post`, { method: "POST", headers: { ...headers, "idempotency-key": "route-post" }, body: JSON.stringify({ paymentIntakePublicId: preview.paymentIntakePublicId, proposalPublicId: preview.publicId, confirmed: true }) }));
        expect(posted.status).toBe(200);
        expect(await posted.json()).toMatchObject({ publicId: preview.paymentIntakePublicId, status: "posted", receiptPublicId: expect.any(String), auditPublicId: expect.any(String), correlationId: expect.any(String), transactions: [expect.objectContaining({ interestComponent: "80.00", principalComponent: "0.00" })] });
    });
});
