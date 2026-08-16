import { beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { Elysia } from "elysia";
import { db } from "../db";
import { borrowers, loanDisbursements, loans, transactions, users } from "../db/schema";
import { loansRoute } from "./loans";

type TestUser = typeof users.$inferSelect & { role: "owner" };
const integrationTest = process.env.TEST_DATABASE_URL ? test : test.skip;

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

async function resetApplicationTables() {
    await db.execute(sql`TRUNCATE TABLE loan_disbursements, transactions, loans, borrowers, users RESTART IDENTITY CASCADE`);
}

async function seedLoan(owner: TestUser, name: string) {
    const borrower = await db.insert(borrowers).values({
        tenantId: owner.tenantId,
        ownerUserId: owner.id,
        name,
    }).returning().then((rows) => rows[0]!);
    return db.insert(loans).values({
        tenantId: owner.tenantId,
        ownerUserId: owner.id,
        borrowerId: borrower.id,
        principalAmount: "5000.00",
        interestRate: "1.00",
        repaymentType: "floating",
        status: "active",
    }).returning().then((rows) => rows[0]!);
}

describe("GET /loans received totals", () => {
    if (process.env.TEST_DATABASE_URL) beforeEach(resetApplicationTables);

    integrationTest("returns grouped exact receipt summaries for visible loans only", async () => {
        const owner = await db.insert(users).values({
            tenantId: "tenant-visible",
            email: "owner@example.test",
            role: "owner",
        }).returning().then((rows) => rows[0] as TestUser);
        const foreignOwner = await db.insert(users).values({
            tenantId: "tenant-foreign",
            email: "foreign@example.test",
            role: "owner",
        }).returning().then((rows) => rows[0] as TestUser);
        const visibleLoan = await seedLoan(owner, "Visible with receipts");
        const emptyLoan = await seedLoan(owner, "Visible without receipts");
        const foreignLoan = await seedLoan(foreignOwner, "Foreign");

        await db.insert(loanDisbursements).values({
            tenantId: owner.tenantId,
            loanId: visibleLoan.id,
            grossPrincipal: "5000.00",
            firstDayInterestDeducted: "100.00",
            netDisbursement: "4900.00",
            createdByUserId: owner.id,
        });
        const repayment = await db.insert(transactions).values({
            tenantId: owner.tenantId,
            ownerUserId: owner.id,
            loanId: visibleLoan.id,
            amount: "550.00",
            principalComponent: "400.00",
            interestComponent: "50.00",
            feeComponent: "50.00",
            penaltyComponent: "50.00",
            entryType: "repayment",
            postedAt: new Date("2026-08-16T12:00:00+07:00"),
        }).returning().then((rows) => rows[0]!);
        await db.insert(transactions).values({
            tenantId: owner.tenantId,
            ownerUserId: owner.id,
            loanId: visibleLoan.id,
            amount: "-50.00",
            principalComponent: "-25.00",
            interestComponent: "-25.00",
            entryType: "reversal",
            reversedTransactionId: repayment.id,
            postedAt: new Date("2026-08-16T13:00:00+07:00"),
        });
        await db.insert(loanDisbursements).values({
            tenantId: foreignOwner.tenantId,
            loanId: foreignLoan.id,
            grossPrincipal: "5000.00",
            firstDayInterestDeducted: "999.00",
            netDisbursement: "4001.00",
            createdByUserId: foreignOwner.id,
        });

        let requestCount = 0;
        const app = new Elysia().use(loansRoute);
        requestCount += 1;
        const response = await app.handle(new Request("http://localhost/loans", {
            headers: { authorization: `Bearer ${await tokenFor(owner)}` },
        }));
        const body = await response.json() as Array<Record<string, unknown>>;

        expect(response.status).toBe(200);
        expect(requestCount).toBe(1);
        expect(body.find((row) => row.publicId === visibleLoan.publicId)).toMatchObject({
            publicId: visibleLoan.publicId,
            interestReceived: "125.00",
            paidToDate: "600.00",
        });
        expect(body.find((row) => row.publicId === emptyLoan.publicId)).toMatchObject({
            publicId: emptyLoan.publicId,
            interestReceived: "0.00",
            paidToDate: "0.00",
        });
        expect(body.some((row) => row.publicId === foreignLoan.publicId)).toBe(false);
    });
});
