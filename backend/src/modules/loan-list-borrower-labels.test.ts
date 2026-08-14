import { beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { Elysia } from "elysia";
import { db } from "../db";
import { borrowers, loans, users } from "../db/schema";
import { addBorrowerAlias, confirmBorrowerAlias, deactivateBorrowerAlias } from "../services/borrower-service";
import { loansRoute } from "./loans";

type TestUser = {
    id: number;
    email: string;
    role: "owner" | "manager" | "collector" | "viewer";
    tenantId: string;
};

const integrationTest = process.env.TEST_DATABASE_URL ? test : test.skip;
const cacheIntegrationTest = process.env.TEST_DATABASE_URL && process.env.CACHE_URL ? test : test.skip;

async function tokenFor(user: TestUser) {
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

async function call(app: { handle(request: Request): Response | Promise<Response> }, path: string, token: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${token}`);
    if (init.body) headers.set("content-type", "application/json");
    const response = await app.handle(new Request(`http://localhost${path}`, { ...init, headers }));
    const text = await response.text();
    return { response, body: text ? JSON.parse(text) : null };
}

function commandContext(tenantId: string, actorUserId: number) {
    return {
        tenantId,
        actorUserId,
        actorSource: "mcp" as const,
        requestId: `req-${crypto.randomUUID()}`,
        correlationId: `corr-${crypto.randomUUID()}`,
        idempotencyKey: `idem-${crypto.randomUUID()}`,
    };
}

function asTestUser(user: typeof users.$inferSelect): TestUser {
    if (!user.role) throw new Error(`Expected test user role for ${user.email}`);
    return { id: user.id, email: user.email, role: user.role, tenantId: user.tenantId };
}

async function resetApplicationTables() {
    await db.execute(sql`TRUNCATE TABLE audit_logs, borrower_aliases, loan_schedules, loans, borrowers, users RESTART IDENTITY CASCADE`);
}

describe("loan list borrower labels", () => {
    if (process.env.TEST_DATABASE_URL) beforeEach(resetApplicationTables);

    integrationTest("returns confirmed aliases in creation order and tags for visible borrowers only", async () => {
        const owner = await db.insert(users).values({
            tenantId: "tenant-owner",
            email: "owner@example.test",
            role: "owner",
        }).returning().then((rows) => rows[0]!);
        const collector = await db.insert(users).values({
            tenantId: "tenant-owner",
            email: "collector@example.test",
            role: "collector",
        }).returning().then((rows) => rows[0]!);
        const otherTenant = await db.insert(users).values({
            tenantId: "tenant-other",
            email: "other-owner@example.test",
            role: "owner",
        }).returning().then((rows) => rows[0]!);

        const ownerBorrower = await db.insert(borrowers).values({
            tenantId: "tenant-owner",
            ownerUserId: owner.id,
            name: "สมชาย คนดี",
            tags: ["VIP", "ตลาดเช้า"],
        }).returning().then((rows) => rows[0]!);
        const otherBorrower = await db.insert(borrowers).values({
            tenantId: "tenant-owner",
            ownerUserId: collector.id,
            name: "สมหญิง คนเก่ง",
            tags: ["กลุ่มA"],
        }).returning().then((rows) => rows[0]!);
        const hiddenBorrower = await db.insert(borrowers).values({
            tenantId: "tenant-other",
            ownerUserId: otherTenant.id,
            name: "คนลับ",
            tags: ["อื่น"],
        }).returning().then((rows) => rows[0]!);

        const ownerLoan = await db.insert(loans).values({
            tenantId: "tenant-owner",
            ownerUserId: owner.id,
            borrowerId: ownerBorrower.id,
            principalAmount: "10000.00",
            interestRate: "1.00",
            repaymentType: "daily",
            termMonths: 1,
            installmentAmount: "100.00",
            totalInstallments: 100,
            status: "active",
        }).returning().then((rows) => rows[0]!);
        const collectorLoan = await db.insert(loans).values({
            tenantId: "tenant-owner",
            ownerUserId: collector.id,
            borrowerId: otherBorrower.id,
            principalAmount: "2000.00",
            interestRate: "1.00",
            repaymentType: "daily",
            termMonths: 1,
            installmentAmount: "100.00",
            totalInstallments: 20,
            status: "active",
        }).returning().then((rows) => rows[0]!);
        await db.insert(loans).values({
            tenantId: "tenant-other",
            ownerUserId: otherTenant.id,
            borrowerId: hiddenBorrower.id,
            principalAmount: "3000.00",
            interestRate: "1.00",
            repaymentType: "daily",
            termMonths: 1,
            installmentAmount: "100.00",
            totalInstallments: 30,
            status: "active",
        }).returning().then((rows) => rows[0]!);

        const ownerPendingAlias = await addBorrowerAlias(commandContext("tenant-owner", owner.id), ownerBorrower.publicId, { alias: "รอตรวจ" });
        const ownerInactiveAlias = await addBorrowerAlias(commandContext("tenant-owner", owner.id), ownerBorrower.publicId, { alias: "ชื่อเก่า" });
        const ownerConfirmedAlias = await addBorrowerAlias(commandContext("tenant-owner", owner.id), ownerBorrower.publicId, { alias: "นก" });
        await confirmBorrowerAlias(commandContext("tenant-owner", owner.id), ownerConfirmedAlias.publicId);
        const ownerSecondConfirmedAlias = await addBorrowerAlias(commandContext("tenant-owner", owner.id), ownerBorrower.publicId, { alias: "คุณสมชาย" });
        await confirmBorrowerAlias(commandContext("tenant-owner", owner.id), ownerSecondConfirmedAlias.publicId);
        await deactivateBorrowerAlias(commandContext("tenant-owner", owner.id), ownerInactiveAlias.publicId);

        const foreignAlias = await addBorrowerAlias(commandContext("tenant-other", otherTenant.id), hiddenBorrower.publicId, { alias: "hidden-alias" });
        await confirmBorrowerAlias(commandContext("tenant-other", otherTenant.id), foreignAlias.publicId);

        const app = new Elysia().use(loansRoute);
        const ownerRows = await call(app, "/loans", await tokenFor(asTestUser(owner)));
        expect(ownerRows.response.status).toBe(200);
        expect(ownerRows.body).toEqual(expect.arrayContaining([
            expect.objectContaining({
                publicId: ownerLoan.publicId,
                borrowerAliases: ["นก", "คุณสมชาย"],
                borrowerTags: ["VIP", "ตลาดเช้า"],
            }),
            expect.objectContaining({
                publicId: collectorLoan.publicId,
                borrowerAliases: [],
                borrowerTags: ["กลุ่มA"],
            }),
        ]));

        const visiblePublicIds = ownerRows.body.map((row: { publicId: string }) => row.publicId);
        expect(visiblePublicIds).toContain(ownerLoan.publicId);
        expect(visiblePublicIds).toContain(collectorLoan.publicId);
        expect(ownerRows.body).not.toContainEqual(expect.objectContaining({ borrowerName: "คนลับ" }));
        const json = JSON.stringify(ownerRows.body);
        expect(json).not.toContain("รอตรวจ");
        expect(json).not.toContain("ชื่อเก่า");
        expect(json).not.toContain("hidden-alias");

        const collectorRows = await call(app, "/loans", await tokenFor(asTestUser(collector)));
        expect(collectorRows.response.status).toBe(200);
        expect(collectorRows.body.map((row: { publicId: string }) => row.publicId)).toEqual([collectorLoan.publicId]);
        expect(JSON.stringify(collectorRows.body)).not.toContain("hidden-alias");
    });

    cacheIntegrationTest("refreshes cached loan-list rows after alias confirmation and deactivation", async () => {
        const owner = await db.insert(users).values({ tenantId: "tenant-cache", email: "cache-owner@example.test", role: "owner" }).returning().then((rows) => rows[0]!);
        const borrower = await db.insert(borrowers).values({
            tenantId: "tenant-cache",
            ownerUserId: owner.id,
            name: "Cache Borrower",
            tags: [],
        }).returning().then((rows) => rows[0]!);
        const cacheLoan = await db.insert(loans).values({
            tenantId: "tenant-cache",
            ownerUserId: owner.id,
            borrowerId: borrower.id,
            principalAmount: "1000.00",
            interestRate: "1.00",
            repaymentType: "floating",
            status: "active",
        }).returning().then((rows) => rows[0]!);

        const app = new Elysia().use(loansRoute);
        const token = await tokenFor(asTestUser(owner));

        const initial = await call(app, "/loans", token);
        expect(initial.response.status).toBe(200);
        const initialRow = initial.body.find((row: { publicId: string }) => row.publicId === cacheLoan.publicId);
        expect(initialRow?.borrowerAliases).toEqual([]);

        const alias = await addBorrowerAlias(commandContext("tenant-cache", owner.id), borrower.publicId, { alias: "Fresh Alias" });
        await confirmBorrowerAlias(commandContext("tenant-cache", owner.id), alias.publicId);

        const confirmed = await call(app, "/loans", token);
        expect(confirmed.response.status).toBe(200);
        const confirmedRow = confirmed.body.find((row: { publicId: string }) => row.publicId === cacheLoan.publicId);
        expect(confirmedRow?.borrowerAliases).toEqual(["Fresh Alias"]);

        await deactivateBorrowerAlias(commandContext("tenant-cache", owner.id), alias.publicId);
        const deactivated = await call(app, "/loans", token);
        expect(deactivated.response.status).toBe(200);
        const deactivatedRow = deactivated.body.find((row: { publicId: string }) => row.publicId === cacheLoan.publicId);
        expect(deactivatedRow?.borrowerAliases).toEqual([]);
    });
});
