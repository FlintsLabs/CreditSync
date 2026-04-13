import { Elysia, t } from "elysia";
import { authPlugin } from "../middleware/auth";
import { db } from "../db";
import { borrowers, loans, transactions, bankLoans, bankProfiles } from "../db/schema";
import { eq, and, sql } from "drizzle-orm";
import { calculateLoanSchedule, LoanCalculationParams, RepaymentType, calculateLoanClosingSummary } from "../lib/calculator";

export const aiToolsRoute = new Elysia({ prefix: "/ai-tools" })
    .use(authPlugin)
    .post("/execute", async ({ body, user, set }) => {
        if (!user) {
            set.status = 401;
            return { error: "Unauthorized" };
        }

        const { toolName, parameters } = body as { toolName: string; parameters: any };

        try {
            switch (toolName) {
                case "get_borrowers":
                    const allBorrowers = await db.select().from(borrowers).where(eq(borrowers.tenantId, user.tenantId));
                    return { success: true, data: allBorrowers };

                case "get_loans":
                    const allLoans = await db.select().from(loans).where(eq(loans.tenantId, user.tenantId));
                    return { success: true, data: allLoans };

                case "calculate_loan_schedule":
                    const schedule = calculateLoanSchedule({
                        principal: parameters.principal,
                        interestRate: parameters.interestRate,
                        termMonths: parameters.termMonths,
                        repaymentType: parameters.repaymentType as RepaymentType,
                        startDate: new Date(parameters.startDate || Date.now())
                    });
                    return { success: true, data: schedule };

                case "get_loan_closing_summary":
                    const loan = await db.query.loans.findFirst({
                        where: and(eq(loans.id, parameters.loanId), eq(loans.tenantId, user.tenantId))
                    });
                    if (!loan) return { success: false, error: "Loan not found" };

                    const loanTransactions = await db.select()
                        .from(transactions)
                        .where(and(eq(transactions.loanId, parameters.loanId), eq(transactions.tenantId, user.tenantId)));

                    const summary = calculateLoanClosingSummary(loan, loanTransactions);
                    return { success: true, data: summary };

                case "get_portfolio_summary":
                    // Simple summary
                    const totalActiveLoans = await db.select({ count: sql<number>`count(*)` })
                        .from(loans)
                        .where(and(eq(loans.tenantId, user.tenantId), eq(loans.status, "active")));

                    const totalPrincipal = await db.select({ sum: sql<number>`sum(CAST(${loans.principalAmount} AS NUMERIC))` })
                        .from(loans)
                        .where(and(eq(loans.tenantId, user.tenantId), eq(loans.status, "active")));

                    return { success: true, data: { activeLoans: totalActiveLoans[0].count, totalPrincipal: totalPrincipal[0].sum } };

                default:
                    set.status = 400;
                    return { success: false, error: `Tool ${toolName} not found` };
            }
        } catch (error: any) {
            console.error("AI Tool Execution Error:", error);
            set.status = 500;
            return { success: false, error: error.message };
        }
    }, {
        body: t.Object({
            toolName: t.String(),
            parameters: t.Any()
        })
    })
    .get("/tools", () => {
        // Expose available tools schema
        return {
            tools: [
                {
                    name: "get_borrowers",
                    description: "Retrieve a list of all borrowers for the current tenant.",
                    parameters: { type: "object", properties: {} }
                },
                {
                    name: "get_loans",
                    description: "Retrieve a list of all loans for the current tenant.",
                    parameters: { type: "object", properties: {} }
                },
                {
                    name: "calculate_loan_schedule",
                    description: "Calculate a loan repayment schedule.",
                    parameters: {
                        type: "object",
                        properties: {
                            principal: { type: "number", description: "The principal amount" },
                            interestRate: { type: "number", description: "Annual interest rate" },
                            termMonths: { type: "number", description: "Duration in months" },
                            repaymentType: { type: "string", enum: ["daily", "weekly", "monthly", "floating"], description: "Frequency of repayment" },
                            startDate: { type: "string", format: "date", description: "Optional start date" }
                        },
                        required: ["principal", "interestRate", "termMonths", "repaymentType"]
                    }
                },
                {
                    name: "get_loan_closing_summary",
                    description: "Calculate the closing summary for a specific loan.",
                    parameters: {
                        type: "object",
                        properties: {
                            loanId: { type: "number", description: "The ID of the loan" }
                        },
                        required: ["loanId"]
                    }
                },
                {
                    name: "get_portfolio_summary",
                    description: "Retrieve a high-level summary of the active loan portfolio.",
                    parameters: { type: "object", properties: {} }
                }
            ]
        };
    });
