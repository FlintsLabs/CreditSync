import { Elysia, t } from "elysia";
import { db } from "../db";
import { borrowers } from "../db/schema";
import { eq } from "drizzle-orm";
import { calculateLoanSchedule, LoanCalculationParams, RepaymentType } from "../lib/calculator";
import { authPlugin } from "../middleware/auth";

export const aiToolsRoute = new Elysia({ prefix: "/ai-tools" })
    .use(authPlugin)
    .post("/execute", async ({ body, user }) => {
        if (!user) return { error: "Unauthorized" };

        const { toolName, parameters } = body;

        try {
            switch (toolName) {
                case "getBorrowers": {
                    const limit = parameters?.limit ? Number(parameters.limit) : 10;
                    const results = await db.select()
                        .from(borrowers)
                        .where(eq(borrowers.tenantId, user.tenantId))
                        .limit(limit);
                    return { success: true, data: results };
                }

                case "calculateLoanSchedule": {
                    // Expecting principal, interestRate, durationDays, repaymentType, startDate
                    if (!parameters?.principal || !parameters?.interestRate || !parameters?.durationDays || !parameters?.repaymentType || !parameters?.startDate) {
                        return { success: false, error: "Missing required parameters for calculateLoanSchedule" };
                    }

                    const params: LoanCalculationParams = {
                        principal: Number(parameters.principal),
                        interestRate: Number(parameters.interestRate),
                        durationDays: Number(parameters.durationDays),
                        repaymentType: parameters.repaymentType as RepaymentType,
                        startDate: parameters.startDate
                    };

                    const schedule = calculateLoanSchedule(params);
                    return { success: true, data: schedule };
                }

                default:
                    return { success: false, error: `Unknown tool: ${toolName}` };
            }
        } catch (error: any) {
            console.error("AI Tool Execution Error:", error);
            return { success: false, error: error.message || "Execution failed" };
        }
    }, {
        body: t.Object({
            toolName: t.String(),
            parameters: t.Optional(t.Record(t.String(), t.Any()))
        })
    });
