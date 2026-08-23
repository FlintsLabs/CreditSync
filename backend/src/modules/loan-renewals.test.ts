import { beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { Elysia } from "elysia";
import { db } from "../db";
import { bankLoans, bankProfiles, borrowers, loanFundingAllocations, loanSchedules, loans, users } from "../db/schema";
import { generateLoanSchedule } from "../lib/loan-schedule";
import { loanRenewalsRoute } from "./loan-renewals";
import { loansRoute } from "./loans";

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

async function seedRouteLoan(options: { tenantId?: string; role?: "owner" | "manager" | "collector" | "viewer" } = {}) {
    const tenantId = options.tenantId ?? "tenant-renewal-route";
    const actor = await db.insert(users).values({
        tenantId,
        email: `renewal-route-${crypto.randomUUID()}@example.test`,
        role: options.role ?? "owner",
    })
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
    return { actor, loan, profile, drawdown };
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
            cashDirection: "collection",
            cashAmount: "100.00",
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
        expect(executed.body).toMatchObject({ status: "executed", requestedPrincipal: "1000.00", cashAmount: "100.00" });
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

    integrationTest("accepts closed policy and adjustment inputs and rejects invalid REST boundaries", async () => {
        const seeded = await seedRouteLoan();
        const token = await authToken(seeded.actor);
        const app = new Elysia().use(loanRenewalsRoute);
        const post = (body: Record<string, unknown>) => jsonRequest(app, "/loan-renewals/preview", token, {
            method: "POST",
            body: JSON.stringify({ oldLoanPublicId: seeded.loan.publicId, requestedPrincipal: "1000.00", ...body }),
        });

        const valid = await post({
            settlementPolicy: "accrued_to_date",
            adjustments: [{ kind: "fee", amount: "5.00", reason: "Manual fee" }],
        });
        expect(valid.response.status).toBe(200);
        expect(valid.body.composition).toMatchObject({
            settlementPolicy: "accrued_to_date",
            adjustments: [{ lineNo: 1, kind: "fee", amount: "5.00", reason: "Manual fee" }],
        });

        const invalidBodies = [
            { unknown: true },
            { settlementPolicy: "unknown" },
            { adjustments: [{ kind: "credit", amount: "1.00", reason: "x" }] },
            { adjustments: [{ kind: "fee", amount: "0.00", reason: "x" }] },
            { adjustments: [{ kind: "fee", amount: "1.00", reason: " " }] },
            { adjustments: Array.from({ length: 51 }, () => ({ kind: "fee", amount: "1.00", reason: "x" })) },
        ];
        const statuses = await Promise.all(invalidBodies.map(async (body) => (await post(body)).response.status));
        expect(statuses).toEqual([422, 422, 422, 400, 400, 422]);
    });

    integrationTest("returns one stable HTTP conflict for concurrent different renewals sharing an execution key", async () => {
        const first = await seedRouteLoan();
        const second = await seedRouteLoan({ tenantId: first.actor.tenantId });
        const token = await authToken(first.actor);
        const app = new Elysia().use(loanRenewalsRoute);
        const preview = async (loanPublicId: string) => jsonRequest(app, "/loan-renewals/preview", token, {
            method: "POST",
            body: JSON.stringify({ oldLoanPublicId: loanPublicId, requestedPrincipal: "1000.00" }),
        });
        const [firstPreview, secondPreview] = await Promise.all([preview(first.loan.publicId), preview(second.loan.publicId)]);
        let releaseLock!: () => void;
        let markLocked!: () => void;
        const release = new Promise<void>((resolve) => { releaseLock = resolve; });
        const locked = new Promise<void>((resolve) => { markLocked = resolve; });
        const blocker = db.transaction(async (tx) => {
            await tx.execute(sql`SELECT id FROM loans WHERE id IN (${first.loan.id}, ${second.loan.id}) ORDER BY id FOR UPDATE`);
            markLocked();
            await release;
        });
        await locked;
        const execute = (renewal: { body: any }) => jsonRequest(
            app,
            `/loan-renewals/${renewal.body.publicId}/execute`,
            token,
            {
                method: "POST",
                headers: { "idempotency-key": "shared-http-renewal-key" },
                body: JSON.stringify({
                    previewHash: renewal.body.previewHash,
                    confirmed: true,
                    reason: "HTTP concurrency proof",
                }),
            },
        );
        const firstPending = execute(firstPreview);
        const secondPending = execute(secondPreview);
        await Bun.sleep(50);
        releaseLock();
        await blocker;
        const responses = await Promise.all([firstPending, secondPending]);
        expect(responses.map((row) => row.response.status).sort()).toEqual([200, 409]);
        expect(responses.find((row) => row.response.status === 409)?.body)
            .toMatchObject({ code: "IDEMPOTENCY_KEY_CONFLICT" });
    });

    integrationTest("enforces collector ownership and tenant isolation on renewal HTTP endpoints", async () => {
        const collectorLoan = await seedRouteLoan({ tenantId: "tenant-collector-scope", role: "collector" });
        const otherOwnerLoan = await seedRouteLoan({ tenantId: "tenant-collector-scope", role: "collector" });
        const crossTenantLoan = await seedRouteLoan({ tenantId: "tenant-other-scope", role: "owner" });
        const token = await authToken(collectorLoan.actor);
        const app = new Elysia().use(loanRenewalsRoute);
        const preview = (loanPublicId: string) => jsonRequest(app, "/loan-renewals/preview", token, {
            method: "POST",
            body: JSON.stringify({ oldLoanPublicId: loanPublicId, requestedPrincipal: "1000.00" }),
        });

        expect((await preview(collectorLoan.loan.publicId)).response.status).toBe(200);
        const sameTenantHidden = await preview(otherOwnerLoan.loan.publicId);
        expect(sameTenantHidden.response.status).toBe(404);
        expect(sameTenantHidden.body).toMatchObject({ code: "LOAN_NOT_FOUND" });
        const crossTenantHidden = await preview(crossTenantLoan.loan.publicId);
        expect(crossTenantHidden.response.status).toBe(404);
        expect(crossTenantHidden.body).toMatchObject({ code: "LOAN_NOT_FOUND" });

        const otherPreview = await jsonRequest(app, "/loan-renewals/preview", await authToken(otherOwnerLoan.actor), {
            method: "POST",
            body: JSON.stringify({ oldLoanPublicId: otherOwnerLoan.loan.publicId, requestedPrincipal: "1000.00" }),
        });
        const hiddenExecute = await jsonRequest(
            app,
            `/loan-renewals/${otherPreview.body.publicId}/execute`,
            token,
            {
                method: "POST",
                headers: { "idempotency-key": "collector-hidden-execute" },
                body: JSON.stringify({
                    previewHash: otherPreview.body.previewHash,
                    confirmed: true,
                    reason: "must remain hidden",
                }),
            },
        );
        expect(hiddenExecute.response.status).toBe(404);
        expect(hiddenExecute.body).toMatchObject({ code: "RENEWAL_NOT_FOUND" });

        const crossPreview = await jsonRequest(app, "/loan-renewals/preview", await authToken(crossTenantLoan.actor), {
            method: "POST",
            body: JSON.stringify({ oldLoanPublicId: crossTenantLoan.loan.publicId, requestedPrincipal: "1000.00" }),
        });
        const hiddenReverse = await jsonRequest(
            app,
            `/loan-renewals/${crossPreview.body.publicId}/reverse`,
            token,
            {
                method: "POST",
                headers: { "idempotency-key": "collector-cross-tenant-reverse" },
                body: JSON.stringify({ reason: "must remain hidden" }),
            },
        );
        expect(hiddenReverse.response.status).toBe(404);
        expect(hiddenReverse.body).toMatchObject({ code: "RENEWAL_NOT_FOUND" });
    });

    integrationTest("serializes funding reallocation before renewal execution on the borrower loan lock", async () => {
        const seeded = await seedRouteLoan();
        const targetProfile = await db.insert(bankProfiles).values({
            tenantId: seeded.actor.tenantId, name: "Route Target Fund", type: "bank",
        }).returning().then((rows) => rows[0]!);
        const targetDrawdown = await db.insert(bankLoans).values({
            tenantId: seeded.actor.tenantId, bankProfileId: targetProfile.id, amount: "5000.00",
        }).returning().then((rows) => rows[0]!);
        const token = await authToken(seeded.actor);
        const app = new Elysia().use(loanRenewalsRoute).use(loansRoute);
        const preview = await jsonRequest(app, "/loan-renewals/preview", token, {
            method: "POST",
            body: JSON.stringify({ oldLoanPublicId: seeded.loan.publicId, requestedPrincipal: "1000.00" }),
        });

        let releaseLock!: () => void;
        let markLocked!: () => void;
        const release = new Promise<void>((resolve) => { releaseLock = resolve; });
        const locked = new Promise<void>((resolve) => { markLocked = resolve; });
        const blocker = db.transaction(async (tx) => {
            await tx.execute(sql`SELECT id FROM loans WHERE id = ${seeded.loan.id} FOR UPDATE`);
            markLocked();
            await release;
        });
        await locked;
        const executePending = jsonRequest(app, `/loan-renewals/${preview.body.publicId}/execute`, token, {
            method: "POST",
            headers: { "idempotency-key": "route-reallocation-race" },
            body: JSON.stringify({ previewHash: preview.body.previewHash, confirmed: true, reason: "locked race" }),
        });
        await Bun.sleep(100);
        const reallocationPending = jsonRequest(app, `/loans/${seeded.loan.publicId}/funding-reallocations`, token, {
            method: "POST",
            body: JSON.stringify({
                fromBankLoanPublicId: seeded.drawdown.publicId,
                toBankLoanPublicId: targetDrawdown.publicId,
                amount: "100.00",
                allocationDate: "2099-01-01",
            }),
        });
        await Bun.sleep(20);
        releaseLock();
        await blocker;
        const [reallocated, executed] = await Promise.all([reallocationPending, executePending]);
        expect(executed.response.status).toBe(200);
        expect(reallocated.response.status).toBe(409);
        expect(reallocated.body).toMatchObject({ code: "LOAN_FUNDING_LOCKED" });

        const replacement = await db.query.loans.findFirst({ where: eq(loans.publicId, executed.body.newLoanPublicId) });
        const funding = await db.select().from(loanFundingAllocations)
            .where(eq(loanFundingAllocations.loanId, replacement!.id)).orderBy(loanFundingAllocations.bankLoanId);
        expect(funding.map((row) => ({ bankLoanId: row.bankLoanId, amount: row.allocatedAmount }))).toEqual([
            { bankLoanId: seeded.drawdown.id, amount: "1000.00" },
        ]);
    });
});
