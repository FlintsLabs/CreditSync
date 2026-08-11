import { beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { Elysia } from "elysia";
import { db } from "../db";
import { borrowers, loanInterestRatePeriods, loans, users } from "../db/schema";
import { loansRoute } from "./loans";

const integrationEnabled = Boolean(process.env.TEST_DATABASE_URL);
const integrationTest = integrationEnabled ? test : test.skip;

async function resetTables() {
    await db.execute(sql`SET client_min_messages TO WARNING`);
    await db.execute(sql`TRUNCATE TABLE audit_logs, loan_interest_rate_previews, loan_interest_accruals, loan_interest_rate_periods, loans, borrowers, users RESTART IDENTITY CASCADE`);
}

async function authToken(user: { id: number; email: string; role: string | null; tenantId: string }) {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const unsigned = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ id: user.id, email: user.email, role: user.role, tenantId: user.tenantId })}`;
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(process.env.JWT_SECRET ?? "dev_jwt_secret_change_me"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signature = Buffer.from(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(unsigned))).toString("base64url");
    return `${unsigned}.${signature}`;
}

async function seed() {
    const tenantId = "rate-route";
    const actor = await db.insert(users).values({ tenantId, email: "owner@rate-route.test", role: "owner" }).returning().then((rows) => rows[0]!);
    const borrower = await db.insert(borrowers).values({ tenantId, ownerUserId: actor.id, name: "Rate Borrower" }).returning().then((rows) => rows[0]!);
    const loan = await db.insert(loans).values({ tenantId, ownerUserId: actor.id, borrowerId: borrower.id, principalAmount: "1000.00", outstandingPrincipal: "1000.00", interestRate: "0.00", repaymentType: "floating", firstDayTreatment: "start_next_day", interestStartDate: "2026-08-01", status: "active" }).returning().then((rows) => rows[0]!);
    await db.insert(loanInterestRatePeriods).values({ tenantId, loanId: loan.id, effectiveDate: "2026-08-01", expiryDate: null, rateType: "per_thousand", rate: "15.0000", createdByUserId: actor.id });
    return { actor, loan, token: await authToken(actor) };
}

describe("loan interest rate routes", () => {
    if (integrationEnabled) beforeEach(resetTables);

    integrationTest("lists and previews a closed-schema public timeline", async () => {
        const { loan, token } = await seed();
        const app = new Elysia().use(loansRoute);
        const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

        const list = await app.handle(new Request(`http://localhost/loans/${loan.publicId}/interest-rates`, { headers }));
        expect(list.status).toBe(200);
        expect(await list.json()).toMatchObject({ loanPublicId: loan.publicId, currentPeriod: { rate: "15.0000" }, dailyInterestAtCurrentPrincipal: "15.00" });

        const invalid = await app.handle(new Request(`http://localhost/loans/${loan.publicId}/interest-rates/preview`, { method: "POST", headers, body: JSON.stringify({ effectiveDate: "2026-09-01", expiryDate: null, rateType: "percent", rate: "1", extra: true }) }));
        expect(invalid.status).toBe(422);

        const preview = await app.handle(new Request(`http://localhost/loans/${loan.publicId}/interest-rates/preview`, { method: "POST", headers, body: JSON.stringify({ effectiveDate: "2026-09-01", expiryDate: null, rateType: "percent", rate: "1" }) }));
        expect(preview.status).toBe(200);
        expect(await preview.json()).toMatchObject({ loanPublicId: loan.publicId, request: { rate: "1.0000" } });
    });

    integrationTest("requires execution idempotency and returns audit correlation", async () => {
        const { loan, token } = await seed();
        const app = new Elysia().use(loansRoute);
        const headers = { authorization: `Bearer ${token}`, "content-type": "application/json", "x-correlation-id": crypto.randomUUID() };
        const previewResponse = await app.handle(new Request(`http://localhost/loans/${loan.publicId}/interest-rates/preview`, { method: "POST", headers, body: JSON.stringify({ effectiveDate: "2026-09-01", expiryDate: null, rateType: "percent", rate: "1" }) }));
        const preview = await previewResponse.json() as { publicId: string; previewHash: string };
        const body = JSON.stringify({ previewPublicId: preview.publicId, previewHash: preview.previewHash, reason: "Owner approved" });

        const missingKey = await app.handle(new Request(`http://localhost/loans/${loan.publicId}/interest-rates/execute`, { method: "POST", headers, body }));
        expect(missingKey.status).toBe(400);
        expect(await missingKey.json()).toMatchObject({ code: "IDEMPOTENCY_KEY_REQUIRED" });

        const executed = await app.handle(new Request(`http://localhost/loans/${loan.publicId}/interest-rates/execute`, { method: "POST", headers: { ...headers, "idempotency-key": "route-rate-1" }, body }));
        expect(executed.status).toBe(200);
        expect(await executed.json()).toMatchObject({ loanPublicId: loan.publicId, correlationId: headers["x-correlation-id"] });
    });
});
