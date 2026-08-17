import { beforeEach, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { db } from "../db";
import { users } from "../db/schema";
import { getBorrowerPortfolio } from "../services/borrower-service";
import { getDashboardBorrowerHealth } from "../services/dashboard-borrower-health-service";
import { resetReplacementDatabase, seedReplacementFixture } from "../services/loan-replacement-test-fixture";
import { loansRoute } from "./loans";

const integrationTest = process.env.TEST_DATABASE_URL ? test : test.skip;

async function tokenFor(user: { id: number; email: string; role: string | null; tenantId: string }) {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const header = encode({ alg: "HS256", typ: "JWT" });
    const payload = encode({ id: user.id, email: user.email, role: user.role, tenantId: user.tenantId });
    const unsigned = `${header}.${payload}`;
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(process.env.JWT_SECRET ?? "dev_jwt_secret_change_me"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signature = Buffer.from(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(unsigned))).toString("base64url");
    return `${unsigned}.${signature}`;
}

async function call(app: { handle(request: Request): Response | Promise<Response> }, path: string, token: string | null, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    if (token) headers.set("authorization", `Bearer ${token}`);
    if (init.body) headers.set("content-type", "application/json");
    const response = await app.handle(new Request(`http://localhost${path}`, { ...init, headers }));
    const text = await response.text();
    return { response, body: text ? JSON.parse(text) : null, text };
}

describe("loan replacement REST lifecycle", () => {
    if (process.env.TEST_DATABASE_URL) beforeEach(resetReplacementDatabase);

    // Break caught: the public /loans composition omits a replacement command,
    // leaving a service-only financial workflow with no authenticated REST path.
    test("composes the three replacement lifecycle routes", () => {
        const endpoints = loansRoute.routes.map((route) => `${route.method} ${route.path}`);
        expect(endpoints).toEqual(expect.arrayContaining([
            "POST /loans/replacements/preview",
            "POST /loans/replacements/:publicId/execute",
            "POST /loans/replacements/:publicId/reverse",
        ]));
    });

    // Break caught: framework validation exposes its unstable `found` payload
    // instead of the public loan-domain error envelope for closed schemas.
    integrationTest("uses closed schemas and tenant-admin authorization for previews", async () => {
        const fixture = await seedReplacementFixture();
        const app = new Elysia().use(loansRoute);
        const body = {
            oldLoanPublicId: fixture.oldLoan.publicId,
            replacementDraftPublicId: fixture.replacementDraft.publicId,
            reason: "Corrected contract start date",
        };

        const unauthenticated = await call(app, "/loans/replacements/preview", null, { method: "POST", body: JSON.stringify(body) });
        expect(unauthenticated.response.status).toBe(401);

        const managerToken = await tokenFor(fixture.actor);
        const unknown = await call(app, "/loans/replacements/preview", managerToken, { method: "POST", body: JSON.stringify({ ...body, accidentalAmount: "1.00" }) });
        expect(unknown.response.status).toBe(422);
        expect(unknown.body).toEqual({ error: "Request body contains invalid or unknown fields", code: "VALIDATION_ERROR" });
        expect(unknown.body).not.toHaveProperty("found");

        const collector = await db.insert(users).values({ tenantId: fixture.tenantId, email: `${crypto.randomUUID()}@example.test`, role: "collector" }).returning().then((rows) => rows[0]!);
        const forbidden = await call(app, "/loans/replacements/preview", await tokenFor(collector), { method: "POST", body: JSON.stringify(body) });
        expect(forbidden.response.status).toBe(403);
        expect(forbidden.body).toMatchObject({ code: "TENANT_ADMIN_REQUIRED" });
    });

    // Break caught: tenant ownership is accidentally rejected, or a known
    // public loan UUID discloses its existence across tenant boundaries.
    integrationTest("allows an owner and hides foreign tenant loan public IDs", async () => {
        const fixture = await seedReplacementFixture();
        const app = new Elysia().use(loansRoute);
        const body = {
            oldLoanPublicId: fixture.oldLoan.publicId,
            replacementDraftPublicId: fixture.replacementDraft.publicId,
            reason: "Owner-approved correction",
        };
        const owner = await db.insert(users).values({ tenantId: fixture.tenantId, email: `${crypto.randomUUID()}@example.test`, role: "owner" }).returning().then((rows) => rows[0]!);
        const ownerPreview = await call(app, "/loans/replacements/preview", await tokenFor(owner), { method: "POST", body: JSON.stringify(body) });
        expect(ownerPreview.response.status, ownerPreview.text).toBe(200);
        expect(ownerPreview.body).toEqual(expect.objectContaining({
            publicId: expect.any(String), auditPublicId: expect.any(String), correlationId: expect.any(String),
            oldLoan: expect.objectContaining({ loanPublicId: fixture.oldLoan.publicId }),
            replacement: expect.objectContaining({ loanPublicId: fixture.replacementDraft.publicId }),
        }));

        const outsider = await db.insert(users).values({ tenantId: `tenant-outsider-${crypto.randomUUID()}`, email: `${crypto.randomUUID()}@example.test`, role: "owner" }).returning().then((rows) => rows[0]!);
        const hidden = await call(app, "/loans/replacements/preview", await tokenFor(outsider), { method: "POST", body: JSON.stringify(body) });
        expect(hidden.response.status).toBe(404);
        expect(hidden.body).toEqual({ error: "Loan not found", code: "LOAN_NOT_FOUND" });
    });

    // Break caught: REST execution loses the exact public fingerprint/audit
    // contract, fails to require explicit confirmation or does not project the
    // resulting terminal replacement lineage to detail, list, history and health.
    integrationTest("executes and reverses with public audit data and replacement lineage", async () => {
        const fixture = await seedReplacementFixture();
        const app = new Elysia().use(loansRoute);
        const token = await tokenFor(fixture.actor);
        const preview = await call(app, "/loans/replacements/preview", token, {
            method: "POST",
            headers: { "x-correlation-id": "corr-replacement-preview" },
            body: JSON.stringify({
                oldLoanPublicId: fixture.oldLoan.publicId,
                replacementDraftPublicId: fixture.replacementDraft.publicId,
                reason: "Corrected contract start date",
            }),
        });
        expect(preview.response.status, preview.text).toBe(200);
        const previewPublicId = preview.body.publicId as string;
        const previewHash = preview.body.previewHash as string;
        const oldBalanceVersion = preview.body.oldBalanceVersion as string;
        const replacementDraftVersion = preview.body.replacementDraftVersion as string;
        expect(structuredClone(preview.body)).toEqual({
            schemaVersion: 1,
            asOfDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
            reason: "Corrected contract start date",
            oldLoan: {
                loanPublicId: fixture.oldLoan.publicId,
                statusBefore: "active",
                statusAfter: "replaced",
                principal: "36000.00",
                collectibleBefore: { principal: "36000.00", interest: "4200.00", fee: "0.00", penalty: "0.00", nextDueDate: "2026-07-13" },
                collectibleAfter: { principal: "0.00", interest: "0.00", fee: "0.00", penalty: "0.00", nextDueDate: null },
            },
            cash: { direction: "none", amount: "0.00" },
            correction: { principal: "36000.00", interest: "4200.00", fee: "0.00", penalty: "0.00" },
            replacement: {
                loanPublicId: fixture.replacementDraft.publicId,
                statusBefore: "draft",
                statusAfter: "active",
                principal: "36000.00",
                interestRate: "0.00",
                repaymentType: "daily",
                termMonths: 7,
                totalInstallments: 200,
                installmentAmount: "300.00",
                startDate: "2026-07-11",
                firstDueDate: "2026-07-12",
                lastDueDate: "2027-01-27",
                totalRepayment: "60000.00",
                fundingSourceKind: "drawdown",
                fundingSourcePublicId: fixture.source.drawdown!.publicId,
                fundingSourceName: "TTB",
            },
            warnings: [{
                code: "OUTSTANDING_INTEREST_CORRECTED_TO_ZERO",
                details: {
                    amount: "4200.00",
                    correctedAmount: "0.00",
                    collected: false,
                    carriedForward: false,
                },
            }],
            publicId: previewPublicId,
            previewHash,
            oldBalanceVersion,
            replacementDraftVersion,
            expiresAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
            auditPublicId: expect.any(String),
            correlationId: "corr-replacement-preview",
        });
        expect(preview.body).not.toHaveProperty("oldLoanId");
        expect(preview.body).not.toHaveProperty("replacementLoanId");
        expect(preview.body).not.toHaveProperty("fundingSourceName");

        expect(previewHash).toMatch(/^v1:[0-9a-f]{64}$/);
        expect(oldBalanceVersion).toMatch(/^v1:[0-9a-f]{64}$/);
        expect(replacementDraftVersion).toMatch(/^v1:[0-9a-f]{64}$/);
        const executePath = `/loans/replacements/${previewPublicId}/execute`;
        const executeBody = {
            confirmed: true,
            previewHash,
            expectedOldBalanceVersion: oldBalanceVersion,
            expectedReplacementDraftVersion: replacementDraftVersion,
            reason: "Corrected contract start date",
        };
        const missingConfirmation = await call(app, executePath, token, { method: "POST", headers: { "idempotency-key": "replacement-confirmation" }, body: JSON.stringify({ ...executeBody, confirmed: false }) });
        expect(missingConfirmation.response.status, missingConfirmation.text).toBe(400);
        expect(missingConfirmation.body).toMatchObject({ code: "REPLACEMENT_CONFIRMATION_REQUIRED" });

        const missingIdempotency = await call(app, executePath, token, { method: "POST", body: JSON.stringify(executeBody) });
        expect(missingIdempotency.response.status).toBe(400);
        expect(missingIdempotency.body).toMatchObject({ code: "IDEMPOTENCY_KEY_REQUIRED" });

        const execute = await call(app, executePath, token, {
            method: "POST",
            headers: { "idempotency-key": "replacement-execute", "x-correlation-id": "corr-replacement-execute" },
            body: JSON.stringify(executeBody),
        });
        expect(execute.response.status, execute.text).toBe(200);
        expect(execute.body).toEqual({
            replacementPublicId: previewPublicId,
            oldLoanPublicId: fixture.oldLoan.publicId,
            replacementLoanPublicId: fixture.replacementDraft.publicId,
            status: "executed",
            auditPublicId: expect.any(String),
            correlationId: "corr-replacement-execute",
        });

        const [oldDetail, newDetail, allLoans] = await Promise.all([
            call(app, `/loans/${fixture.oldLoan.publicId}`, token),
            call(app, `/loans/${fixture.replacementDraft.publicId}`, token),
            call(app, "/loans/", token),
        ]);
        expect(oldDetail.body).toMatchObject({
            status: "replaced",
            replacementLineage: {
                replacementPublicId: previewPublicId, status: "executed",
                replacedFromPublicId: null, replacedToPublicId: fixture.replacementDraft.publicId,
                inbound: null,
                outbound: { replacementPublicId: previewPublicId, loanPublicId: fixture.replacementDraft.publicId, status: "executed" },
            },
        });
        expect(newDetail.body).toMatchObject({
            status: "active",
            replacementLineage: {
                replacementPublicId: previewPublicId, status: "executed",
                replacedFromPublicId: fixture.oldLoan.publicId, replacedToPublicId: null,
                inbound: { replacementPublicId: previewPublicId, loanPublicId: fixture.oldLoan.publicId, status: "executed" },
                outbound: null,
            },
        });
        expect(allLoans.body).toEqual(expect.arrayContaining([
            expect.objectContaining({ publicId: fixture.oldLoan.publicId, status: "replaced", replacementLineage: expect.objectContaining({ replacedToPublicId: fixture.replacementDraft.publicId }) }),
            expect.objectContaining({ publicId: fixture.replacementDraft.publicId, status: "active", replacementLineage: expect.objectContaining({ replacedFromPublicId: fixture.oldLoan.publicId }) }),
        ]));

        const history = await getBorrowerPortfolio(fixture.context("replacement-history"), fixture.borrower.publicId);
        expect(history.loans).toEqual(expect.arrayContaining([
            expect.objectContaining({ publicId: fixture.oldLoan.publicId, status: "replaced", replacementLineage: expect.objectContaining({ replacedToPublicId: fixture.replacementDraft.publicId }) }),
        ]));
        const health = await getDashboardBorrowerHealth(db, { context: fixture.context("replacement-health"), asOf: new Date() });
        expect(health.map((row) => row.loanPublicId)).toEqual([fixture.replacementDraft.publicId]);

        const unconfirmedReverse = await call(app, `/loans/replacements/${previewPublicId}/reverse`, token, {
            method: "POST",
            headers: { "idempotency-key": "replacement-reverse-unconfirmed" },
            body: JSON.stringify({ confirmed: false, reason: "The prior agreement remains authoritative" }),
        });
        expect(unconfirmedReverse.response.status).toBe(422);

        const reverse = await call(app, `/loans/replacements/${previewPublicId}/reverse`, token, {
            method: "POST",
            headers: { "idempotency-key": "replacement-reverse", "x-correlation-id": "corr-replacement-reverse" },
            body: JSON.stringify({ confirmed: true, reason: "The prior agreement remains authoritative" }),
        });
        expect(reverse.response.status, reverse.text).toBe(200);
        expect(reverse.body).toEqual({
            replacementPublicId: previewPublicId,
            oldLoanPublicId: fixture.oldLoan.publicId,
            replacementLoanPublicId: fixture.replacementDraft.publicId,
            status: "reversed",
            auditPublicId: expect.any(String),
            correlationId: "corr-replacement-reverse",
        });
    });

    // Break caught: own-capital previews lose the public presentation label or
    // accidentally resolve it through a bank drawdown that does not exist.
    integrationTest("places the own-capital source name inside the closed replacement object", async () => {
        const fixture = await seedReplacementFixture({ funding: "own_capital" });
        const app = new Elysia().use(loansRoute);
        const preview = await call(app, "/loans/replacements/preview", await tokenFor(fixture.actor), {
            method: "POST",
            body: JSON.stringify({
                oldLoanPublicId: fixture.oldLoan.publicId,
                replacementDraftPublicId: fixture.replacementDraft.publicId,
                reason: "Corrected own-capital contract start date",
            }),
        });

        expect(preview.response.status, preview.text).toBe(200);
        expect(preview.body).toMatchObject({
            replacement: {
                fundingSourceKind: "own_capital",
                fundingSourcePublicId: fixture.source.profile.publicId,
                fundingSourceName: "Own Capital",
            },
        });
        expect(preview.body).not.toHaveProperty("fundingSourceName");
    });
});
