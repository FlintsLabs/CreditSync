import { beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { Elysia } from "elysia";
import { db } from "../db";
import { borrowers, loans, users } from "../db/schema";
import { loansRoute } from "./loans";

const integrationTest = process.env.TEST_DATABASE_URL ? test : test.skip;

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

describe("floating loan legacy closing summary", () => {
    if (process.env.TEST_DATABASE_URL) beforeEach(async () => {
        await db.execute(sql`SET client_min_messages TO WARNING`);
        await db.execute(sql`TRUNCATE TABLE loans, borrowers, users RESTART IDENTITY CASCADE`);
    });

    // Break caught: the legacy summary bypasses the versioned settlement preview,
    // explicit confirmation, idempotency, and immutable allocation provenance.
    integrationTest("requires the preview-and-execute settlement workflow", async () => {
        const tenantId = `tenant-closing-${crypto.randomUUID()}`;
        const actor = await db.insert(users).values({
            tenantId,
            email: `${crypto.randomUUID()}@example.test`,
            role: "owner",
        }).returning().then((rows) => rows[0]!);
        const borrower = await db.insert(borrowers).values({
            tenantId,
            ownerUserId: actor.id,
            name: "Floating settlement borrower",
        }).returning().then((rows) => rows[0]!);
        const loan = await db.insert(loans).values({
            tenantId,
            ownerUserId: actor.id,
            borrowerId: borrower.id,
            principalAmount: "5000.00",
            outstandingPrincipal: "5000.00",
            outstandingInterest: "0.00",
            outstandingFees: "0.00",
            interestRate: "0.00",
            repaymentType: "floating",
            termMonths: 1,
            startDate: "2026-08-10",
            status: "active",
        }).returning().then((rows) => rows[0]!);

        const response = await new Elysia().use(loansRoute).handle(new Request(
            `http://localhost/loans/${loan.publicId}/closing-summary`,
            { headers: { authorization: `Bearer ${await authToken(actor)}` } },
        ));

        expect(response.status).toBe(409);
        expect(await response.json()).toEqual({
            error: "Floating loans require the preview-and-execute settlement workflow",
            code: "FLOATING_SETTLEMENT_REQUIRED",
        });
    });
});
