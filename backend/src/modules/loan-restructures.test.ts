import { beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { Elysia } from "elysia";
import { db } from "../db";
import { auditLogs, borrowers, loanDisbursementEvents, loanOpeningBalanceComponents, loanRestructures, loanRestructureWaivers, loans, users } from "../db/schema";
import { loansRoute } from "./loans";

const integrationTest = process.env.TEST_DATABASE_URL ? test : test.skip;
const cacheIntegrationTest = process.env.TEST_DATABASE_URL && process.env.CACHE_URL ? test : test.skip;

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

async function seedThreeLoanChain(outboundStatus: "executed" | "reversed" = "executed") {
    const tenantId = `tenant-chain-${crypto.randomUUID()}`;
    const user = await db.insert(users).values({ tenantId, email: `${crypto.randomUUID()}@example.test`, role: "owner" }).returning().then(rows => rows[0]!);
    const borrower = await db.insert(borrowers).values({ tenantId, ownerUserId: user.id, name: "Three contract borrower" }).returning().then(rows => rows[0]!);
    const [a, b, c] = await db.insert(loans).values([
        { tenantId, ownerUserId: user.id, borrowerId: borrower.id, principalAmount: "5000.00", interestRate: "0.00", repaymentType: "daily", termMonths: 1, startDate: "2026-07-01", outstandingPrincipal: "5000.00", outstandingInterest: "0.00", outstandingFees: "0.00", status: "restructured" },
        { tenantId, ownerUserId: user.id, borrowerId: borrower.id, principalAmount: "6000.00", interestRate: "0.00", repaymentType: "daily", termMonths: 1, startDate: "2026-08-01", outstandingPrincipal: "6000.00", outstandingInterest: "300.00", outstandingFees: "0.00", status: "restructured" },
        { tenantId, ownerUserId: user.id, borrowerId: borrower.id, principalAmount: "6500.00", interestRate: "0.00", repaymentType: "daily", termMonths: 1, startDate: "2026-09-01", outstandingPrincipal: outboundStatus === "reversed" ? "0.00" : "6500.00", outstandingInterest: "0.00", outstandingFees: "0.00", status: outboundStatus === "reversed" ? "cancelled" : "active" },
    ]).returning();
    const [audit1, audit2, reversalAudit, waiverAudit] = await db.insert(auditLogs).values([
        { tenantId, entityType: "loan_restructure", entityId: a!.publicId, action: "executed", actorSource: "system", correlationId: "chain-1" },
        { tenantId, entityType: "loan_restructure", entityId: b!.publicId, action: "executed", actorSource: "system", correlationId: "chain-2" },
        { tenantId, entityType: "loan_restructure", entityId: b!.publicId, action: "reversed", actorSource: "system", correlationId: "chain-2-reverse" },
        { tenantId, entityType: "loan_restructure_waiver", entityId: b!.publicId, action: "executed", actorSource: "system", correlationId: "chain-waiver" },
    ]).returning();
    const common = { settlementDate: "2026-08-01", oldBalanceVersion: `v1:${"a".repeat(64)}`, previewHash: `v1:${"b".repeat(64)}`, requestHash: "c".repeat(64), requestedReplacementTerms: {}, grossPrincipal: "5000.00", grossInterest: "300.00", grossFees: "0.00", grossPenalty: "0.00", netPrincipal: "5000.00", netInterest: "300.00", netFees: "0.00", netPenalty: "0.00", cashDirection: "none", cashAmount: "0.00", reason: "chain", createdActorSource: "system", executeActorSource: "system", expiresAt: new Date("2026-12-01"), executedAt: new Date("2026-08-01"), preExecutionOldLoanState: { status: "active", outstandingPrincipal: "5000.00", outstandingInterest: "300.00", outstandingFees: "0.00", nextDueDate: null } } as const;
    const r1 = await db.insert(loanRestructures).values({ ...common, tenantId, oldLoanId: a!.id, newLoanId: b!.id, status: "executed", correlationId: "chain-1", executeIdempotencyKey: crypto.randomUUID(), executeRequestHash: "d".repeat(64), executedAuditPublicId: audit1!.publicId }).returning().then(rows => rows[0]!);
    const r2 = await db.insert(loanRestructures).values({ ...common, tenantId, oldLoanId: b!.id, newLoanId: c!.id, settlementDate: "2026-09-01", status: outboundStatus, correlationId: "chain-2", executeIdempotencyKey: crypto.randomUUID(), executeRequestHash: "e".repeat(64), executedAuditPublicId: audit2!.publicId, ...(outboundStatus === "reversed" ? { reversalIdempotencyKey: crypto.randomUUID(), reversalRequestHash: "f".repeat(64), reversalActorSource: "system", reversedAuditPublicId: reversalAudit!.publicId, reversedAt: new Date("2026-09-02") } : {}) }).returning().then(rows => rows[0]!);
    await db.insert(loanOpeningBalanceComponents).values([
        { tenantId, restructureId: r1.id, loanId: b!.id, componentKind: "carried_interest", amount: "300.00", sourceType: "loan_restructure", sourcePublicId: r1.publicId },
        { tenantId, restructureId: r2.id, loanId: c!.id, componentKind: "carried_interest", amount: "200.00", sourceType: "loan_restructure", sourcePublicId: r2.publicId },
    ]);
    await db.insert(loanRestructureWaivers).values({ tenantId, restructureId: r1.id, loanId: b!.id, componentKind: "interest", amount: "50.00", reason: "inbound assistance", status: "executed", actorSource: "system", correlationId: "chain-waiver", executeIdempotencyKey: crypto.randomUUID(), executeRequestHash: "1".repeat(64), auditPublicId: waiverAudit!.publicId, executedAt: new Date("2026-08-01") });
    return { user, a: a!, b: b!, c: c!, r1, r2 };
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

        const generalizedNested = await new Elysia().use(loansRoute).handle(new Request(`http://localhost/loans/${crypto.randomUUID()}/restructures/preview`, {
            method: "POST",
            headers: { authorization: `Bearer ${unsigned}.${signature}`, "content-type": "application/json" },
            body: JSON.stringify({
                settlementDate: "2026-08-15", additionalPrincipal: "0.00", reason: "generalized closed schema proof",
                replacementTerms: {
                    repaymentType: "floating", startDate: "2026-08-15", termMonths: 1, interestRate: "0.00",
                    floatingInterestPolicy: {
                        periodUnit: "week", periodLength: 1, rateMode: "percent", rate: "12.0000",
                        advanceInterestPeriods: 0, advanceInterestRefundPolicy: "non_refundable", surprise: true,
                    },
                },
            }),
        }));
        expect(generalizedNested.status, await generalizedNested.clone().text()).toBe(422);
        expect(await generalizedNested.json()).toMatchObject({ code: "VALIDATION_ERROR" });
    });

    // Break caught: the restructure service accepts a generalized weekly policy,
    // but the REST route rejects the additive field before it reaches the service.
    integrationTest("previews a generalized weekly floating replacement through the REST contract", async () => {
        const seeded = await seedRouteLoan();
        const result = await call(
            new Elysia().use(loansRoute),
            `/loans/${seeded.loan.publicId}/restructures/preview`,
            await tokenFor(seeded.user),
            {
                method: "POST",
                body: JSON.stringify({
                    settlementDate: "2026-08-15",
                    additionalPrincipal: "0.00",
                    reason: "replace with weekly floating terms",
                    replacementTerms: {
                        repaymentType: "floating",
                        startDate: "2026-08-15",
                        termMonths: 1,
                        interestRate: "0.00",
                        floatingInterestPolicy: {
                            periodUnit: "week",
                            periodLength: 1,
                            rateMode: "percent",
                            rate: "12.0000",
                            advanceInterestPeriods: 0,
                            advanceInterestRefundPolicy: "non_refundable",
                        },
                    },
                }),
            },
        );

        expect(result.response.status, JSON.stringify(result.body)).toBe(200);
        expect(result.body).toMatchObject({
            oldLoanPublicId: seeded.loan.publicId,
            replacementPrincipal: "5000.00",
        });
        const stored = await db.query.loanRestructures.findFirst({
            where: eq(loanRestructures.publicId, result.body.publicId),
        });
        expect(stored?.requestedReplacementTerms).toMatchObject({
            replacementTerms: {
                floatingInterestPolicy: {
                    periodUnit: "week",
                    periodLength: 1,
                    rateMode: "percent",
                    rate: "12.0000",
                    advanceInterestPeriods: 0,
                    advanceInterestRefundPolicy: "non_refundable",
                },
            },
        });
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
        const malformedId = await call(app, "/loans/restructures/not-a-uuid", token);
        expect(malformedId.response.status).toBe(400);
        expect(malformedId.body).toMatchObject({ code: "INVALID_PUBLIC_ID" });
        const malformedMoney = await call(app, `/loans/${seeded.loan.publicId}/restructures/preview`, token, { method: "POST", body: JSON.stringify({ ...requestBody, additionalPrincipal: "1000" }) });
        expect(malformedMoney.response.status).toBe(400);
        expect(malformedMoney.body).toMatchObject({ code: "INVALID_MONEY" });
        const preview = await call(app, `/loans/${seeded.loan.publicId}/restructures/preview`, token, { method: "POST", body: JSON.stringify(requestBody) });
        expect(preview.response.status).toBe(200);
        expect(preview.body).toMatchObject({ oldLoanPublicId: seeded.loan.publicId, replacementPrincipal: "6000.00", cash: { direction: "payout", amount: "1000.00" }, balance: { grossPrincipal: "5000.00", grossInterest: "500.00", waivedInterest: "100.00" } });
        expect((await call(app, `/loans/${seeded.loan.publicId}`, token)).body).toMatchObject({ status: "active", restructureLineage: null });

        const missingConfirmation = await call(app, `/loans/restructures/${preview.body.publicId}/execute`, token, { method: "POST", headers: { "idempotency-key": "rest-restructure-confirmation" }, body: JSON.stringify({ confirmed: false, previewHash: preview.body.previewHash, expectedBalanceVersion: preview.body.oldBalanceVersion, reason: "approved" }) });
        expect(missingConfirmation.response.status).toBe(400);
        expect(missingConfirmation.body).toMatchObject({ code: "RESTRUCTURE_CONFIRMATION_REQUIRED" });

        const missingIdempotency = await call(app, `/loans/restructures/${preview.body.publicId}/execute`, token, { method: "POST", body: JSON.stringify({ confirmed: true, previewHash: preview.body.previewHash, expectedBalanceVersion: preview.body.oldBalanceVersion, reason: "approved" }) });
        expect(missingIdempotency.response.status).toBe(400);
        expect(missingIdempotency.body).toMatchObject({ code: "IDEMPOTENCY_KEY_REQUIRED" });

        const executeInit = { method: "POST", headers: { "idempotency-key": "rest-restructure-execute", "x-correlation-id": "corr-rest-restructure" }, body: JSON.stringify({ confirmed: true, previewHash: preview.body.previewHash, expectedBalanceVersion: preview.body.oldBalanceVersion, reason: "approved" }) };
        const executed = await call(app, `/loans/restructures/${preview.body.publicId}/execute`, token, executeInit);
        expect(executed.response.status).toBe(200);
        expect(executed.body).toMatchObject({ status: "executed", oldLoanPublicId: seeded.loan.publicId, correlationId: "corr-rest-restructure" });
        expect(executed.body.auditPublicIds).toHaveLength(1);
        expect((await call(app, `/loans/restructures/${preview.body.publicId}/execute`, token, executeInit)).body).toEqual(executed.body);
        const conflictingRetry = await call(app, `/loans/restructures/${preview.body.publicId}/execute`, token, { ...executeInit, body: JSON.stringify({ confirmed: true, previewHash: preview.body.previewHash, expectedBalanceVersion: preview.body.oldBalanceVersion, reason: "different approval" }) });
        expect(conflictingRetry.response.status).toBe(409);
        expect(conflictingRetry.body).toMatchObject({ code: "IDEMPOTENCY_KEY_CONFLICT" });

        const list = await call(app, `/loans/${executed.body.newLoanPublicId}/restructures`, token);
        expect(list.response.status).toBe(200);
        expect(list.body[0]).toMatchObject({ publicId: preview.body.publicId, components: { net: { principal: "5000.00", interest: "400.00" }, additionalPrincipal: "1000.00" } });
        expect(list.body[0].openingComponents.every((item: Record<string, unknown>) => !Object.hasOwn(item, "loanId"))).toBe(true);

        const oldDetail = await call(app, `/loans/${seeded.loan.publicId}`, token);
        const newDetail = await call(app, `/loans/${executed.body.newLoanPublicId}`, token);
        expect(oldDetail.body.restructureLineage).toMatchObject({ restructuredToPublicId: executed.body.newLoanPublicId });
        expect(oldDetail.body.status).toBe("restructured");
        expect(newDetail.body.restructureLineage).toMatchObject({ restructuredFromPublicId: seeded.loan.publicId });
        expect(oldDetail.body.restructureLineage).toMatchObject({ inbound: null, outbound: { restructurePublicId: preview.body.publicId, loanPublicId: executed.body.newLoanPublicId, status: "executed" } });
        expect(newDetail.body.restructureLineage).toMatchObject({ inbound: { restructurePublicId: preview.body.publicId, loanPublicId: seeded.loan.publicId, status: "executed" }, outbound: null });
        expect(newDetail.body.openingBalanceComponents).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "additional_principal", amount: "1000.00" })]));
        const payoutLedger = await call(app, `/loans/${executed.body.newLoanPublicId}/disbursements`, token);
        expect(payoutLedger.response.status).toBe(200);
        expect(payoutLedger.body.events).toEqual([expect.objectContaining({ publicId: executed.body.disbursementDraftPublicId, restructurePublicId: preview.body.publicId, status: "draft" })]);
        const editedPayout = await call(app, `/loans/${executed.body.newLoanPublicId}/disbursements/${executed.body.disbursementDraftPublicId}`, token, { method: "PUT", body: JSON.stringify({ note: "operator replaced the generated note" }) });
        expect(editedPayout.body).toMatchObject({ restructurePublicId: preview.body.publicId, note: "operator replaced the generated note" });

        const manager = await db.insert(users).values({ tenantId: seeded.user.tenantId, email: `${crypto.randomUUID()}@example.test`, role: "manager" }).returning().then(rows => rows[0]!);
        const collector = await db.insert(users).values({ tenantId: seeded.user.tenantId, email: `${crypto.randomUUID()}@example.test`, role: "collector" }).returning().then(rows => rows[0]!);
        expect((await call(app, `/loans/${seeded.loan.publicId}/restructures`, await tokenFor(manager))).response.status).toBe(200);
        const collectorHidden = await call(app, `/loans/${seeded.loan.publicId}/restructures`, await tokenFor(collector));
        expect(collectorHidden.response.status).toBe(404);
        expect(collectorHidden.body).toMatchObject({ code: "LOAN_NOT_FOUND" });

        const reversed = await call(app, `/loans/restructures/${preview.body.publicId}/reverse`, token, { method: "POST", headers: { "idempotency-key": "rest-restructure-reverse", "x-correlation-id": "corr-rest-reverse" }, body: JSON.stringify({ reason: "agreement restored" }) });
        expect(reversed.response.status).toBe(200);
        expect(reversed.body).toMatchObject({ status: "reversed", correlationId: "corr-rest-reverse" });

        const outsider = await seedRouteLoan(`tenant-other-${crypto.randomUUID()}`);
        const hidden = await call(app, `/loans/restructures/${preview.body.publicId}`, await tokenFor(outsider.user));
        expect(hidden.response.status).toBe(404);
        expect(hidden.body).toMatchObject({ code: "RESTRUCTURE_NOT_FOUND" });
    });

    integrationTest("keeps inbound opening balances and waivers while independently presenting executed A to B to C lineage", async () => {
        const seeded = await seedThreeLoanChain("executed");
        const detail = await call(new Elysia().use(loansRoute), `/loans/${seeded.b.publicId}`, await tokenFor(seeded.user));
        expect(detail.response.status).toBe(200);
        expect(detail.body.restructureLineage).toMatchObject({
            restructurePublicId: seeded.r2.publicId, status: "executed",
            restructuredFromPublicId: seeded.a.publicId, restructuredToPublicId: seeded.c.publicId,
            inbound: { restructurePublicId: seeded.r1.publicId, loanPublicId: seeded.a.publicId, status: "executed" },
            outbound: { restructurePublicId: seeded.r2.publicId, loanPublicId: seeded.c.publicId, status: "executed" },
        });
        expect(detail.body.openingBalanceComponents).toEqual([expect.objectContaining({ kind: "carried_interest", amount: "300.00", sourcePublicId: seeded.r1.publicId })]);
        expect(detail.body.restructureWaivers).toEqual([expect.objectContaining({ amount: "50.00", reason: "inbound assistance" })]);
    });

    integrationTest("retains inbound A to B balances when the later B to C restructure is reversed", async () => {
        const seeded = await seedThreeLoanChain("reversed");
        const detail = await call(new Elysia().use(loansRoute), `/loans/${seeded.b.publicId}`, await tokenFor(seeded.user));
        expect(detail.body.restructureLineage).toMatchObject({
            restructurePublicId: seeded.r2.publicId, status: "reversed",
            restructuredFromPublicId: seeded.a.publicId, restructuredToPublicId: seeded.c.publicId,
            inbound: { restructurePublicId: seeded.r1.publicId, status: "executed" },
            outbound: { restructurePublicId: seeded.r2.publicId, status: "reversed" },
        });
        expect(detail.body.openingBalanceComponents).toHaveLength(1);
        expect(detail.body.openingBalanceComponents[0]).toMatchObject({ amount: "300.00", sourcePublicId: seeded.r1.publicId });
        expect(detail.body.restructureWaivers).toHaveLength(1);
    });

    cacheIntegrationTest("invalidates a prewarmed loan-detail cache after restructure execution", async () => {
        const seeded = await seedRouteLoan();
        const app = new Elysia().use(loansRoute);
        const token = await tokenFor(seeded.user);
        const before = await call(app, `/loans/${seeded.loan.publicId}`, token);
        expect(before.body).toMatchObject({ status: "active", restructureLineage: null });
        const preview = await call(app, `/loans/${seeded.loan.publicId}/restructures/preview`, token, {
            method: "POST",
            body: JSON.stringify({
                settlementDate: "2026-08-15", additionalPrincipal: "0.00", reason: "cache invalidation proof",
                replacementTerms: { repaymentType: "single_payment", startDate: "2026-08-15", termMonths: 1, interestRate: "0.00", singlePayment: { dueDate: "2026-09-15", fixedAgreedInterest: "0.00", interestPolicy: "fixed_only", latePenalty: { mode: "none" } } },
            }),
        });
        expect(preview.response.status).toBe(200);
        const executed = await call(app, `/loans/restructures/${preview.body.publicId}/execute`, token, {
            method: "POST", headers: { "idempotency-key": "cache-invalidation-restructure" },
            body: JSON.stringify({ confirmed: true, previewHash: preview.body.previewHash, expectedBalanceVersion: preview.body.oldBalanceVersion, reason: "cache invalidation proof" }),
        });
        expect(executed.response.status).toBe(200);
        const after = await call(app, `/loans/${seeded.loan.publicId}`, token);
        expect(after.body).toMatchObject({ status: "restructured", restructureLineage: { outbound: { restructurePublicId: preview.body.publicId, status: "executed" } } });
    });
});
