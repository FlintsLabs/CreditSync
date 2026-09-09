import { expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { auditLogs, borrowers, loanSchedules, loans, users } from "../db/schema";
import type { CommandContext } from "./command-context";
import { updateLoanPaymentStartDate } from "./loan-application-service";

const integrationTest = process.env.TEST_DATABASE_URL ? test : test.skip;

async function resetLoanPaymentStartDateTables() {
    await db.execute(sql`TRUNCATE TABLE audit_logs, loan_schedules, loans, borrowers, users RESTART IDENTITY CASCADE`);
}

async function seedActiveDailyLoan() {
    const tenantId = `tenant-payment-start-date-${crypto.randomUUID()}`;
    const actor = await db.insert(users).values({ tenantId, email: `${crypto.randomUUID()}@example.test`, role: "owner" }).returning().then((rows) => rows[0]!);
    const borrower = await db.insert(borrowers).values({ tenantId, ownerUserId: actor.id, name: "Payment start date borrower" }).returning().then((rows) => rows[0]!);
    const loan = await db.insert(loans).values({
        tenantId,
        ownerUserId: actor.id,
        borrowerId: borrower.id,
        principalAmount: "20000.00",
        outstandingPrincipal: "20000.00",
        outstandingInterest: "10000.00",
        outstandingFees: "0.00",
        interestRate: "0.00",
        repaymentType: "daily",
        startDate: "2026-08-22",
        termMonths: 4,
        totalInstallments: 100,
        installmentAmount: "300.00",
        dailyTermUnit: "days",
        dailyTermValue: 100,
        dailyEntryMode: "daily_payment",
        dailyFlatRatePercent: "0.5000",
        status: "active",
    }).returning().then((rows) => rows[0]!);
    await db.insert(loanSchedules).values([1, 2].map((installmentNo) => ({
        tenantId,
        loanId: loan.id,
        installmentNo,
        dueDate: installmentNo === 1 ? "2026-08-23" : "2026-08-24",
        scheduledPrincipal: "200.00",
        scheduledInterest: "100.00",
        scheduledFee: "0.00",
        scheduledTotal: "300.00",
        paidTotal: "0.00",
        remainingDue: "300.00",
        status: "pending",
    })));
    const context: CommandContext = {
        tenantId,
        actorUserId: actor.id,
        actorSource: "mcp",
        requestId: `request-${crypto.randomUUID()}`,
        correlationId: crypto.randomUUID(),
        idempotencyKey: `payment-start-date-${crypto.randomUUID()}`,
    };
    return { context, loan, tenantId };
}

integrationTest("amends unpaid active daily schedule dates with an auditable same-day first repayment", async () => {
    await resetLoanPaymentStartDateTables();
    const seeded = await seedActiveDailyLoan();

    const result = await updateLoanPaymentStartDate(seeded.context, seeded.loan.publicId, {
        paymentStartDate: "2026-08-22",
        reason: "Count the first daily installment on the contract start date",
    });

    expect(result.paymentStartDate).toBe("2026-08-22");
    expect(result.nextDueDate).toBe("2026-08-22");
    const schedule = await db.select().from(loanSchedules).where(and(
        eq(loanSchedules.tenantId, seeded.tenantId),
        eq(loanSchedules.loanId, seeded.loan.id),
    )).orderBy(loanSchedules.installmentNo);
    expect(schedule.map((row) => row.dueDate)).toEqual(["2026-08-22", "2026-08-23"]);
    const loan = await db.query.loans.findFirst({ where: eq(loans.id, seeded.loan.id) });
    expect(loan?.nextDueDate).toBe("2026-08-22");
    const audit = await db.query.auditLogs.findFirst({ where: eq(auditLogs.publicId, result.auditPublicId) });
    expect(audit?.action).toBe("payment_start_date_changed");
    expect(audit?.payload).toMatchObject({
        before: { paymentStartDate: null },
        after: { paymentStartDate: "2026-08-22" },
        changedSchedule: [
            { installmentNo: 1, before: "2026-08-23", after: "2026-08-22" },
            { installmentNo: 2, before: "2026-08-24", after: "2026-08-23" },
        ],
    });
    let directMutationError: unknown;
    try {
        await db.update(loanSchedules).set({ dueDate: "2026-08-24" }).where(and(
            eq(loanSchedules.tenantId, seeded.tenantId),
            eq(loanSchedules.loanId, seeded.loan.id),
            eq(loanSchedules.installmentNo, 1),
        ));
    } catch (error) {
        directMutationError = error;
    }
    expect(directMutationError).toBeTruthy();
    expect((directMutationError as { cause?: Error }).cause?.message).toContain("activated loan schedule contractual fields are immutable");
});
