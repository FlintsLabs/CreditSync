import { beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { Elysia } from "elysia";
import { db } from "../db";
import { bankLoans, bankProfiles, borrowers, loanFundingAllocations, loanSchedules, loans, users } from "../db/schema";
import { generateLoanSchedule } from "../lib/loan-schedule";
import { loanRenewalsRoute } from "./loan-renewals";

const integrationEnabled = Boolean(process.env.TEST_DATABASE_URL);
const integrationTest = integrationEnabled ? test : test.skip;

async function resetApplicationTables() {
    await db.execute(sql`TRUNCATE TABLE
        audit_logs, loan_adjustments, loan_renewals, fund_ledger_entries,
        transactions, payment_match_allocations, payment_match_proposals,
        payment_evidence, payment_intakes, loan_funding_allocations,
        loan_schedules, loans, borrowers, users, bank_loans, bank_profiles
        RESTART IDENTITY CASCADE`);
}

async function authToken(user: { id: number; email: string; role: string | null; tenantId: string }) {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const header = encode({ alg: "HS256", typ: "JWT" });
    const payload = encode({ id: user.id, email: user.email, role: user.role, tenantId: user.tenantId });
    const unsigned = `${header}.${payload}`;
    const key = await crypto.subtle.importKey(
        "raw", new TextEncoder().encode(process.env.JWT_SECRET ?? "dev_jwt_secret_change_me"),
        { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
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
    return { response, body: text ? JSON.parse(text) : null };
}

async function seedRouteLoan() {
    const tenantId = "tenant-renewal-route";
    const actor = await db.insert(users).values({ tenantId, email: "renewal-route@example.test", role: "owner" })
        .returning().then((rows) => rows[0]!);
    const borrower = await db.insert(borrowers).values({ tenantId, ownerUserId: actor.id, name: "Route Borrower" })
        .returning().then((rows) => rows[0]!);
    const loan = await db.insert(loans).values({
        tenantId, ownerUserId: actor.id, borrowerId: borrower.id,
        principalAmount: "1000.00", interestRate: "10.00", repaymentType: "daily",
        termMonths: 1, installmentAmount: "220.00", totalInstallments: 5,
        startDate: "2099-01-01", outstandingPrincipal: "1000.00",
        outstandingInterest: "100.00", outstandingFees: "0.00", status: "active",
    }).returning().then((rows) => rows[0]!);
    const schedule = generateLoanSchedule({
        principal: "1000.00", interestRate: "10.00", repaymentType: "daily", termMonths: 1,
        installmentAmount: "220.00", totalInstallments: 5, startDate: "2099-01-01",
    });
    await db.insert(loanSchedules).values(schedule.map((row) => ({
        tenantId, loanId: loan.id, installmentNo: row.installmentNo, dueDate: row.dueDate,
        scheduledPrincipal: row.scheduledPrincipal, scheduledInterest: row.scheduledInterest,
        scheduledFee: row.scheduledFee, scheduledTotal: row.scheduledTotal,
        paidTotal: "0.00", paidPenalty: "0.00", remainingDue: row.remainingDue, status: "pending",
    })));
    const profile = await db.insert(bankProfiles).values({ tenantId, name: "Route Fund", type: "bank" })
        .returning().then((rows) => rows[0]!);
    const drawdown = await db.insert(bankLoans).values({ tenantId, bankProfileId: profile.id, amount: "5000.00" })
        .returning().then((rows) => rows[0]!);
    await db.insert(loanFundingAllocations).values({
        tenantId, bankProfileId: profile.id, bankLoanId: drawdown.id, loanId: loan.id,
        allocatedAmount: "1000.00", allocationDate: "2099-01-01", allocationType: "initial",
        createdByUserId: actor.id,
    });
    return { actor, loan };
}

describe("loan renewal REST adapter", () => {
    if (integrationEnabled) beforeEach(resetApplicationTables);

    // Break caught: HTTP adapters drop UUID/string DTOs, confirmation, reason, idempotency, or shared service behavior.
    integrationTest("previews, executes, and reverses through authenticated string-only DTOs", async () => {
        const seeded = await seedRouteLoan();
        const token = await authToken(seeded.actor);
        const app = new Elysia().use(loanRenewalsRoute);

        const preview = await jsonRequest(app, "/loan-renewals/preview", token, {
            method: "POST",
            body: JSON.stringify({ oldLoanPublicId: seeded.loan.publicId, requestedPrincipal: "1000.00" }),
        });
        expect(preview.response.status).toBe(200);
        expect(preview.body).toMatchObject({
            id: preview.body.publicId,
            oldLoanPublicId: seeded.loan.publicId,
            requestedPrincipal: "1000.00",
            outstandingPrincipal: "1000.00",
            cashDirection: "none",
            cashAmount: "0.00",
        });
        expect(preview.body).not.toHaveProperty("oldLoanId");

        const missingConfirmation = await jsonRequest(app, `/loan-renewals/${preview.body.publicId}/execute`, token, {
            method: "POST",
            headers: { "idempotency-key": "rest-renewal-execute-missing-confirm" },
            body: JSON.stringify({ previewHash: preview.body.previewHash, confirmed: false, reason: "route check" }),
        });
        expect(missingConfirmation.response.status).toBe(400);
        expect(missingConfirmation.body).toMatchObject({ code: "RENEWAL_CONFIRMATION_REQUIRED" });

        const executed = await jsonRequest(app, `/loan-renewals/${preview.body.publicId}/execute`, token, {
            method: "POST",
            headers: { "idempotency-key": "rest-renewal-execute" },
            body: JSON.stringify({ previewHash: preview.body.previewHash, confirmed: true, reason: "route renewal" }),
        });
        expect(executed.response.status).toBe(200);
        expect(executed.body).toMatchObject({ status: "executed", requestedPrincipal: "1000.00", cashAmount: "0.00" });
        expect(executed.body.newLoanPublicId).toMatch(/^[0-9a-f-]{36}$/);

        const reversed = await jsonRequest(app, `/loan-renewals/${preview.body.publicId}/reverse`, token, {
            method: "POST",
            headers: { "idempotency-key": "rest-renewal-reverse" },
            body: JSON.stringify({ reason: "route reversal" }),
        });
        expect(reversed.response.status).toBe(200);
        expect(reversed.body).toMatchObject({ status: "reversed", reason: "route reversal" });
    });

    // Break caught: malformed public IDs leak SQL/framework errors instead of the stable domain envelope.
    integrationTest("returns stable domain errors for malformed renewal IDs", async () => {
        const seeded = await seedRouteLoan();
        const token = await authToken(seeded.actor);
        const app = new Elysia().use(loanRenewalsRoute);

        const invalid = await jsonRequest(app, "/loan-renewals/preview", token, {
            method: "POST",
            body: JSON.stringify({ oldLoanPublicId: "1", requestedPrincipal: "1000.00" }),
        });
        expect(invalid.response.status).toBe(400);
        expect(invalid.body).toMatchObject({ code: "INVALID_PUBLIC_ID", details: { field: "oldLoanId" } });
    });
});
