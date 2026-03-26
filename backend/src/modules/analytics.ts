import { Elysia } from "elysia";
import { db } from "../db";
import { transactions, bankTransactions, bankLoans } from "../db/schema";
import { eq, sum, and } from "drizzle-orm";

export const analyticsRoute = new Elysia({ prefix: "/analytics" })
    .get("/funds/performance", async ({ user }) => {
        const tenantId = user?.tenantId as string;

        // Total Inflow (from borrowers)
        const inflowResult = await db
            .select({ total: sum(transactions.amount) })
            .from(transactions)
            .where(eq(transactions.tenantId, tenantId));
        const totalInflow = Number(inflowResult[0]?.total || 0);

        // Total Outflow (repayments to banks)
        const outflowResult = await db
            .select({ total: sum(bankTransactions.amount) })
            .from(bankTransactions)
            .where(eq(bankTransactions.tenantId, tenantId));
        const totalOutflow = Number(outflowResult[0]?.total || 0);

        // Total Liability (current active bank loans)
        const liabilityResult = await db
            .select({ total: sum(bankLoans.amount) })
            .from(bankLoans)
            .where(
                and(
                    eq(bankLoans.tenantId, tenantId),
                    eq(bankLoans.status, "active")
                )
            );
        const totalLiability = Number(liabilityResult[0]?.total || 0);

        // Detailed chart data (example dummy data grouped by month for the chart)
        const chartData = [
            { name: "Jan", inflow: Math.floor(totalInflow * 0.1), outflow: Math.floor(totalOutflow * 0.1), liability: totalLiability },
            { name: "Feb", inflow: Math.floor(totalInflow * 0.2), outflow: Math.floor(totalOutflow * 0.15), liability: totalLiability },
            { name: "Mar", inflow: Math.floor(totalInflow * 0.3), outflow: Math.floor(totalOutflow * 0.25), liability: totalLiability },
            { name: "Apr", inflow: Math.floor(totalInflow * 0.4), outflow: Math.floor(totalOutflow * 0.5), liability: totalLiability },
        ];

        return {
            status: "success",
            data: {
                summary: {
                    totalInflow,
                    totalOutflow,
                    totalLiability
                },
                chartData
            }
        };
    });
