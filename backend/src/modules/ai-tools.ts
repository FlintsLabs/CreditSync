import { Elysia, t } from "elysia";
import { authPlugin } from "../middleware/auth";
import { db } from "../db";
import { borrowers, loans, transactions } from "../db/schema";
import { eq, and } from "drizzle-orm";
import { calculateLoanSchedule, calculateLoanClosingSummary } from "../lib/calculator";

// Define the Schema for AI MCP/Flow Tools
const aiToolsSchema = {
    tools: [
        {
            name: "get_borrowers",
            description: "Fetch a list of borrowers for the current tenant",
            parameters: {
                type: "object",
                properties: {
                    limit: { type: "number", description: "Maximum number of borrowers to return", default: 10 }
                }
            }
        },
        {
            name: "calculate_loan_schedule",
            description: "Calculate a loan schedule",
            parameters: {
                type: "object",
                properties: {
                    principal: { type: "number" },
                    interestRate: { type: "number", description: "Annual interest rate percentage" },
                    termMonths: { type: "number" },
                    repaymentType: { type: "string", enum: ["daily", "weekly", "monthly", "floating"] },
                    startDate: { type: "string", description: "YYYY-MM-DD format" }
                },
                required: ["principal", "interestRate", "termMonths", "repaymentType", "startDate"]
            }
        },
        {
            name: "get_loan_summary",
            description: "Get closing summary for a specific loan ID",
            parameters: {
                type: "object",
                properties: {
                    loanId: { type: "number", description: "The ID of the loan to summarize" }
                },
                required: ["loanId"]
            }
        }
    ]
};

export const aiToolsRoute = new Elysia({ prefix: "/ai-tools" })
    .use(authPlugin)
    .get("/tools", () => {
        // Return JSON schema describing available tools
        return aiToolsSchema;
    })
    .post("/execute", async ({ body, user, set }) => {
        if (!user) {
            set.status = 401;
            return { error: "Unauthorized" };
        }

        const { tool, params } = body;

        switch (tool) {
            case "get_borrowers": {
                const limit = params?.limit || 10;
                const result = await db.query.borrowers.findMany({
                    where: eq(borrowers.tenantId, user.tenantId),
                    limit: limit
                });
                return result;
            }

            case "calculate_loan_schedule": {
                try {
                    const schedule = calculateLoanSchedule({
                        principal: params.principal,
                        interestRate: params.interestRate,
                        termMonths: params.termMonths,
                        repaymentType: params.repaymentType as any,
                        startDate: new Date(params.startDate)
                    });
                    return schedule;
                } catch (e: any) {
                    set.status = 400;
                    return { error: e.message };
                }
            }

            case "get_loan_summary": {
                const loanId = params.loanId;
                if (!loanId) {
                    set.status = 400;
                    return { error: "loanId is required" };
                }

                const loan = await db.query.loans.findFirst({
                    where: and(eq(loans.id, loanId), eq(loans.tenantId, user.tenantId))
                });

                if (!loan) {
                    set.status = 404;
                    return { error: "Loan not found" };
                }

                const loanTransactions = await db.select()
                    .from(transactions)
                    .where(and(eq(transactions.loanId, loanId), eq(transactions.tenantId, user.tenantId)));

                const summary = calculateLoanClosingSummary(loan, loanTransactions);
                return summary;
            }

            default:
                set.status = 404;
                return { error: `Tool ${tool} not found` };
        }
    }, {
        body: t.Object({
            tool: t.String(),
            params: t.Any()
        })
    });
