import { Elysia, t } from "elysia";
import { db } from "../db";
import { borrowers, loans, transactions, bankProfiles, bankLoans } from "../db/schema";
import { eq, and, like, sql } from "drizzle-orm";
import { calculateLoanSchedule, type RepaymentType } from "../lib/calculator";
import dayjs from "dayjs";

export const aiToolsRoute = new Elysia({ prefix: "/ai-tools" })
    .guard({ isLoggedIn: true }) // Protected by authPlugin

    // Provide robust JSON schemas for AI tools
    .get("/tools", () => {
        return {
            tools: [
                {
                    name: "fetch_borrowers",
                    description: "Fetch a list of borrowers with optional search query.",
                    parameters: {
                        type: "object",
                        properties: {
                            query: { type: "string", description: "Search query for borrower name or contact." },
                            limit: { type: "number", description: "Maximum number of results to return (default 10)." }
                        }
                    }
                },
                {
                    name: "calculate_loan_schedule",
                    description: "Calculate an installment schedule for a new loan simulation.",
                    parameters: {
                        type: "object",
                        properties: {
                            principal: { type: "number", description: "The loan principal amount." },
                            interestRate: { type: "number", description: "The annual interest rate (e.g. 15 for 15%)." },
                            termMonths: { type: "number", description: "The loan term in months." },
                            repaymentType: { type: "string", enum: ["daily", "weekly", "monthly", "floating"], description: "The repayment frequency." },
                            startDate: { type: "string", description: "The start date of the loan (ISO string)." }
                        },
                        required: ["principal", "interestRate", "termMonths", "repaymentType", "startDate"]
                    }
                },
                {
                    name: "get_fund_performance",
                    description: "Retrieve a summary of fund performance (bank profiles).",
                    parameters: {
                        type: "object",
                        properties: {}
                    }
                }
            ]
        };
    })

    // Execute requested tool calls
    .post("/execute", async ({ body, user }) => {
        const { toolName, parameters } = body;
        const tenantId = user.tenantId;

        if (!tenantId) {
             return new Response("Unauthorized: No tenant context", { status: 401 });
        }

        try {
            switch (toolName) {
                case "fetch_borrowers": {
                    const query = parameters.query as string | undefined;
                    const limit = (parameters.limit as number) || 10;

                    let whereClause = eq(borrowers.tenantId, tenantId);
                    if (query) {
                         whereClause = and(whereClause, like(borrowers.name, `%${query}%`)) as typeof whereClause;
                    }

                    const results = await db.select()
                        .from(borrowers)
                        .where(whereClause)
                        .limit(limit);

                    return { success: true, result: results };
                }

                case "calculate_loan_schedule": {
                    const principal = Number(parameters.principal);
                    const interestRate = Number(parameters.interestRate);
                    const termMonths = Number(parameters.termMonths);
                    const repaymentType = parameters.repaymentType as RepaymentType;
                    const startDate = new Date(parameters.startDate as string);

                    if (isNaN(principal) || isNaN(interestRate) || isNaN(termMonths) || !startDate) {
                         return { success: false, error: "Invalid parameters for calculation." };
                    }

                    const schedule = calculateLoanSchedule({
                        principal,
                        interestRate,
                        termMonths,
                        repaymentType,
                        startDate
                    });

                    return { success: true, result: schedule };
                }

                case "get_fund_performance": {
                    // Simple aggregate for demonstration
                    const results = await db.select({
                        name: bankProfiles.name,
                        creditLimit: bankProfiles.creditLimit
                    })
                    .from(bankProfiles)
                    .where(eq(bankProfiles.tenantId, tenantId));
                    return { success: true, result: results };
                }

                default:
                    return { success: false, error: `Tool ${toolName} not found or unsupported.` };
            }
        } catch (error: any) {
             return { success: false, error: error.message };
        }
    }, {
        body: t.Object({
            toolName: t.String(),
            parameters: t.Any()
        })
    });
