import { Elysia, t } from "elysia";
import { db } from "../db";
import { borrowers, loans, transactions, bankLoans } from "../db/schema";
import { eq, and, sql } from "drizzle-orm";
import { calculateLoanSchedule } from "../lib/calculator";

// Helper to extract user from context
type Context = {
    user?: {
        tenantId: string;
        role: string;
        email: string;
        id: number;
    } | null;
};

// Define available AI Tools
const aiToolsSchema = [
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
        name: "calculate_loan",
        description: "Calculate a hypothetical loan schedule",
        parameters: {
            type: "object",
            properties: {
                principal: { type: "number", description: "Loan principal amount" },
                interestRate: { type: "number", description: "Interest rate (e.g. 20 for 20%)" },
                repaymentType: { type: "string", description: "daily, weekly, monthly, or floating" },
                term: { type: "number", description: "Term length in the unit of repaymentType" }
            },
            required: ["principal", "interestRate", "repaymentType", "term"]
        }
    },
    {
        name: "get_summary_stats",
        description: "Get financial summary statistics for the dashboard",
        parameters: { type: "object", properties: {} }
    }
];

export const aiToolsRoute = new Elysia({ prefix: "/ai-tools" })
    .get("/tools", () => {
        return {
            tools: aiToolsSchema
        };
    })
    .post("/execute", async ({ body, user, set }: any) => {
        if (!user || !user.tenantId) {
            set.status = 401;
            return { error: "Unauthorized" };
        }

        const { toolName, parameters } = body as { toolName: string, parameters: any };

        try {
            switch (toolName) {
                case "get_borrowers": {
                    const limit = parameters.limit || 10;
                    const data = await db.select()
                        .from(borrowers)
                        .where(eq(borrowers.tenantId, user.tenantId))
                        .limit(limit);
                    return { success: true, data };
                }

                case "calculate_loan": {
                    const { principal, interestRate, repaymentType, term } = parameters;
                    const schedule = calculateLoanSchedule(
                        principal,
                        interestRate,
                        repaymentType,
                        term,
                        new Date().toISOString()
                    );
                    return { success: true, data: schedule };
                }

                case "get_summary_stats": {
                    // Total loans
                    const totalLoansRes = await db.select({ total: sql<number>`SUM(${loans.principalAmount})` })
                        .from(loans)
                        .where(eq(loans.tenantId, user.tenantId));

                    // Total collected
                    const totalCollectedRes = await db.select({ total: sql<number>`SUM(${transactions.amount})` })
                        .from(transactions)
                        .where(eq(transactions.tenantId, user.tenantId));

                    return {
                        success: true,
                        data: {
                            totalLoans: totalLoansRes[0]?.total || 0,
                            totalCollected: totalCollectedRes[0]?.total || 0
                        }
                    };
                }

                default:
                    set.status = 400;
                    return { error: `Tool ${toolName} not found` };
            }
        } catch (error: any) {
            console.error(`Error executing tool ${toolName}:`, error);
            set.status = 500;
            return { error: "Internal Server Error", details: error.message };
        }
    }, {
        body: t.Object({
            toolName: t.String(),
            parameters: t.Optional(t.Record(t.String(), t.Any()))
        })
    });
