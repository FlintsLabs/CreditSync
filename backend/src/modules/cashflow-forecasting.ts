import { Elysia } from "elysia";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import Decimal from "decimal.js";
import { db } from "../db";
import { loanSchedules, bankLoanSchedules } from "../db/schema";
import { authPlugin } from "../middleware/auth";
import { isTenantAdminUser } from "../lib/access";

function todayString() {
    return new Date().toISOString().slice(0, 10);
}

function daysFromNowString(days: number) {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
}

export const cashflowForecastingRoute = new Elysia({ prefix: "/cashflow-forecasting" })
    .use(authPlugin)
    .get("/", async ({ user, set }) => {
        if (!isTenantAdminUser(user)) {
            set.status = user ? 403 : 401;
            return { error: user ? "Forbidden" : "Unauthorized" };
        }

        const today = todayString();
        const thirtyDaysFromNow = daysFromNowString(30);

        // Fetch borrower expected collections (Inflows)
        const expectedCollectionsResult = await db
            .select({
                dueDate: loanSchedules.dueDate,
                totalAmount: sql<number>`cast(coalesce(sum(${loanSchedules.remainingDue}), 0) as float)`,
            })
            .from(loanSchedules)
            .where(
                and(
                    eq(loanSchedules.tenantId, user.tenantId),
                    gte(loanSchedules.dueDate, today),
                    lte(loanSchedules.dueDate, thirtyDaysFromNow)
                )
            )
            .groupBy(loanSchedules.dueDate)
            .orderBy(loanSchedules.dueDate);

        // Fetch bank payments (Outflows)
        const upcomingBankPaymentsResult = await db
            .select({
                dueDate: bankLoanSchedules.dueDate,
                totalAmount: sql<number>`cast(coalesce(sum(${bankLoanSchedules.remainingDue}), 0) as float)`,
            })
            .from(bankLoanSchedules)
            .where(
                and(
                    eq(bankLoanSchedules.tenantId, user.tenantId),
                    gte(bankLoanSchedules.dueDate, today),
                    lte(bankLoanSchedules.dueDate, thirtyDaysFromNow)
                )
            )
            .groupBy(bankLoanSchedules.dueDate)
            .orderBy(bankLoanSchedules.dueDate);

        const dataMap = new Map<string, { expectedCollection: string; upcomingBankPayment: string }>();

        // Initialize all 30 days
        for (let i = 0; i <= 30; i++) {
            const dateStr = daysFromNowString(i);
            dataMap.set(dateStr, { expectedCollection: "0.00", upcomingBankPayment: "0.00" });
        }

        expectedCollectionsResult.forEach(item => {
            if (item.dueDate && dataMap.has(item.dueDate)) {
                dataMap.get(item.dueDate)!.expectedCollection = new Decimal(item.totalAmount).toFixed(2);
            }
        });

        upcomingBankPaymentsResult.forEach(item => {
            if (item.dueDate && dataMap.has(item.dueDate)) {
                dataMap.get(item.dueDate)!.upcomingBankPayment = new Decimal(item.totalAmount).toFixed(2);
            }
        });

        const sortedData = Array.from(dataMap.entries())
            .map(([date, values]) => ({
                date,
                ...values
            }))
            .sort((a, b) => a.date.localeCompare(b.date));

        return sortedData;
    });
