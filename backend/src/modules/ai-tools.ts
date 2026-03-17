import { Elysia, t } from "elysia";
import { authPlugin } from "../middleware/auth";
import { db } from "../db";
import { users, borrowers, loans, transactions, bankLoans, bankProfiles } from "../db/schema";
import { eq, and, desc } from "drizzle-orm";

export const aiToolsRoute = new Elysia({ prefix: "/ai-tools" })
    .use(authPlugin)
    .get("/schemas", async ({ user }) => {
        if (!user) throw new Error("Unauthorized");
        // Return JSON schema definitions for tools that AI agents can use
        return {
            tools: [
                {
                    name: "get_borrower_summary",
                    description: "Retrieve a summary of a specific borrower's loans and repayment status.",
                    parameters: {
                        type: "object",
                        properties: {
                            borrowerId: { type: "number", description: "The ID of the borrower" }
                        },
                        required: ["borrowerId"]
                    }
                },
                {
                    name: "get_fund_performance",
                    description: "Retrieve aggregated performance metrics for a specific bank fund.",
                    parameters: {
                        type: "object",
                        properties: {
                            bankProfileId: { type: "number", description: "The ID of the bank profile/fund" }
                        },
                        required: ["bankProfileId"]
                    }
                }
            ]
        };
    })
    .post("/query", async ({ body, user }) => {
        if (!user) throw new Error("Unauthorized");
        const { query, context } = body;

        // This is a placeholder for MCP tool execution logic.
        // An AI flow would hit this endpoint to execute actions or retrieve specific contextual data.

        if (query === 'get_borrower_summary' && context?.borrowerId) {
             const borrower = await db.select().from(borrowers).where(and(eq(borrowers.id, context.borrowerId), eq(borrowers.tenantId, user.tenantId))).then(res => res[0]);
             if (!borrower) return { error: "Borrower not found" };

             const borrowerLoans = await db.select().from(loans).where(and(eq(loans.borrowerId, borrower.id), eq(loans.tenantId, user.tenantId)));

             return {
                 success: true,
                 data: {
                     borrower,
                     loans: borrowerLoans
                 }
             };
        }

        return { success: false, message: "Unknown query or missing context" };
    }, {
        body: t.Object({
            query: t.String(),
            context: t.Optional(t.Any())
        })
    });
