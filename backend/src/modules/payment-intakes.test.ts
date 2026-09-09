import { beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { Elysia } from "elysia";
import { db } from "../db";
import { auditLogs, borrowers, loanSchedules, loans, paymentIntakes, transactions, users } from "../db/schema";
import { paymentIntakesRoute } from "./payment-intakes";
import { transactionsRoute } from "./transactions";

const integrationEnabled = Boolean(process.env.TEST_DATABASE_URL);
const integrationTest = integrationEnabled ? test : test.skip;

async function resetApplicationTables() {
    await db.execute(sql`TRUNCATE TABLE
        audit_logs, fund_ledger_entries, payment_match_allocations,
        payment_match_proposals, payment_evidence, transactions,
        payment_intakes, loan_funding_allocations, loan_schedules,
        loans, borrower_aliases, borrowers, bank_profiles, users
        RESTART IDENTITY CASCADE`);
}

async function authToken(user: { id: number; email: string; role: string | null; tenantId: string }) {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const header = encode({ alg: "HS256", typ: "JWT" });
    const payload = encode({ id: user.id, email: user.email, role: user.role, tenantId: user.tenantId });
    const unsigned = `${header}.${payload}`;
    const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(process.env.JWT_SECRET ?? "dev_jwt_secret_change_me"),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
    );
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

describe("payment intake REST adapter", () => {
    if (integrationEnabled) beforeEach(resetApplicationTables);

    // Break caught: REST implements its own matching/posting rules, drops command idempotency, or exposes numeric IDs/money.
    integrationTest("runs create/list/get/review/preview/post/reversal through the shared application service", async () => {
        const actor = await db.insert(users).values({
            tenantId: "tenant-a", email: "payment-route@example.test", role: "owner",
        }).returning().then((rows) => rows[0]!);
        const borrower = await db.insert(borrowers).values({
            tenantId: "tenant-a", ownerUserId: actor.id, name: "Route Borrower",
        }).returning().then((rows) => rows[0]!);
        const loan = await db.insert(loans).values({
            tenantId: "tenant-a", ownerUserId: actor.id, borrowerId: borrower.id,
            principalAmount: "100.00", interestRate: "0.00", repaymentType: "monthly",
            outstandingPrincipal: "100.00", outstandingInterest: "0.00", outstandingFees: "0.00", status: "active",
        }).returning().then((rows) => rows[0]!);
        await db.insert(loanSchedules).values({
            tenantId: "tenant-a", loanId: loan.id, installmentNo: 1, dueDate: "2026-08-10",
            scheduledPrincipal: "100.00", scheduledInterest: "0.00", scheduledFee: "0.00",
            scheduledTotal: "100.00", paidTotal: "0.00", paidPenalty: "0.00", remainingDue: "100.00", status: "pending",
        });
        const token = await authToken(actor);
        const app = new Elysia().use(paymentIntakesRoute);

        const created = await jsonRequest(app, "/payment-intakes", token, {
            method: "POST",
            headers: { "idempotency-key": "rest-payment-1", "x-request-id": "req-rest-payment" },
            body: JSON.stringify({ amount: "100.00", receivedAt: "2026-08-10T10:00:00.000Z", payerName: "Route Borrower", originLoanPublicId: loan.publicId }),
        });
        expect(created.response.status).toBe(200);
        expect(created.body).toMatchObject({ id: created.body.publicId, amount: "100.00", originLoanPublicId: loan.publicId, duplicate: false });

        const list = await jsonRequest(app, "/payment-intakes", token);
        const detail = await jsonRequest(app, `/payment-intakes/${created.body.publicId}`, token);
        expect(list.body).toMatchObject({
            items: [expect.objectContaining({ publicId: created.body.publicId, amount: "100.00" })],
            page: 1, pageSize: 25, total: 1, totalPages: 1,
        });
        expect(detail.body).toMatchObject({ publicId: created.body.publicId, evidence: [] });

        const reviewed = await jsonRequest(app, `/payment-intakes/${created.body.publicId}/review`, token, {
            method: "POST", body: JSON.stringify({ status: "needs_review" }),
        });
        expect(reviewed.body.status).toBe("needs_review");
        const queue = await jsonRequest(app, "/payment-intakes/review-queue", token);
        expect(queue.body).toEqual([expect.objectContaining({ publicId: created.body.publicId })]);

        const preview = await jsonRequest(app, `/payment-intakes/${created.body.publicId}/match-preview`, token, {
            method: "POST",
            body: JSON.stringify({ allocations: [{
                borrowerPublicId: borrower.publicId, loanPublicId: loan.publicId, amount: "100.00",
            }] }),
        });
        expect(preview.body).toMatchObject({ status: "ready", totalAllocated: "100.00" });

        const posted = await jsonRequest(app, `/payment-intakes/${created.body.publicId}/post`, token, {
            method: "POST", body: JSON.stringify({ proposalPublicId: preview.body.publicId }),
        });
        expect(posted.body).toMatchObject({ status: "posted", transactions: [expect.objectContaining({ amount: "100.00" })] });
        const reversed = await jsonRequest(app, `/payment-intakes/${created.body.publicId}/reverse`, token, {
            method: "POST", body: JSON.stringify({ reason: "Bank correction confirmed" }),
        });
        expect(reversed.body.status).toBe("reversed");
        expect(reversed.body.transactions).toHaveLength(2);
        const sourceRow = await db.query.paymentIntakes.findFirst({ where: eq(paymentIntakes.publicId, created.body.publicId) });
        const child = await db.insert(paymentIntakes).values({ tenantId: actor.tenantId, ownerUserId: actor.id, status: "posted", amount: "100.00", receivedAt: sourceRow!.receivedAt, repostOfIntakeId: sourceRow!.id, postedAt: new Date(), createdByUserId: actor.id, postedByUserId: actor.id }).returning().then((rows) => rows[0]!);
        const [sourceDetail, childDetail, lineageList] = await Promise.all([
            jsonRequest(app, `/payment-intakes/${sourceRow!.publicId}`, token),
            jsonRequest(app, `/payment-intakes/${child.publicId}`, token),
            jsonRequest(app, "/payment-intakes", token),
        ]);
        expect(sourceDetail.body).toMatchObject({ repostOfIntakePublicId: null, repostedByIntakePublicId: child.publicId });
        expect(childDetail.body).toMatchObject({ repostOfIntakePublicId: sourceRow!.publicId, repostedByIntakePublicId: null });
        expect(lineageList.body.items).toEqual(expect.arrayContaining([
            expect.objectContaining({ publicId: sourceRow!.publicId, repostedByIntakePublicId: child.publicId }),
            expect.objectContaining({ publicId: child.publicId, repostOfIntakePublicId: sourceRow!.publicId }),
        ]));
        const reversalAudit = await db.select().from(auditLogs).where(eq(auditLogs.action, "reversed"));
        expect(reversalAudit.at(-1)?.payload).toMatchObject({ reason: "Bank correction confirmed" });
    });

    // Break caught: the adapter accepts unsafe evidence MIME/URL-shaped payloads before the service validates them.
    integrationTest("returns stable domain errors for invalid evidence intent input", async () => {
        const actor = await db.insert(users).values({ tenantId: "tenant-a", email: "evidence-route@example.test", role: "owner" })
            .returning().then((rows) => rows[0]!);
        const token = await authToken(actor);
        const app = new Elysia().use(paymentIntakesRoute);
        const created = await jsonRequest(app, "/payment-intakes", token, {
            method: "POST", body: JSON.stringify({ amount: "10.00", receivedAt: "2026-08-10T10:00:00.000Z" }),
        });
        const invalid = await jsonRequest(app, `/payment-intakes/${created.body.publicId}/evidence/upload-intents`, token, {
            method: "POST", body: JSON.stringify({ mimeType: "text/html", size: 12, sha256: "a".repeat(64), url: "http://127.0.0.1/admin" }),
        });
        expect(invalid.response.status).toBe(400);
        expect(invalid.body).toMatchObject({ code: "INVALID_EVIDENCE" });

        const invalidMoney = await jsonRequest(app, "/payment-intakes", token, {
            method: "POST", body: JSON.stringify({ amount: "10", receivedAt: "2026-08-10T10:00:00.000Z" }),
        });
        expect(invalidMoney.response.status).toBe(400);
        expect(invalidMoney.body).toMatchObject({ code: "INVALID_PAYMENT_AMOUNT" });

        const blankIdempotency = await jsonRequest(app, "/payment-intakes", token, {
            method: "POST",
            headers: { "idempotency-key": "   " },
            body: JSON.stringify({ amount: "10.00", receivedAt: "2026-08-10T10:00:00.000Z" }),
        });
        expect(blankIdempotency.response.status).toBe(400);
        expect(blankIdempotency.body).toMatchObject({ code: "INVALID_IDEMPOTENCY_KEY" });
    });

    // Break caught: owner-scoped HTTP list/get/mutations reveal or mutate a peer collector's intake.
    integrationTest("enforces owner scope across payment intake HTTP reads and mutations", async () => {
        const [actor, peer] = await db.insert(users).values([
            { tenantId: "tenant-a", email: "scope-a@example.test", role: "collector" },
            { tenantId: "tenant-a", email: "scope-b@example.test", role: "collector" },
        ]).returning();
        const [own, hidden] = await db.insert(paymentIntakes).values([
            { tenantId: "tenant-a", ownerUserId: actor!.id, source: "web", status: "draft", amount: "10.00", receivedAt: new Date() },
            { tenantId: "tenant-a", ownerUserId: peer!.id, source: "web", status: "draft", amount: "20.00", receivedAt: new Date() },
        ]).returning();
        const token = await authToken(actor!);
        const app = new Elysia().use(paymentIntakesRoute);
        const list = await jsonRequest(app, "/payment-intakes", token);
        expect(list.body).toMatchObject({ items: [expect.objectContaining({ publicId: own!.publicId })], total: 1 });
        const detail = await jsonRequest(app, `/payment-intakes/${hidden!.publicId}`, token);
        expect(detail.response.status).toBe(404);
        expect(detail.body).toMatchObject({ code: "PAYMENT_INTAKE_NOT_FOUND" });
        const mutation = await jsonRequest(app, `/payment-intakes/${hidden!.publicId}/review`, token, {
            method: "POST", body: JSON.stringify({ status: "needs_review" }),
        });
        expect(mutation.response.status).toBe(404);
        expect(await db.query.paymentIntakes.findFirst({ where: eq(paymentIntakes.id, hidden!.id) }))
            .toMatchObject({ status: "draft" });
    });

    // Break caught: filtering widens owner/tenant scope, uses UTC date boundaries, or paginates before newest-first ordering.
    integrationTest("filters and paginates payment intakes with Bangkok business-day boundaries", async () => {
        const [actor, peer, otherTenant] = await db.insert(users).values([
            { tenantId: "tenant-a", email: "payment-list@example.test", role: "collector" },
            { tenantId: "tenant-a", email: "payment-list-peer@example.test", role: "collector" },
            { tenantId: "tenant-b", email: "payment-list-other@example.test", role: "owner" },
        ]).returning();
        const rows = await db.insert(paymentIntakes).values([
            { tenantId: "tenant-a", ownerUserId: actor!.id, status: "ready", amount: "10.00", payerName: "Alice Older", receivedAt: new Date("2026-08-10T17:00:00.000Z") },
            { tenantId: "tenant-a", ownerUserId: actor!.id, status: "ready", amount: "20.00", payerName: "Alice Newer", receivedAt: new Date("2026-08-11T16:59:59.999Z") },
            { tenantId: "tenant-a", ownerUserId: actor!.id, status: "draft", amount: "30.00", payerName: "Alice Draft", receivedAt: new Date("2026-08-11T12:00:00.000Z") },
            { tenantId: "tenant-a", ownerUserId: peer!.id, status: "ready", amount: "40.00", payerName: "Alice Peer", receivedAt: new Date("2026-08-11T12:00:00.000Z") },
            { tenantId: "tenant-b", ownerUserId: otherTenant!.id, status: "ready", amount: "50.00", payerName: "Alice Other", receivedAt: new Date("2026-08-11T12:00:00.000Z") },
            { tenantId: "tenant-a", ownerUserId: actor!.id, status: "ready", amount: "60.00", payerName: "Alice Tomorrow", receivedAt: new Date("2026-08-11T17:00:00.000Z") },
        ]).returning();
        const token = await authToken(actor!);
        const app = new Elysia().use(paymentIntakesRoute);

        const page = await jsonRequest(app, "/payment-intakes?search=alice&status=ready&from=2026-08-11&to=2026-08-11&page=2&pageSize=1", token);
        expect(page.response.status).toBe(200);
        expect(page.body).toEqual({
            items: [expect.objectContaining({ publicId: rows[0]!.publicId, payerName: "Alice Older", amount: "10.00" })],
            page: 2,
            pageSize: 1,
            total: 2,
            totalPages: 2,
        });

        for (const query of ["status=unknown", "from=2026-02-30", "page=0", "pageSize=101"]) {
            const invalid = await jsonRequest(app, `/payment-intakes?${query}`, token);
            expect(invalid.response.status).toBe(400);
            expect(invalid.body).toMatchObject({ code: "INVALID_PAYMENT_LIST_QUERY" });
        }
    });

    // Break caught: the legacy writer uses principal-first Number allocation and can overwrite an intake post from a stale snapshot.
    integrationTest("keeps legacy transactions read-only while an intake post holds the financial writer boundary", async () => {
        const actor = await db.insert(users).values({ tenantId: "tenant-a", email: "single-writer@example.test", role: "owner" })
            .returning().then((rows) => rows[0]!);
        const borrower = await db.insert(borrowers).values({ tenantId: "tenant-a", ownerUserId: actor.id, name: "Mixed Components" })
            .returning().then((rows) => rows[0]!);
        const loan = await db.insert(loans).values({
            tenantId: "tenant-a", ownerUserId: actor.id, borrowerId: borrower.id,
            principalAmount: "70.00", interestRate: "0.00", repaymentType: "monthly",
            outstandingPrincipal: "70.00", outstandingInterest: "20.00", outstandingFees: "10.00", status: "active",
        }).returning().then((rows) => rows[0]!);
        const schedule = await db.insert(loanSchedules).values({
            tenantId: "tenant-a", loanId: loan.id, installmentNo: 1, dueDate: "2026-08-10",
            scheduledPrincipal: "70.00", scheduledInterest: "20.00", scheduledFee: "10.00",
            scheduledTotal: "100.00", paidTotal: "0.00", paidPenalty: "0.00", remainingDue: "100.00", status: "pending",
        }).returning().then((rows) => rows[0]!);
        const token = await authToken(actor);
        const app = new Elysia().use(paymentIntakesRoute).use(transactionsRoute);

        const created = await jsonRequest(app, "/payment-intakes", token, {
            method: "POST", body: JSON.stringify({ amount: "40.00", receivedAt: "2026-08-10T10:00:00.000Z" }),
        });
        const preview = await jsonRequest(app, `/payment-intakes/${created.body.publicId}/match-preview`, token, {
            method: "POST", body: JSON.stringify({ allocations: [{
                borrowerPublicId: borrower.publicId, loanPublicId: loan.publicId, amount: "40.00",
            }] }),
        });

        let release!: () => void;
        let locked!: () => void;
        const lockReady = new Promise<void>((resolve) => { locked = resolve; });
        const releaseLock = new Promise<void>((resolve) => { release = resolve; });
        const blocker = db.transaction(async (tx) => {
            await tx.execute(sql`SELECT id FROM loans WHERE id = ${loan.id} FOR UPDATE`);
            await tx.execute(sql`SELECT id FROM loan_schedules WHERE id = ${schedule.id} FOR UPDATE`);
            locked();
            await releaseLock;
        });
        await lockReady;
        const posting = jsonRequest(app, `/payment-intakes/${created.body.publicId}/post`, token, {
            method: "POST", body: JSON.stringify({ proposalPublicId: preview.body.publicId }),
        });
        const legacyRequest = jsonRequest(app, "/transactions", token, {
            method: "POST", body: JSON.stringify({ loanId: loan.publicId, amount: "30.00", date: "2026-08-10T10:01:00.000Z" }),
        });
        await new Promise((resolve) => setTimeout(resolve, 20));
        release();
        await blocker;
        const legacy = await legacyRequest;
        expect(legacy.response.status).toBe(405);
        expect(legacy.body).toMatchObject({ code: "LEGACY_REPAYMENT_WRITE_DISABLED" });
        const legacyWithoutBody = await jsonRequest(app, "/transactions", token, { method: "POST" });
        expect(legacyWithoutBody.response.status).toBe(405);
        expect((await posting).response.status).toBe(200);
        expect(await db.select().from(transactions)).toEqual([
            expect.objectContaining({ feeComponent: "10.00", interestComponent: "20.00", principalComponent: "10.00" }),
        ]);
        expect(await db.query.loanSchedules.findFirst({ where: eq(loanSchedules.id, schedule.id) }))
            .toMatchObject({ paidTotal: "40.00", remainingDue: "60.00" });
    });
});
