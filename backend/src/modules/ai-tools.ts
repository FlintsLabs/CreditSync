import { Elysia, t } from "elysia";
import { db } from "../db";
import { authPlugin } from "../middleware/auth";
import { bankLoans, borrowers, loans, transactions } from "../db/schema";
import { eq, sql } from "drizzle-orm";

export const aiToolsRoute = new Elysia({ prefix: "/ai-tools" })
    .use(authPlugin)
    .get("/tools", () => {
        return {
            tools: [
                {
                    name: "get_borrower_summary",
                    description: "Retrieve a summary of borrowers for the current user's tenant.",
                    parameters: {
                        type: "object",
                        properties: {},
                        required: []
                    }
                },
                {
                    name: "get_active_loans",
                    description: "Retrieve active loans for the current user's tenant.",
                    parameters: {
                        type: "object",
                        properties: {},
                        required: []
                    }
                }
            ]
        };
    })
    .post("/execute", async ({ body, user }) => {
        const { tool, parameters } = body;

        // Secure implementation: instead of arbitrary SQL, we provide specific, safe functions
        // that automatically scope queries to the authenticated user's tenant.

        if (tool === "get_borrower_summary") {
            try {
                const summary = await db.select({
                    id: borrowers.id,
                    name: borrowers.name,
                    creditScore: borrowers.creditScore
                })
                .from(borrowers)
                .where(eq(borrowers.tenantId, user.tenantId))
                .limit(50);

                return { result: summary };
            } catch (error: any) {
                return { error: error.message };
            }
        }

        if (tool === "get_active_loans") {
             try {
                const activeLoans = await db.select({
                    id: loans.id,
                    borrowerId: loans.borrowerId,
                    principal: loans.principalAmount,
                    status: loans.status
                })
                .from(loans)
                .where(
                    sql`${loans.tenantId} = ${user.tenantId} AND ${loans.status} = 'active'`
                )
                .limit(50);

                return { result: activeLoans };
            } catch (error: any) {
                return { error: error.message };
            }
        }

        return { error: "Unknown tool or invalid parameters" };
    }, {
        body: t.Object({
            tool: t.String(),
            parameters: t.Optional(t.Any())
        })
    });
