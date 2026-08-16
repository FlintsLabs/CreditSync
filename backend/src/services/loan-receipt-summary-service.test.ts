import { beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { db } from "../db";
import { borrowers, loanDisbursements, loans, transactions, users } from "../db/schema";
import { DomainError } from "./domain-error";
import { getLoanReceiptSummaries } from "./loan-receipt-summary-service";

const integrationTest = process.env.TEST_DATABASE_URL ? test : test.skip;

async function resetApplicationTables() {
    await db.execute(sql`TRUNCATE TABLE loan_disbursements, transactions, loans, borrowers, users RESTART IDENTITY CASCADE`);
}

async function seedLoan(tenantId: string, suffix: string) {
    const owner = await db.insert(users).values({
        tenantId,
        email: `owner-${suffix}@example.test`,
        role: "owner",
    }).returning().then((rows) => rows[0]!);
    const borrower = await db.insert(borrowers).values({
        tenantId,
        ownerUserId: owner.id,
        name: `Borrower ${suffix}`,
    }).returning().then((rows) => rows[0]!);
    const loan = await db.insert(loans).values({
        tenantId,
        ownerUserId: owner.id,
        borrowerId: borrower.id,
        principalAmount: "5000.00",
        interestRate: "1.00",
        repaymentType: "floating",
        status: "active",
    }).returning().then((rows) => rows[0]!);
    return { owner, loan };
}

describe("getLoanReceiptSummaries", () => {
    if (process.env.TEST_DATABASE_URL) beforeEach(resetApplicationTables);

    test("returns an empty map without querying when no loan IDs are requested", async () => {
        const executor = {
            select() {
                throw new Error("Expected no database query");
            },
        };
        expect(await getLoanReceiptSummaries(executor, "tenant-empty", [])).toEqual(new Map());
    });

    integrationTest("combines advance deductions with signed posted receipt components", async () => {
        const { owner, loan } = await seedLoan("tenant-visible", "visible");
        await db.insert(loanDisbursements).values({
            tenantId: owner.tenantId,
            loanId: loan.id,
            grossPrincipal: "5000.00",
            firstDayInterestDeducted: "600.00",
            netDisbursement: "4400.00",
            createdByUserId: owner.id,
        });
        const repayment = await db.insert(transactions).values({
            tenantId: owner.tenantId,
            ownerUserId: owner.id,
            loanId: loan.id,
            amount: "1000.00",
            principalComponent: "700.00",
            interestComponent: "200.00",
            feeComponent: "50.00",
            penaltyComponent: "50.00",
            entryType: "repayment",
            postedAt: new Date("2026-08-16T12:00:00+07:00"),
        }).returning().then((rows) => rows[0]!);
        await db.insert(transactions).values({
            tenantId: owner.tenantId,
            ownerUserId: owner.id,
            loanId: loan.id,
            amount: "-400.00",
            principalComponent: "-300.00",
            interestComponent: "-50.00",
            feeComponent: "-25.00",
            penaltyComponent: "-25.00",
            entryType: "reversal",
            reversedTransactionId: repayment.id,
            postedAt: new Date("2026-08-16T13:00:00+07:00"),
        });

        expect((await getLoanReceiptSummaries(db, owner.tenantId, [loan.id])).get(loan.id)).toEqual({
            interestReceived: "750.00",
            paidToDate: "1200.00",
        });
    });

    integrationTest("returns exact zero for an empty requested loan without leaking another tenant", async () => {
        const visible = await seedLoan("tenant-visible", "empty");
        const foreign = await seedLoan("tenant-foreign", "foreign");
        await db.insert(loanDisbursements).values({
            tenantId: foreign.owner.tenantId,
            loanId: foreign.loan.id,
            grossPrincipal: "999.00",
            firstDayInterestDeducted: "99.00",
            netDisbursement: "900.00",
            createdByUserId: foreign.owner.id,
        });

        const summaries = await getLoanReceiptSummaries(db, visible.owner.tenantId, [visible.loan.id]);
        expect(summaries.get(visible.loan.id)).toEqual({ interestReceived: "0.00", paidToDate: "0.00" });
        expect(summaries.has(foreign.loan.id)).toBe(false);
    });

    integrationTest("retains exact cents for 29-integer-digit components", async () => {
        const { owner, loan } = await seedLoan("tenant-large", "large");
        await db.insert(loanDisbursements).values({
            tenantId: owner.tenantId,
            loanId: loan.id,
            grossPrincipal: "10000000000000000000000000000.10",
            firstDayInterestDeducted: "10000000000000000000000000000.10",
            netDisbursement: "0.00",
            createdByUserId: owner.id,
        });
        await db.insert(transactions).values({
            tenantId: owner.tenantId,
            ownerUserId: owner.id,
            loanId: loan.id,
            amount: "0.50",
            principalComponent: "0.20",
            interestComponent: "0.10",
            feeComponent: "0.10",
            penaltyComponent: "0.10",
            entryType: "repayment",
            postedAt: new Date("2026-08-16T12:00:00+07:00"),
        });

        expect((await getLoanReceiptSummaries(db, owner.tenantId, [loan.id])).get(loan.id)).toEqual({
            interestReceived: "10000000000000000000000000000.20",
            paidToDate: "10000000000000000000000000000.60",
        });
    });

    integrationTest("rejects reversal-only negative cumulative totals", async () => {
        const { owner, loan } = await seedLoan("tenant-negative", "negative");
        const sourceLoan = await seedLoan("tenant-negative", "negative-source");
        const repayment = await db.insert(transactions).values({
            tenantId: owner.tenantId,
            ownerUserId: owner.id,
            loanId: sourceLoan.loan.id,
            amount: "1.00",
            principalComponent: "0.50",
            interestComponent: "0.50",
            entryType: "repayment",
        }).returning().then((rows) => rows[0]!);
        await db.insert(transactions).values({
            tenantId: owner.tenantId,
            ownerUserId: owner.id,
            loanId: loan.id,
            amount: "-2.00",
            principalComponent: "-1.00",
            interestComponent: "-1.00",
            entryType: "reversal",
            reversedTransactionId: repayment.id,
            postedAt: new Date("2026-08-16T13:00:00+07:00"),
        });

        try {
            await getLoanReceiptSummaries(db, owner.tenantId, [loan.id]);
            throw new Error("Expected a negative summary to fail");
        } catch (error) {
            expect(error).toBeInstanceOf(DomainError);
            expect((error as DomainError).code).toBe("LOAN_RECEIPT_SUMMARY_NEGATIVE");
        }
    });
});
