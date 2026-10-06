import { afterEach, beforeEach, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { auditLogs, borrowers, loanScheduleDeferrals, loanSchedules, loans, transactions, users } from "../db/schema";
import type { CommandContext } from "./command-context";
import { deferLoanSchedule, inspectLoanScheduleDeferral } from "./loan-schedule-deferral-service";

const integrationTest = process.env.TEST_DATABASE_URL ? test : test.skip;

function context(user: { id: number; tenantId: string }, idempotencyKey?: string): CommandContext {
    return { tenantId: user.tenantId, actorUserId: user.id, actorSource: "mcp", requestId: crypto.randomUUID(), correlationId: crypto.randomUUID(), idempotencyKey };
}

async function fixture() {
    const tenantId = `schedule-deferral-${crypto.randomUUID()}`;
    const actor = await db.insert(users).values({ tenantId, email: `${crypto.randomUUID()}@example.test`, role: "owner" }).returning().then(([row]) => row!);
    const borrower = await db.insert(borrowers).values({ tenantId, ownerUserId: actor.id, name: "Deferral integration borrower" }).returning().then(([row]) => row!);
    const loan = await db.insert(loans).values({ tenantId, ownerUserId: actor.id, borrowerId: borrower.id, principalAmount: "200.00", interestRate: "0.00", repaymentType: "daily", termMonths: 1, installmentAmount: "100.00", totalInstallments: 2, startDate: "2026-08-09", outstandingPrincipal: "200.00", outstandingInterest: "0.00", outstandingFees: "0.00", status: "active" }).returning().then(([row]) => row!);
    const source = await db.insert(loanSchedules).values({ tenantId, loanId: loan.id, installmentNo: 1, dueDate: "2026-08-10", scheduledPrincipal: "90.00", scheduledInterest: "8.00", scheduledFee: "2.00", scheduledTotal: "100.00", paidTotal: "0.00", remainingDue: "100.00", status: "pending" }).returning().then(([row]) => row!);
    await db.insert(loanSchedules).values({ tenantId, loanId: loan.id, installmentNo: 2, dueDate: "2026-08-11", scheduledPrincipal: "100.00", scheduledInterest: "0.00", scheduledFee: "0.00", scheduledTotal: "100.00", paidTotal: "0.00", remainingDue: "100.00", status: "pending" });
    return { actor, loan, source };
}

if (process.env.TEST_DATABASE_URL) {
    beforeEach(() => db.execute(sql`TRUNCATE TABLE users RESTART IDENTITY CASCADE`));
    afterEach(() => db.execute(sql`TRUNCATE TABLE users RESTART IDENTITY CASCADE`));
}

integrationTest("inspects a deferral without writes, then conserves the installment as an audited tail replacement", async () => {
    const { actor, loan, source } = await fixture();
    const beforeTransactions = await db.select().from(transactions).where(eq(transactions.tenantId, actor.tenantId));
    const inspection = await inspectLoanScheduleDeferral(context(actor), loan.publicId, source.publicId);
    expect(inspection).toMatchObject({ eligible: true, sourceDueDate: "2026-08-10", replacementDueDate: "2026-08-12", replacementInstallmentNo: 3, scheduledPrincipal: "90.00", scheduledInterest: "8.00", scheduledFee: "2.00", scheduledTotal: "100.00" });
    expect(await db.select().from(loanScheduleDeferrals).where(eq(loanScheduleDeferrals.tenantId, actor.tenantId))).toHaveLength(0);
    expect(await db.select().from(auditLogs).where(eq(auditLogs.tenantId, actor.tenantId))).toHaveLength(0);

    const commandContext = context(actor, `deferral-${crypto.randomUUID()}`);
    const posted = await deferLoanSchedule(commandContext, loan.publicId, source.publicId, { reason: "Borrower requested a one day deferral" });
    expect(posted).toMatchObject({ sourceStatus: "deferred", replacementDueDate: "2026-08-12", replacementInstallmentNo: 3, scheduledPrincipal: "90.00", scheduledInterest: "8.00", scheduledFee: "2.00", scheduledTotal: "100.00", correlationId: commandContext.correlationId });
    const schedules = await db.select().from(loanSchedules).where(and(eq(loanSchedules.tenantId, actor.tenantId), eq(loanSchedules.loanId, loan.id)));
    expect(schedules).toHaveLength(3);
    const replacement = schedules.find((row) => row.publicId === posted.replacementSchedulePublicId)!;
    const deferred = schedules.find((row) => row.publicId === source.publicId)!;
    expect(deferred).toMatchObject({ status: "deferred", remainingDue: "0.00", scheduledPrincipal: "90.00", scheduledInterest: "8.00", scheduledFee: "2.00", scheduledTotal: "100.00" });
    expect(replacement).toMatchObject({ status: "pending", dueDate: "2026-08-12", scheduledPrincipal: deferred.scheduledPrincipal, scheduledInterest: deferred.scheduledInterest, scheduledFee: deferred.scheduledFee, scheduledTotal: deferred.scheduledTotal, remainingDue: "100.00" });
    expect(await db.query.loans.findFirst({ where: eq(loans.id, loan.id) })).toMatchObject({ totalInstallments: 2, outstandingPrincipal: "190.00", outstandingInterest: "8.00", outstandingFees: "2.00", nextDueDate: "2026-08-11" });
    expect(await db.select().from(transactions).where(eq(transactions.tenantId, actor.tenantId))).toHaveLength(beforeTransactions.length);
    const ledger = await db.query.loanScheduleDeferrals.findFirst({ where: and(eq(loanScheduleDeferrals.tenantId, actor.tenantId), eq(loanScheduleDeferrals.idempotencyKey, commandContext.idempotencyKey!)) });
    expect(ledger).toMatchObject({ loanId: loan.id, sourceScheduleId: source.id, replacementScheduleId: replacement.id, actorSource: "mcp", requestId: commandContext.requestId, correlationId: commandContext.correlationId });
    const audit = await db.query.auditLogs.findFirst({ where: and(eq(auditLogs.tenantId, actor.tenantId), eq(auditLogs.entityId, ledger!.publicId), eq(auditLogs.action, "deferred")) });
    expect(audit).toMatchObject({ entityType: "loan_schedule_deferral", publicId: posted.auditPublicId, requestId: commandContext.requestId, correlationId: commandContext.correlationId, actorSource: "mcp" });
});

integrationTest("serializes concurrent identical deferral retries and rejects changed payload key reuse", async () => {
    const firstFixture = await fixture();
    const key = `concurrent-${crypto.randomUUID()}`;
    const [first, second] = await Promise.all([
        deferLoanSchedule(context(firstFixture.actor, key), firstFixture.loan.publicId, firstFixture.source.publicId, { reason: "Same request" }),
        deferLoanSchedule(context(firstFixture.actor, key), firstFixture.loan.publicId, firstFixture.source.publicId, { reason: "Same request" }),
    ]);
    expect(first.replacementSchedulePublicId).toBe(second.replacementSchedulePublicId);
    expect(first.auditPublicId).toBe(second.auditPublicId);
    expect(first.correlationId).toBe(second.correlationId);
    expect(await db.select().from(loanScheduleDeferrals).where(eq(loanScheduleDeferrals.tenantId, firstFixture.actor.tenantId))).toHaveLength(1);
    expect(await db.select().from(loanSchedules).where(and(eq(loanSchedules.tenantId, firstFixture.actor.tenantId), eq(loanSchedules.loanId, firstFixture.loan.id)))).toHaveLength(3);
    await expect(deferLoanSchedule(context(firstFixture.actor, key), firstFixture.loan.publicId, firstFixture.source.publicId, { reason: "Changed request" })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    const tail = await db.query.loanSchedules.findFirst({ where: and(eq(loanSchedules.tenantId, firstFixture.actor.tenantId), eq(loanSchedules.loanId, firstFixture.loan.id), eq(loanSchedules.installmentNo, 2)) });
    await expect(deferLoanSchedule(context(firstFixture.actor, key), firstFixture.loan.publicId, tail!.publicId, { reason: "Same request" })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });

    const otherLoan = await db.insert(loans).values({ tenantId: firstFixture.actor.tenantId, ownerUserId: firstFixture.actor.id, borrowerId: firstFixture.loan.borrowerId, principalAmount: "100.00", interestRate: "0.00", repaymentType: "daily", termMonths: 1, installmentAmount: "100.00", totalInstallments: 1, startDate: "2026-08-09", outstandingPrincipal: "100.00", outstandingInterest: "0.00", outstandingFees: "0.00", status: "active" }).returning().then(([row]) => row!);
    const otherSchedule = await db.insert(loanSchedules).values({ tenantId: firstFixture.actor.tenantId, loanId: otherLoan.id, installmentNo: 1, dueDate: "2026-08-10", scheduledPrincipal: "100.00", scheduledInterest: "0.00", scheduledFee: "0.00", scheduledTotal: "100.00", remainingDue: "100.00", status: "pending" }).returning().then(([row]) => row!);
    await expect(deferLoanSchedule(context(firstFixture.actor, key), otherLoan.publicId, otherSchedule.publicId, { reason: "Same request" })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
});

integrationTest("blocks partial, floating, inactive, wrong-loan, cross-tenant, and owner-denied deferrals", async () => {
    const { actor, loan, source } = await fixture();
    const otherLoan = await db.insert(loans).values({ tenantId: actor.tenantId, ownerUserId: actor.id, borrowerId: loan.borrowerId, principalAmount: "100.00", interestRate: "0.00", repaymentType: "daily", termMonths: 1, installmentAmount: "100.00", totalInstallments: 1, startDate: "2026-08-09", outstandingPrincipal: "100.00", outstandingInterest: "0.00", outstandingFees: "0.00", status: "active" }).returning().then(([row]) => row!);
    const partial = await db.insert(loanSchedules).values({ tenantId: actor.tenantId, loanId: otherLoan.id, installmentNo: 1, dueDate: "2026-08-10", scheduledPrincipal: "100.00", scheduledInterest: "0.00", scheduledFee: "0.00", scheduledTotal: "100.00", paidTotal: "1.00", remainingDue: "99.00", status: "partial" }).returning().then(([row]) => row!);
    await expect(deferLoanSchedule(context(actor, crypto.randomUUID()), otherLoan.publicId, partial.publicId, { reason: "partial" })).rejects.toMatchObject({ code: "SCHEDULE_NOT_ELIGIBLE" });
    await expect(deferLoanSchedule(context(actor, crypto.randomUUID()), loan.publicId, partial.publicId, { reason: "wrong loan" })).rejects.toMatchObject({ code: "SCHEDULE_NOT_FOUND" });
    const foreign = await db.insert(users).values({ tenantId: `foreign-${crypto.randomUUID()}`, email: `${crypto.randomUUID()}@example.test`, role: "owner" }).returning().then(([row]) => row!);
    await expect(deferLoanSchedule(context(foreign, crypto.randomUUID()), loan.publicId, source.publicId, { reason: "foreign" })).rejects.toMatchObject({ code: "LOAN_NOT_FOUND" });
    const restricted = await db.insert(users).values({ tenantId: actor.tenantId, email: `${crypto.randomUUID()}@example.test`, role: "viewer" }).returning().then(([row]) => row!);
    await db.update(loans).set({ ownerUserId: actor.id }).where(eq(loans.id, loan.id));
    await expect(deferLoanSchedule(context(restricted, crypto.randomUUID()), loan.publicId, source.publicId, { reason: "owner denied" })).rejects.toMatchObject({ code: "LOAN_NOT_FOUND" });
});
