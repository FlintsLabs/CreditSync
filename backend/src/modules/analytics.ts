import { Elysia, t } from "elysia";
import { db } from "../db";
import { transactions, bankTransactions, bankLoans } from "../db/schema";
import { eq, inArray, sql, and, gte, lte } from "drizzle-orm";
import { authPlugin } from "../middleware/auth";
import dayjs from "dayjs";

export const analyticsRoute = new Elysia({ prefix: "/analytics" })
    .use(authPlugin)
    .get("/fund-performance", async ({ query, user, set }) => {
        if (!user) {
            set.status = 401;
            return { error: "Unauthorized" };
        }

        const yearsStr = query.years;
        if (!yearsStr) {
            return [];
        }

        const years = yearsStr.split(",").map(Number).filter(y => !isNaN(y));
        if (years.length === 0) {
            return [];
        }

        const tenantId = user.tenantId;

        // Initialize data structure for each month of the requested years
        const dataMap: Record<string, { year: number, month: string, inflow: number, outflow: number, liability: number }> = {};
        const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

        years.forEach(year => {
            months.forEach((month, index) => {
                const key = `${year}-${index + 1}`;
                dataMap[key] = {
                    year,
                    month,
                    inflow: 0,
                    outflow: 0,
                    liability: 0
                };
            });
        });

        // 1. Inflow (Collections) from transactions
        const inflowData = await db
            .select({
                year: sql<number>`EXTRACT(YEAR FROM ${transactions.transactionDate})::int`,
                month: sql<number>`EXTRACT(MONTH FROM ${transactions.transactionDate})::int`,
                total: sql<number>`SUM(${transactions.amount}::numeric)`
            })
            .from(transactions)
            .where(
                and(
                    eq(transactions.tenantId, tenantId),
                    inArray(sql<number>`EXTRACT(YEAR FROM ${transactions.transactionDate})::int`, years)
                )
            )
            .groupBy(
                sql`EXTRACT(YEAR FROM ${transactions.transactionDate})`,
                sql`EXTRACT(MONTH FROM ${transactions.transactionDate})`
            );

        inflowData.forEach(row => {
            const key = `${row.year}-${row.month}`;
            if (dataMap[key]) {
                dataMap[key].inflow = Number(row.total);
            }
        });

        // 2. Outflow (Payment) from bank_transactions
        const outflowData = await db
            .select({
                year: sql<number>`EXTRACT(YEAR FROM ${bankTransactions.transactionDate})::int`,
                month: sql<number>`EXTRACT(MONTH FROM ${bankTransactions.transactionDate})::int`,
                total: sql<number>`SUM(${bankTransactions.amount}::numeric)`
            })
            .from(bankTransactions)
            .where(
                and(
                    eq(bankTransactions.tenantId, tenantId),
                    inArray(sql<number>`EXTRACT(YEAR FROM ${bankTransactions.transactionDate})::int`, years)
                )
            )
            .groupBy(
                sql`EXTRACT(YEAR FROM ${bankTransactions.transactionDate})`,
                sql`EXTRACT(MONTH FROM ${bankTransactions.transactionDate})`
            );

        outflowData.forEach(row => {
            const key = `${row.year}-${row.month}`;
            if (dataMap[key]) {
                dataMap[key].outflow = Number(row.total);
            }
        });

        // 3. Liability (Debt) over time
        // Liability is the initial bank loan amount minus the accumulated bank transactions (outflows) up to that month.
        // For simplicity, we calculate the remaining principal for each month.

        // Get all active or closed bank loans to calculate base liability up to the requested years
        const loans = await db.select().from(bankLoans).where(eq(bankLoans.tenantId, tenantId));
        const allOutflows = await db.select().from(bankTransactions).where(eq(bankTransactions.tenantId, tenantId));

        let currentLiability = 0;

        // Ensure years are sorted
        const sortedYears = [...years].sort((a, b) => a - b);
        const minYear = sortedYears[0];
        const maxYear = sortedYears[sortedYears.length - 1];

        // Start from year 2020 or a reasonable minimum to calculate running liability
        const startYearForLiability = Math.min(2020, minYear);

        for (let y = startYearForLiability; y <= maxYear; y++) {
            for (let m = 1; m <= 12; m++) {
                // Calculate additions (new loans starting in this month)
                const newLoansThisMonth = loans.filter(l => {
                    if (!l.startDate) return false;
                    const d = dayjs(l.startDate);
                    return d.year() === y && d.month() + 1 === m;
                }).reduce((sum, l) => sum + Number(l.amount), 0);

                // Calculate reductions (bank transactions in this month)
                const outflowsThisMonth = allOutflows.filter(t => {
                    if (!t.transactionDate) return false;
                    const d = dayjs(t.transactionDate);
                    return d.year() === y && d.month() + 1 === m;
                }).reduce((sum, t) => sum + Number(t.amount), 0);

                currentLiability = currentLiability + newLoansThisMonth - outflowsThisMonth;

                // Set the liability for the requested years
                if (years.includes(y)) {
                    const key = `${y}-${m}`;
                    if (dataMap[key]) {
                        // Ensure liability is not negative (though it could be 0)
                        dataMap[key].liability = Math.max(0, currentLiability);
                    }
                }
            }
        }

        // Format for recharts, sort chronologically
        const formattedData = Object.values(dataMap).sort((a, b) => {
            if (a.year !== b.year) return a.year - b.year;
            return months.indexOf(a.month) - months.indexOf(b.month);
        }).map(d => ({
            name: `${d.month} ${d.year}`, // For XAxis label
            year: d.year,
            month: d.month,
            inflow: d.inflow,
            outflow: d.outflow,
            liability: d.liability
        }));

        return formattedData;
    }, {
        query: t.Object({
            years: t.String()
        })
    });
