import { beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { db } from "../db";
import { borrowers, loanInterestRatePeriods, loans, users } from "./schema";

const integrationEnabled = Boolean(process.env.TEST_DATABASE_URL);
const integrationTest = integrationEnabled ? test : test.skip;

async function resetTables() {
    await db.execute(sql`SET client_min_messages TO WARNING`);
    await db.execute(sql`TRUNCATE TABLE loan_interest_rate_previews, loan_interest_accruals, loan_interest_rate_periods, loans, borrowers, users RESTART IDENTITY CASCADE`);
}

async function seedLoan(tenantId: string, suffix: string) {
    const actor = await db.insert(users).values({ tenantId, email: `${tenantId}-${suffix}@rate-period.test`, role: "owner" }).returning().then((rows) => rows[0]!);
    const borrower = await db.insert(borrowers).values({ tenantId, ownerUserId: actor.id, name: `${tenantId} Borrower` }).returning().then((rows) => rows[0]!);
    const loan = await db.insert(loans).values({
        tenantId, ownerUserId: actor.id, borrowerId: borrower.id,
        principalAmount: "1000.00", interestRate: "0.00", repaymentType: "floating",
        outstandingPrincipal: "1000.00", status: "active",
    }).returning().then((rows) => rows[0]!);
    return { actor, loan };
}

describe("floating interest rate period migration", () => {
    if (integrationEnabled) beforeEach(resetTables);

    integrationTest("rejects overlapping inclusive periods for the same tenant loan", async () => {
        const { actor, loan } = await seedLoan("tenant-a", "overlap");
        await db.insert(loanInterestRatePeriods).values({
            tenantId: "tenant-a", loanId: loan.id, effectiveDate: "2026-08-01", expiryDate: "2026-08-31",
            rateType: "per_thousand", rate: "15.0000", createdByUserId: actor.id,
        });

        const insertOverlap = async () => db.insert(loanInterestRatePeriods).values({
            tenantId: "tenant-a", loanId: loan.id, effectiveDate: "2026-08-31", expiryDate: null,
            rateType: "percent", rate: "1.0000", createdByUserId: actor.id,
        }).returning();

        await expect(insertOverlap()).rejects.toMatchObject({ cause: { code: "23P01" } });
    });

    integrationTest("allows the same date range on different loans", async () => {
        const first = await seedLoan("tenant-a", "first");
        const second = await seedLoan("tenant-a", "second");

        await db.insert(loanInterestRatePeriods).values([
            { tenantId: "tenant-a", loanId: first.loan.id, effectiveDate: "2026-08-01", expiryDate: null, rateType: "percent", rate: "1.0000", createdByUserId: first.actor.id },
            { tenantId: "tenant-a", loanId: second.loan.id, effectiveDate: "2026-08-01", expiryDate: null, rateType: "percent", rate: "1.0000", createdByUserId: second.actor.id },
        ]);

        expect(await db.select().from(loanInterestRatePeriods)).toHaveLength(2);
    });

    integrationTest("rejects rates with more than four decimal places", async () => {
        const { actor, loan } = await seedLoan("tenant-a", "precision");
        const insertInvalidRate = async () => db.insert(loanInterestRatePeriods).values({
            tenantId: "tenant-a", loanId: loan.id, effectiveDate: "2026-08-01", expiryDate: null,
            rateType: "percent", rate: "1.00001", createdByUserId: actor.id,
        }).returning();

        await expect(insertInvalidRate()).rejects.toMatchObject({ cause: { code: "23514" } });
    });
});
