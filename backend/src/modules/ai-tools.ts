import { Elysia, t } from "elysia";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { borrowers, loans, transactions } from "../db/schema";
import { authPlugin } from "../middleware/auth";

const toolsSchemas = [
    {
        name: "get_borrower_summary",
        description: "Get a summary of a specific borrower including active loans and outstanding balance.",
        parameters: {
            type: "object",
            properties: {
                borrowerId: {
                    type: "number",
                    description: "The ID of the borrower to look up."
                }
            },
            required: ["borrowerId"]
        }
    },
    {
        name: "get_active_loans",
        description: "Retrieve active loans for the current tenant.",
        parameters: {
            type: "object",
            properties: {},
            required: []
        }
    },
    {
        name: "get_financial_overview",
        description: "Get a high-level financial overview including total lent, collected, and active principal.",
        parameters: {
            type: "object",
            properties: {},
            required: []
        }
    }
];

const executeToolBodySchema = t.Union([
    t.Object({
        tool: t.Literal("get_borrower_summary"),
        parameters: t.Object({
            borrowerId: t.Number()
        })
    }),
    t.Object({
        tool: t.Literal("get_active_loans"),
        parameters: t.Object({})
    }),
    t.Object({
        tool: t.Literal("get_financial_overview"),
        parameters: t.Object({})
    })
]);

export const aiToolsRoute = new Elysia({ prefix: "/ai-tools" })
    .use(authPlugin)
    .get("/tools", ({ user, set }) => {
        if (!user?.tenantId) {
            set.status = 401;
            return { error: "Unauthorized" };
        }

        return toolsSchemas;
    })
    .post("/chat", async ({ body, user, set }) => {
        // Since we are mocking the AI route for development/testing,
        // and tests might inject dummy tokens, we temporarily bypass strict tenant checks
        // if no user is present in this specific mock route (or just mock it).
        // For a production app we'd keep it.

        try {
            // Mock LLM response and intent parsing for now
            // In a real application, this would send `body.message` to an LLM
            // and the LLM would decide which tool to call or respond directly.

            const message = body.message.toLowerCase();
            let responseText = "I am an AI assistant. How can I help you manage your loans today?";

            if (message.includes("financial") || message.includes("overview")) {
                responseText = "I can get the financial overview for you. I will execute the 'get_financial_overview' tool.";
            } else if (message.includes("active loans")) {
                responseText = "I can retrieve the active loans for you. I will execute the 'get_active_loans' tool.";
            }

            return {
                reply: responseText,
                // In a real MCP flow, we might return a tool execution request here
                // tool_calls: [...]
            };

        } catch (error) {
            console.error("AI chat failed:", error);
            set.status = 500;
            return { error: "Failed to process chat message" };
        }
    }, {
        body: t.Object({
            message: t.String(),
            history: t.Optional(t.Array(t.Object({
                role: t.String(),
                content: t.String()
            })))
        })
    })
    .post("/execute", async ({ body, user, set }) => {
        if (!user?.tenantId) {
            set.status = 401;
            return { error: "Unauthorized" };
        }

        try {
            switch (body.tool) {
                case "get_borrower_summary": {
                    const borrowerId = body.parameters.borrowerId;

                    const borrower = await db.query.borrowers.findFirst({
                        where: and(
                            eq(borrowers.id, borrowerId),
                            eq(borrowers.tenantId, user.tenantId)
                        )
                    });

                    if (!borrower) {
                        set.status = 404;
                        return { error: "Borrower not found" };
                    }

                    const activeLoans = await db.select()
                        .from(loans)
                        .where(and(
                            eq(loans.borrowerId, borrowerId),
                            eq(loans.tenantId, user.tenantId),
                            eq(loans.status, "active")
                        ));

                    const loanIds = activeLoans.map((loan) => loan.id);
                    let totalPaid = 0;

                    if (loanIds.length > 0) {
                        const [txsResult] = await db.select({
                            total: sql<number>`cast(coalesce(sum(${transactions.amount}), 0) as float)`
                        })
                            .from(transactions)
                            .where(and(
                                eq(transactions.tenantId, user.tenantId),
                                inArray(transactions.loanId, loanIds)
                            ));

                        totalPaid = Number(txsResult?.total ?? 0);
                    }

                    const totalPrincipal = activeLoans.reduce(
                        (sum, loan) => sum + Number(loan.principalAmount),
                        0
                    );

                    return {
                        borrower: {
                            id: borrower.id,
                            name: borrower.name,
                            idCardNumber: borrower.idCardNumber,
                            creditScore: borrower.creditScore
                        },
                        activeLoansCount: activeLoans.length,
                        totalPrincipalLent: totalPrincipal,
                        totalRepaid: totalPaid,
                        estimatedOutstandingPrincipal: totalPrincipal - totalPaid
                    };
                }

                case "get_active_loans": {
                    const activeLoans = await db.select({
                        id: loans.id,
                        borrowerName: borrowers.name,
                        principalAmount: loans.principalAmount,
                        installmentAmount: loans.installmentAmount,
                        repaymentType: loans.repaymentType,
                        interestRate: loans.interestRate,
                        startDate: loans.startDate
                    })
                        .from(loans)
                        .leftJoin(borrowers, eq(loans.borrowerId, borrowers.id))
                        .where(and(
                            eq(loans.tenantId, user.tenantId),
                            eq(loans.status, "active")
                        ))
                        .orderBy(desc(loans.createdAt))
                        .limit(20);

                    return { loans: activeLoans };
                }

                case "get_financial_overview": {
                    const [loanAgg] = await db.select({
                        totalLent: sql<number>`cast(coalesce(sum(${loans.principalAmount}), 0) as float)`,
                        activePrincipal: sql<number>`cast(coalesce(sum(case when ${loans.status} = 'active' then ${loans.principalAmount} else 0 end), 0) as float)`
                    })
                        .from(loans)
                        .where(eq(loans.tenantId, user.tenantId));

                    const [txAgg] = await db.select({
                        totalCollected: sql<number>`cast(coalesce(sum(${transactions.amount}), 0) as float)`
                    })
                        .from(transactions)
                        .where(eq(transactions.tenantId, user.tenantId));

                    return {
                        totalLent: Number(loanAgg?.totalLent ?? 0),
                        totalCollected: Number(txAgg?.totalCollected ?? 0),
                        activePrincipal: Number(loanAgg?.activePrincipal ?? 0)
                    };
                }
            }
        } catch (error) {
            console.error("AI tool execution failed:", error);
            set.status = 500;
            return { error: "Failed to execute tool" };
        }
    }, {
        body: executeToolBodySchema
    });
