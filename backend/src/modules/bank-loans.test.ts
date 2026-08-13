import { beforeEach, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { sql } from "drizzle-orm";
import { db } from "../db";
import { bankLoans, bankProfiles, borrowers, loanFundingAllocations, loans, users } from "../db/schema";
import { invalidateTenantCache } from "../lib/cache";
import { bankLoansRoute } from "./bank-loans";

const integrationEnabled = Boolean(process.env.TEST_DATABASE_URL);
const integrationTest = integrationEnabled ? test : test.skip;
const app = new Elysia().use(bankLoansRoute);

async function resetTables() {
    await db.execute(sql`TRUNCATE TABLE loan_funding_allocations, loans, borrowers, bank_loans, bank_profiles, users RESTART IDENTITY CASCADE`);
    await invalidateTenantCache("tenant-bank-loan-allocation");
}

async function authToken(user: { id: number; email: string; role: string | null; tenantId: string }) {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const header = encode({ alg: "HS256", typ: "JWT" });
    const payload = encode({ id: user.id, email: user.email, role: user.role, tenantId: user.tenantId });
    const unsigned = `${header}.${payload}`;
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(process.env.JWT_SECRET ?? "dev_jwt_secret_change_me"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signature = Buffer.from(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(unsigned))).toString("base64url");
    return `${unsigned}.${signature}`;
}

describe("bank-loan allocation state", () => {
    if (integrationEnabled) beforeEach(resetTables);

    // Break caught: allocation-state coerces exact PostgreSQL numerics through Number and changes the public money contract.
    integrationTest("returns exact two-decimal strings beyond JavaScript's safe-integer range", async () => {
        const tenantId = "tenant-bank-loan-allocation";
        const owner = await db.insert(users).values({ tenantId, email: "bank-loan-allocation@example.test", role: "owner" }).returning().then((rows) => rows[0]!);
        const profile = await db.insert(bankProfiles).values({ tenantId, name: "Large source", type: "bank" }).returning().then((rows) => rows[0]!);
        const drawdown = await db.insert(bankLoans).values({ tenantId, bankProfileId: profile.id, amount: "9007199254741000.00" }).returning().then((rows) => rows[0]!);
        const borrower = await db.insert(borrowers).values({ tenantId, ownerUserId: owner.id, name: "Large borrower" }).returning().then((rows) => rows[0]!);
        const loan = await db.insert(loans).values({
            tenantId,
            ownerUserId: owner.id,
            borrowerId: borrower.id,
            principalAmount: "9007199254740993.10",
            interestRate: "0.00",
            repaymentType: "monthly",
            outstandingPrincipal: "9007199254740993.10",
            status: "active",
        }).returning().then((rows) => rows[0]!);
        await db.insert(loanFundingAllocations).values({
            tenantId,
            bankProfileId: profile.id,
            bankLoanId: drawdown.id,
            loanId: loan.id,
            allocatedAmount: "9007199254740993.10",
            allocationDate: "2026-08-14",
            allocationType: "initial",
        });

        const token = await authToken(owner);
        const response = await app.handle(new Request(`http://localhost/bank-loans/${drawdown.publicId}/allocation-state`, {
            headers: { Authorization: `Bearer ${token}` },
        }));
        const body = await response.json() as Record<string, unknown>;

        expect(response.status).toBe(200);
        expect(body).toMatchObject({
            drawdownAmount: "9007199254741000.00",
            netAllocatedPrincipal: "9007199254740993.10",
            remainingCapacity: "6.90",
            overallocatedAmount: "0.00",
            state: "partially_allocated",
        });
        for (const field of ["drawdownAmount", "netAllocatedPrincipal", "remainingCapacity", "overallocatedAmount"]) {
            expect(typeof body[field], field).toBe("string");
            expect(body[field], field).toMatch(/^\d+\.\d{2}$/);
        }
    });
});
