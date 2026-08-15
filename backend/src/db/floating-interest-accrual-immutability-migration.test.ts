import { beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { db } from "../db";
import { borrowers, loanInterestAccruals, loans, users } from "./schema";

const integrationEnabled = Boolean(process.env.TEST_DATABASE_URL);
const integrationTest = integrationEnabled ? test : test.skip;

async function resetTables() {
    await db.execute(sql`SET client_min_messages TO WARNING`);
    await db.execute(sql`TRUNCATE TABLE loan_interest_accruals, loans, borrowers, users RESTART IDENTITY CASCADE`);
}

async function seedAccrual(suffix: string) {
    const tenantId = `tenant-accrual-immutable-${suffix}`;
    const actor = await db.insert(users).values({
        tenantId,
        email: `${suffix}@accrual-immutable.test`,
        role: "owner",
    }).returning().then((rows) => rows[0]!);
    const borrower = await db.insert(borrowers).values({
        tenantId,
        ownerUserId: actor.id,
        name: `Immutable ${suffix}`,
    }).returning().then((rows) => rows[0]!);
    const loan = await db.insert(loans).values({
        tenantId,
        ownerUserId: actor.id,
        borrowerId: borrower.id,
        principalAmount: "1000.00",
        interestRate: "0.00",
        repaymentType: "floating",
        outstandingPrincipal: "1000.00",
        status: "active",
    }).returning().then((rows) => rows[0]!);
    const accrual = await db.insert(loanInterestAccruals).values({
        tenantId,
        loanId: loan.id,
        accrualDate: "2026-08-14",
        openingPrincipal: "1000.00",
        rateMode: "percent",
        rate: "1.0000",
        interestAmount: "10.00",
        paidAmount: "0.00",
        status: "accrued",
        createdByUserId: actor.id,
    }).returning().then((rows) => rows[0]!);
    return { tenantId, actor, loan, accrual };
}

test("registers the additive accrual immutability trigger migration", async () => {
    // Break caught: the migration or journal entry is omitted, or the trigger
    // accidentally permits fields beyond the two service-owned lifecycle fields.
    const [journal, migration] = await Promise.all([
        Bun.file(new URL("../../drizzle/meta/_journal.json", import.meta.url)).text(),
        Bun.file(new URL("../../drizzle/0036_floating_weekly_intermediary_integration.sql", import.meta.url)).text(),
    ]);

    expect(JSON.parse(journal).entries.map((entry: { tag: string }) => entry.tag))
        .toContain("0036_floating_weekly_intermediary_integration");
    expect(migration).toContain("enforce_loan_interest_accrual_immutability");
    expect(migration).toContain("BEFORE UPDATE OR DELETE ON loan_interest_accruals");
    expect(migration).toContain("to_jsonb(NEW) - 'status' - 'paid_amount'");
    expect(migration).toContain("financial records are append-only");
});

describe("floating interest accrual database immutability", () => {
    if (integrationEnabled) beforeEach(resetTables);

    integrationTest("rejects updates to immutable accrual facts", async () => {
        const { accrual } = await seedAccrual("update");
        const mutate = async () => db.execute(sql`
            UPDATE loan_interest_accruals
            SET opening_principal = 999.00, interest_amount = 9.99
            WHERE id = ${accrual.id}
        `);

        await expect(mutate()).rejects.toMatchObject({ cause: { code: "P0001" } });
        expect(await db.query.loanInterestAccruals.findFirst({ where: eq(loanInterestAccruals.id, accrual.id) }))
            .toMatchObject({ openingPrincipal: "1000.00", interestAmount: "10.00" });
    });

    integrationTest("rejects deletion of accrual history", async () => {
        const { accrual } = await seedAccrual("delete");
        const remove = async () => db.execute(sql`DELETE FROM loan_interest_accruals WHERE id = ${accrual.id}`);

        await expect(remove()).rejects.toMatchObject({ cause: { code: "P0001" } });
        expect(await db.select().from(loanInterestAccruals).where(eq(loanInterestAccruals.id, accrual.id)))
            .toHaveLength(1);
    });

    integrationTest("allows lifecycle status changes and compensating replacement inserts", async () => {
        const { tenantId, actor, loan, accrual } = await seedAccrual("lifecycle");
        await db.update(loanInterestAccruals).set({ status: "reversed" })
            .where(eq(loanInterestAccruals.id, accrual.id));
        const replacement = await db.insert(loanInterestAccruals).values({
            tenantId,
            loanId: loan.id,
            accrualDate: accrual.accrualDate,
            openingPrincipal: "900.00",
            rateMode: accrual.rateMode,
            rate: accrual.rate,
            interestAmount: "9.00",
            paidAmount: "0.00",
            status: "accrued",
            reversedAccrualId: accrual.id,
            createdByUserId: actor.id,
        }).returning().then((rows) => rows[0]!);

        expect(await db.query.loanInterestAccruals.findFirst({ where: eq(loanInterestAccruals.id, accrual.id) }))
            .toMatchObject({ paidAmount: "0.00", status: "reversed", openingPrincipal: "1000.00", interestAmount: "10.00" });
        expect(replacement).toMatchObject({
            reversedAccrualId: accrual.id,
            openingPrincipal: "900.00",
            interestAmount: "9.00",
            paidAmount: "0.00",
            status: "accrued",
        });
    });
});
