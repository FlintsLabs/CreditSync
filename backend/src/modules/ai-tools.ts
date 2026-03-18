import { Elysia, t } from "elysia";
import { db } from "../db";
import { borrowers, loans, transactions, bankProfiles, bankLoans } from "../db/schema";
import { count, eq, sql } from "drizzle-orm";
import { authPlugin } from "../middleware/auth";

export const aiToolsRoute = new Elysia({ prefix: "/ai-tools" })
    .use(authPlugin)
    .get("/context", async ({ user, set }) => {
        if (!user) {
            set.status = 401;
            return { error: "Unauthorized" };
        }

        try {
            // Aggregate high-level data for AI context
            const [totalBorrowers] = await db.select({ count: count() })
                .from(borrowers)
                .where(eq(borrowers.tenantId, user.tenantId));

            const [totalLoans] = await db.select({ count: count() })
                .from(loans)
                .where(eq(loans.tenantId, user.tenantId));

            const [activeLoans] = await db.select({ count: count() })
                .from(loans)
                .where(sql`${loans.status} = 'active' AND ${loans.tenantId} = ${user.tenantId}`);

            const [totalBankProfiles] = await db.select({ count: count() })
                .from(bankProfiles)
                .where(eq(bankProfiles.tenantId, user.tenantId));

            return {
                tenantId: user.tenantId,
                metrics: {
                    totalBorrowers: totalBorrowers.count,
                    totalLoans: totalLoans.count,
                    activeLoans: activeLoans.count,
                    totalBankProfiles: totalBankProfiles.count,
                },
                description: "High-level aggregate metrics for the current tenant's portfolio."
            };
        } catch (error) {
            console.error("AI Context Error:", error);
            set.status = 500;
            return { error: "Failed to retrieve context" };
        }
    })
    .get("/tools", async ({ user, set }) => {
         if (!user) {
            set.status = 401;
            return { error: "Unauthorized" };
        }

        return {
            tools: [
                {
                    name: "calculate_loan_schedule",
                    description: "Calculates a loan repayment schedule based on principal, interest rate, term, and repayment type.",
                    endpoint: "POST /loans/calculate",
                    parameters: {
                        principal: "number",
                        interestRate: "number",
                        termMonths: "number",
                        repaymentType: "string (daily|weekly|monthly|floating)",
                        startDate: "string (YYYY-MM-DD)"
                    }
                },
                {
                    name: "get_borrower_details",
                    description: "Retrieves details of a specific borrower by ID.",
                    endpoint: "GET /borrowers/:id",
                    parameters: {
                        id: "number"
                    }
                },
                {
                    name: "get_loan_closing_summary",
                    description: "Calculates the closing summary (pro-rated interest, total paid, balance) for a specific loan.",
                    endpoint: "GET /loans/:id/closing-summary",
                    parameters: {
                        id: "number"
                    }
                }
            ],
            description: "A registry of available functional endpoints suitable for LLM tool calling (MCP integration)."
        };
    });
