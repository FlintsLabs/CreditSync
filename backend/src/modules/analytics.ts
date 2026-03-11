import { Elysia } from "elysia";
import { db } from "../db";
import { loans, transactions, bankLoans, bankTransactions } from "../db/schema";
import { eq, sum } from "drizzle-orm";
import { authPlugin } from "../middleware/auth";

export const analyticsRoute = new Elysia({ prefix: "/analytics" })
    .use(authPlugin)
    .get("/", async ({ user }) => {
        if (!user) return { data: [] };

        // For this MVP, we will return some mock structured data matching the
        // frontend's expected format. In a real scenario, this would involve
        // complex time-series aggregation from Drizzle using SQL DATE_TRUNC.

        // Let's at least get some real totals to prove the db connection
        const totalLoans = await db.select({ val: sum(loans.principalAmount) })
            .from(loans)
            .where(eq(loans.tenantId, user.tenantId));

        const totalTransactions = await db.select({ val: sum(transactions.amount) })
            .from(transactions)
            .where(eq(transactions.tenantId, user.tenantId));

        return {
            summary: {
                totalPrincipalLent: totalLoans[0]?.val || 0,
                totalCollected: totalTransactions[0]?.val || 0
            },
            message: "Analytics API is ready for time-series aggregation implementation."
        };
    });
