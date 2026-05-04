import { Elysia, t } from "elysia";
import { db } from "../db";
import { borrowers, loans, transactions } from "../db/schema";
import { eq, and, sql } from "drizzle-orm";

// Schema for available AI Tools
const aiToolsSchema = [
    {
        name: "get_borrower_summary",
        description: "Get a summary of a specific borrower's profile and credit score.",
        parameters: {
            type: "object",
            properties: {
                borrowerId: {
                    type: "number",
                    description: "The ID of the borrower to lookup."
                }
            },
            required: ["borrowerId"]
        }
    },
    {
        name: "get_active_loans",
        description: "Get all active loans for the current tenant.",
        parameters: {
            type: "object",
            properties: {},
            required: []
        }
    }
];

import { authPlugin } from "../middleware/auth";

export const aiToolsRoute = new Elysia({ prefix: "/ai-tools" })
    .use(authPlugin)
    .get("/tools", () => {
        return aiToolsSchema;
    })
    .post("/execute", async ({ body, user }) => {
        const { tool, parameters } = body as { tool: string; parameters: any };

        if (!user || !user.tenantId) {
            throw new Error("Unauthorized: Tenant context missing");
        }

        try {
            switch (tool) {
                case "get_borrower_summary": {
                    const borrowerId = Number(parameters.borrowerId);
                    if (isNaN(borrowerId)) {
                        return { error: "Invalid borrowerId" };
                    }

                    const result = await db.query.borrowers.findFirst({
                        where: and(
                            eq(borrowers.id, borrowerId),
                            eq(borrowers.tenantId, user.tenantId)
                        )
                    });

                    if (!result) return { error: "Borrower not found or unauthorized" };

                    return {
                        id: result.id,
                        name: result.name,
                        creditScore: result.creditScore,
                        status: result.notes || "No notes available"
                    };
                }

                case "get_active_loans": {
                    const activeLoans = await db.query.loans.findMany({
                        where: and(
                            eq(loans.status, "active"),
                            eq(loans.tenantId, user.tenantId)
                        ),
                        with: {
                            borrower: true
                        }
                    });

                    return activeLoans.map(loan => ({
                        id: loan.id,
                        borrowerName: loan.borrower.name,
                        principalAmount: Number(loan.principalAmount),
                        installmentAmount: Number(loan.installmentAmount),
                        repaymentType: loan.repaymentType
                    }));
                }

                default:
                    return { error: `Tool ${tool} not found` };
            }
        } catch (error: any) {
            console.error("AI Tool Execution Error:", error);
            return { error: "Failed to execute tool", details: error.message };
        }
    }, {
        body: t.Object({
            tool: t.String(),
            parameters: t.Any()
        })
    });
