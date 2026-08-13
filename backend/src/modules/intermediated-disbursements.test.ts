import { beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { Elysia } from "elysia";
import { db } from "../db";
import { borrowers, intermediaries, loanIntermediaryAssignments, loans, users } from "../db/schema";
import { intermediatedDisbursementsRoute } from "./intermediated-disbursements";

const integrationEnabled = Boolean(process.env.TEST_DATABASE_URL);
const integrationTest = integrationEnabled ? test : test.skip;

async function resetTables() {
    await db.execute(sql`SET client_min_messages TO WARNING`);
    await db.execute(sql`TRUNCATE TABLE
        audit_logs,
        intermediated_disbursement_group_previews,
        intermediated_transfer_evidence,
        intermediated_transfer_evidence_intents,
        intermediated_transfer_events,
        intermediated_disbursement_groups,
        loan_intermediary_assignments,
        intermediary_bank_accounts,
        intermediaries,
        loans,
        borrowers,
        users
        RESTART IDENTITY CASCADE`);
}

async function seed() {
    const actor = await db.insert(users).values({
        tenantId: "tenant-intermediated-routes",
        email: "routes@intermediated-disbursement.test",
        role: "owner",
    }).returning().then((rows) => rows[0]!);
    const borrower = await db.insert(borrowers).values({
        tenantId: actor.tenantId,
        ownerUserId: actor.id,
        name: "Route Borrower",
    }).returning().then((rows) => rows[0]!);
    const loan = await db.insert(loans).values({
        tenantId: actor.tenantId,
        ownerUserId: actor.id,
        borrowerId: borrower.id,
        principalAmount: "9000.00",
        interestRate: "0.00",
        repaymentType: "floating",
        outstandingPrincipal: "9000.00",
        outstandingInterest: "0.00",
        outstandingFees: "0.00",
        activationIdempotencyKey: "route-activation",
        activationResult: {
            publicId: "00000000-0000-7000-8000-000000000002",
            principal: "5000.00",
            principalAmount: "5000.00",
            repaymentType: "floating",
            floatingInterestPolicy: {
                periodUnit: "week",
                periodLength: 1,
                rateMode: "percent",
                rate: "12.0000",
                advanceInterestPeriods: 1,
                advanceInterestRefundPolicy: "non_refundable",
            },
            status: "active",
        },
        status: "active",
    }).returning().then((rows) => rows[0]!);
    const intermediary = await db.insert(intermediaries).values({
        tenantId: actor.tenantId,
        ownerUserId: actor.id,
        name: "Route Intermediary",
        normalizedName: "route intermediary",
        createdByUserId: actor.id,
        updatedByUserId: actor.id,
    }).returning().then((rows) => rows[0]!);
    await db.insert(loanIntermediaryAssignments).values({
        tenantId: actor.tenantId,
        loanId: loan.id,
        intermediaryId: intermediary.id,
        role: "both",
        effectiveFrom: new Date("2026-08-01T00:00:00.000Z"),
        idempotencyKey: "route-assignment",
        createdByUserId: actor.id,
        updatedByUserId: actor.id,
    });
    return { actor, borrower, loan, intermediary };
}

async function authToken(user: { id: number; email: string; role: string | null; tenantId: string }) {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const unsigned = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ id: user.id, email: user.email, role: user.role, tenantId: user.tenantId })}`;
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(process.env.JWT_SECRET ?? "dev_jwt_secret_change_me"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signature = Buffer.from(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(unsigned))).toString("base64url");
    return `${unsigned}.${signature}`;
}

async function jsonRequest(
    app: { handle(request: Request): Response | Promise<Response> },
    path: string,
    token?: string,
    init: RequestInit = {},
) {
    const headers = new Headers(init.headers);
    if (token) headers.set("authorization", `Bearer ${token}`);
    if (init.body) headers.set("content-type", "application/json");
    const response = await app.handle(new Request(`http://localhost${path}`, { ...init, headers }));
    const text = await response.text();
    return { response, body: text ? JSON.parse(text) : null };
}

describe("intermediated disbursement REST contract", () => {
    if (integrationEnabled) beforeEach(resetTables);

    test("protects group, event, detail, list, and preview routes", async () => {
        const app = new Elysia().use(intermediatedDisbursementsRoute);
        for (const [method, path, body] of [
            ["GET", "/intermediated-disbursements", undefined],
            ["POST", "/intermediated-disbursements", JSON.stringify({
                loanPublicId: "00000000-0000-7000-8000-000000000001",
                intermediaryPublicId: "00000000-0000-7000-8000-000000000002",
                retainedBalance: "0.00",
            })],
            ["GET", "/intermediated-disbursements/00000000-0000-7000-8000-000000000000", undefined],
            ["POST", "/intermediated-disbursements/00000000-0000-7000-8000-000000000000/events", JSON.stringify({
                role: "funding_to_intermediary",
                channel: "bank_transfer",
                amount: "1.00",
                transferredAt: "2026-08-13T09:00:00.000Z",
            })],
            ["POST", "/intermediated-disbursements/00000000-0000-7000-8000-000000000000/preview", undefined],
        ]) {
            const response = await app.handle(new Request(`http://localhost${path}`, {
                method,
                body,
                headers: body ? { "content-type": "application/json" } : undefined,
            }));
            expect(response.status).toBe(401);
        }
    });

    // Break caught: REST normalizes away unknown financial fields, accepts loose money/date/role
    // input, omits command context, or exposes internal numeric IDs/hashes in public responses.
    integrationTest("serves closed exact group, split-event, list/detail, and preview contracts", async () => {
        const owner = await seed();
        const token = await authToken(owner.actor);
        const app = new Elysia().use(intermediatedDisbursementsRoute);

        const missingKey = await jsonRequest(app, "/intermediated-disbursements", token, {
            method: "POST",
            body: JSON.stringify({
                loanPublicId: owner.loan.publicId,
                intermediaryPublicId: owner.intermediary.publicId,
                retainedBalance: "0.00",
            }),
        });
        expect(missingKey.response.status).toBe(400);
        expect(missingKey.body).toMatchObject({ code: "IDEMPOTENCY_KEY_REQUIRED" });

        const unknownGroupField = await jsonRequest(app, "/intermediated-disbursements", token, {
            method: "POST",
            headers: { "idempotency-key": "route-group-unknown" },
            body: JSON.stringify({
                loanPublicId: owner.loan.publicId,
                intermediaryPublicId: owner.intermediary.publicId,
                retainedBalance: "0.00",
                expectedFunding: "1.00",
            }),
        });
        expect(unknownGroupField.response.status).toBe(422);

        const created = await jsonRequest(app, "/intermediated-disbursements", token, {
            method: "POST",
            headers: {
                "idempotency-key": "route-group-create",
                "x-request-id": "req-route-group-create",
                "x-correlation-id": "corr-route-group-create",
            },
            body: JSON.stringify({
                loanPublicId: owner.loan.publicId,
                intermediaryPublicId: owner.intermediary.publicId,
                retainedBalance: "0.00",
                note: "Route group",
            }),
        });
        expect(created.response.status).toBe(200);
        expect(created.body).toMatchObject({
            expectedFunding: "5000.00",
            expectedBorrowerPayout: "4400.00",
            expectedAdvanceInterestReturn: "600.00",
            retainedBalance: "0.00",
            status: "draft",
            auditPublicId: expect.any(String),
            correlationId: "corr-route-group-create",
        });

        const invalidEvent = await jsonRequest(app, `/intermediated-disbursements/${created.body.publicId}/events`, token, {
            method: "POST",
            headers: { "idempotency-key": "route-event-invalid" },
            body: JSON.stringify({
                role: "funding_to_intermediary",
                channel: "bank_transfer",
                amount: "5000",
                transferredAt: "2026-08-13T09:00:00.000Z",
                callerComputedAmount: "5000.00",
            }),
        });
        expect(invalidEvent.response.status).toBe(422);

        for (const [suffix, role, amount] of [
            ["funding", "funding_to_intermediary", "5000.00"],
            ["borrower-a", "borrower_net_payout", "2000.00"],
            ["borrower-b", "borrower_net_payout", "2400.00"],
            ["advance", "advance_interest_return", "600.00"],
        ] as const) {
            const event = await jsonRequest(app, `/intermediated-disbursements/${created.body.publicId}/events`, token, {
                method: "POST",
                headers: { "idempotency-key": `route-event-${suffix}` },
                body: JSON.stringify({
                    role,
                    channel: "bank_transfer",
                    amount,
                    transferredAt: "2026-08-13T09:00:00.000Z",
                    bankReference: `ROUTE-${suffix}`,
                }),
            });
            expect(event.response.status).toBe(200);
            expect(event.body).toMatchObject({ role, amount, status: "ready", correlationId: expect.any(String) });
            expect(event.body).not.toHaveProperty("groupId");
            expect(event.body).not.toHaveProperty("bankReferenceHash");
        }

        const preview = await jsonRequest(app, `/intermediated-disbursements/${created.body.publicId}/preview`, token, { method: "POST", body: "{}" });
        expect(preview.response.status).toBe(200);
        expect(preview.body).toMatchObject({
            expectedFunding: "5000.00",
            actualFunding: "5000.00",
            actualBorrowerPayout: "4400.00",
            actualAdvanceInterestReturn: "600.00",
            retainedBalance: "0.00",
            variance: "0.00",
            status: "ready",
            version: 1,
        });

        const detail = await jsonRequest(app, `/intermediated-disbursements/${created.body.publicId}`, token);
        expect(detail.response.status).toBe(200);
        expect(detail.body).toMatchObject({ publicId: created.body.publicId, latestPreview: { publicId: preview.body.publicId } });
        expect(Array.isArray(detail.body.events)).toBe(true);
        expect(detail.body.events).toHaveLength(4);

        const listed = await jsonRequest(
            app,
            `/intermediated-disbursements?loanPublicId=${owner.loan.publicId}&intermediaryPublicId=${owner.intermediary.publicId}&status=ready`,
            token,
        );
        expect(listed.response.status).toBe(200);
        expect(listed.body).toEqual([expect.objectContaining({ publicId: created.body.publicId, status: "ready" })]);
        expect(JSON.stringify({ created: created.body, detail: detail.body, listed: listed.body })).not.toMatch(/\"(?:id|loanId|intermediaryId|groupId|bankReferenceHash)\"/);

        const unknownQuery = await jsonRequest(app, "/intermediated-disbursements?unexpected=true", token);
        expect(unknownQuery.response.status).toBe(422);
    });
});
