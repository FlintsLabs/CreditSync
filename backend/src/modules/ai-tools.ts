import { Elysia, t } from "elysia";
import { db } from "../db";
import { borrowers, loans, transactions } from "../db/schema";
import { eq, and } from "drizzle-orm";

import { authPlugin } from "../middleware/auth";

export const aiToolsRoute = new Elysia({ prefix: "/ai-tools" })
    .use(authPlugin)
    .get("/tools", () => {
        return {
            tools: [
                {
                    name: "get_borrower_summary",
                    description: "Retrieves a summary of a specific borrower by their ID, including basic info and credit score.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            borrowerId: { type: "number", description: "The unique ID of the borrower" }
                        },
                        required: ["borrowerId"]
                    }
                },
                {
                    name: "get_loan_summary",
                    description: "Retrieves details of a specific loan including principal, status, and interest rate.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            loanId: { type: "number", description: "The unique ID of the loan" }
                        },
                        required: ["loanId"]
                    }
                }
            ]
        };
    })
    .post("/execute", async ({ body, user }) => {
        const tenantId = user?.tenantId;
        if (!tenantId) throw new Error("Unauthorized: No tenant context");

        const { tool, params } = body as { tool: string; params: any };

        try {
            switch (tool) {
                case "get_borrower_summary": {
                    const { borrowerId } = params;
                    const result = await db.select().from(borrowers)
                        .where(and(
                            eq(borrowers.id, borrowerId),
                            eq(borrowers.tenantId, tenantId)
                        ));
                    return { success: true, data: result[0] || null };
                }
                case "get_loan_summary": {
                    const { loanId } = params;
                    const result = await db.select().from(loans)
                        .where(and(
                            eq(loans.id, loanId),
                            eq(loans.tenantId, tenantId)
                        ));
                    return { success: true, data: result[0] || null };
                }
                default:
                    return { success: false, error: "Tool not found" };
            }
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    }, {
        body: t.Object({
            tool: t.String(),
            params: t.Any()
        })
    });
