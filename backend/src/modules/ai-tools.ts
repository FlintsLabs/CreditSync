import { Elysia, t } from "elysia";
import { db } from "../db";
import { borrowers, loans } from "../db/schema";
import { eq, and } from "drizzle-orm";
import { calculateLoanSchedule, RepaymentType } from "../lib/calculator";
import { authPlugin } from "../middleware/auth";

export const aiToolsRoute = new Elysia({ prefix: "/ai-tools" })
    .use(authPlugin)
    .get("/tools", () => {
        return {
            tools: [
                {
                    name: "fetch_borrowers",
                    description: "Fetch a list of borrowers for the current tenant.",
                    parameters: {
                        type: "object",
                        properties: {}
                    }
                },
                {
                    name: "calculate_loan_schedule",
                    description: "Calculate a loan repayment schedule.",
                    parameters: {
                        type: "object",
                        properties: {
                            principal: { type: "number", description: "The principal amount of the loan." },
                            interestRate: { type: "number", description: "The annual interest rate (e.g., 5 for 5%)." },
                            termMonths: { type: "number", description: "The term of the loan in months." },
                            repaymentType: { type: "string", description: "The repayment frequency: 'daily', 'weekly', or 'monthly'." },
                            startDate: { type: "string", description: "The start date of the loan in YYYY-MM-DD format." }
                        },
                        required: ["principal", "interestRate", "termMonths", "repaymentType", "startDate"]
                    }
                }
            ]
        };
    })
    .post("/execute", async ({ body, user, set }) => {
        if (!user) {
            set.status = 401;
            return { error: "Unauthorized" };
        }

        const { toolName, arguments: args } = body;

        try {
            switch (toolName) {
                case "fetch_borrowers": {
                    const result = await db.select().from(borrowers).where(eq(borrowers.tenantId, user.tenantId));
                    return { success: true, data: result };
                }
                case "calculate_loan_schedule": {
                    const { principal, interestRate, termMonths, repaymentType, startDate } = args as any;
                    const schedule = calculateLoanSchedule({
                        principal,
                        interestRate,
                        termMonths,
                        repaymentType: repaymentType as RepaymentType,
                        startDate: new Date(startDate)
                    });
                    return { success: true, data: schedule };
                }
                default:
                    set.status = 400;
                    return { error: `Unknown tool: ${toolName}` };
            }
        } catch (error: any) {
            set.status = 500;
            return { error: `Error executing tool: ${error.message}` };
        }
    }, {
        body: t.Object({
            toolName: t.String(),
            arguments: t.Record(t.String(), t.Any())
        })
    });
