import { Elysia, t } from "elysia";
import { db } from "../db";
import { borrowers, loans, transactions, bankProfiles, bankLoans } from "../db/schema";
import { eq, and, count, sum } from "drizzle-orm";

export const aiToolsRoute = new Elysia({ prefix: "/ai-tools" })
    .get("/tools", () => {
        return {
            tools: [
                {
                    name: "get_borrowers",
                    description: "Fetch a list of all borrowers for the current tenant.",
                    input_schema: {
                        type: "object",
                        properties: {}
                    }
                },
                {
                    name: "get_loans",
                    description: "Fetch a list of all loans for the current tenant.",
                    input_schema: {
                        type: "object",
                        properties: {}
                    }
                },
                {
                    name: "get_borrower_by_id",
                    description: "Fetch a specific borrower by their ID.",
                    input_schema: {
                        type: "object",
                        properties: {
                            borrower_id: {
                                type: "number",
                                description: "The ID of the borrower to fetch"
                            }
                        },
                        required: ["borrower_id"]
                    }
                },
                {
                    name: "get_dashboard_summary",
                    description: "Get a summary of the total funds, loans, and active borrowers.",
                    input_schema: {
                        type: "object",
                        properties: {}
                    }
                }
            ]
        };
    })
    .post("/execute", async ({ body, user }) => {
        // @ts-ignore
        const tenantId = user.tenantId;
        const { tool, parameters } = body;

        try {
            switch (tool) {
                case "get_borrowers": {
                    const result = await db.select().from(borrowers).where(eq(borrowers.tenantId, tenantId)).limit(50);
                    return { result };
                }
                case "get_loans": {
                    const result = await db.select().from(loans).where(eq(loans.tenantId, tenantId)).limit(50);
                    return { result };
                }
                case "get_borrower_by_id": {
                    const params = parameters as { borrower_id: number };
                    const result = await db.select().from(borrowers)
                        .where(and(eq(borrowers.id, params.borrower_id), eq(borrowers.tenantId, tenantId)))
                        .limit(1);
                    return { result: result[0] || null };
                }
                case "get_dashboard_summary": {
                    const totalBorrowers = await db.select({ count: count() }).from(borrowers).where(eq(borrowers.tenantId, tenantId));
                    const totalLoans = await db.select({ count: count(), principalSum: sum(loans.principalAmount) }).from(loans).where(eq(loans.tenantId, tenantId));

                    return {
                        result: {
                            total_borrowers: totalBorrowers[0].count,
                            total_loans: totalLoans[0].count,
                            total_principal_lent: Number(totalLoans[0].principalSum || 0)
                        }
                    };
                }
                default:
                    return new Response(JSON.stringify({ error: `Tool ${tool} not found` }), { status: 404 });
            }
        } catch (error: any) {
            return new Response(JSON.stringify({ error: error.message }), { status: 500 });
        }
    }, {
        body: t.Object({
            tool: t.String(),
            parameters: t.Optional(t.Any())
        })
    });