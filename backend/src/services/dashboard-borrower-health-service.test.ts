import { beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { db } from "../db";
import { borrowers, loanSchedules, loans, users } from "../db/schema";
import { getDashboardBorrowerHealth } from "./dashboard-borrower-health-service";

const integrationEnabled = Boolean(process.env.TEST_DATABASE_URL);
const integrationTest = integrationEnabled ? test : test.skip;

async function resetTables() {
    await db.execute(sql`TRUNCATE TABLE loan_interest_accruals, loan_schedules, loans, borrowers, users RESTART IDENTITY CASCADE`);
}

describe("dashboard borrower health projection", () => {
    if (integrationEnabled) beforeEach(resetTables);

    integrationTest("returns one floating loan with four overdue daily accruals alongside one overdue scheduled loan", async () => {
        const tenantId = "dashboard-health";
        const actor = await db.insert(users).values({ tenantId, email: "owner@dashboard-health.test", role: "owner" }).returning().then((rows) => rows[0]!);
        const floatingBorrower = await db.insert(borrowers).values({ tenantId, ownerUserId: actor.id, name: "Floating Borrower" }).returning().then((rows) => rows[0]!);
        const scheduledBorrower = await db.insert(borrowers).values({ tenantId, ownerUserId: actor.id, name: "Scheduled Borrower" }).returning().then((rows) => rows[0]!);

        const floatingLoan = await db.insert(loans).values({
            tenantId, ownerUserId: actor.id, borrowerId: floatingBorrower.id,
            principalAmount: "5000.00", outstandingPrincipal: "5000.00", interestRate: "0.00",
            repaymentType: "floating", dailyInterestMode: "per_thousand", dailyInterestRate: "15.0000",
            firstDayTreatment: "start_next_day", interestStartDate: "2026-08-06", status: "active",
        }).returning().then((rows) => rows[0]!);
        const scheduledLoan = await db.insert(loans).values({
            tenantId, ownerUserId: actor.id, borrowerId: scheduledBorrower.id,
            principalAmount: "1000.00", outstandingPrincipal: "1000.00", interestRate: "0.00",
            repaymentType: "daily", gracePeriodDays: 0, lateFeeMode: "none", lateFeeAmount: "0.00", status: "active",
        }).returning().then((rows) => rows[0]!);
        await db.insert(loanSchedules).values({
            tenantId, loanId: scheduledLoan.id, installmentNo: 1, dueDate: "2026-08-10",
            scheduledTotal: "125.00", remainingDue: "125.00", status: "pending",
        });

        const rows = await getDashboardBorrowerHealth(db, {
            tenantId, actorUserId: actor.id, asOf: new Date("2026-08-11T12:00:00+07:00"),
        });
        const floating = rows.find((row) => row.loanId === floatingLoan.id);

        expect(floating).toMatchObject({
            loanPublicId: floatingLoan.publicId,
            borrowerName: "Floating Borrower",
            repaymentType: "floating",
            status: "overdue",
            dueTodayAmount: "75.00",
            overdueAmount: "300.00",
            overdueItemCount: 4,
            maxOverdueDays: 4,
        });
        expect(rows.filter((row) => row.status === "overdue")).toHaveLength(2);
    });
});
