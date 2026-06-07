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
    .post("/chat", async ({ body, user, set }) => {
        // Architectural hook for MCP / AI Flow
        // This endpoint takes a raw message, routes it to the appropriate tool (simulated by regex for now),
        // and returns a unified conversational response along with the tool data.
        if (!user?.tenantId) {
            set.status = 401;
            return { error: "Unauthorized" };
        }

        const typedBody = body as { message: string };
        const textLower = (typedBody.message || "").toLowerCase();

        try {
            if (textLower.includes("overview") || textLower.includes("financial")) {
                const [loanAgg] = await db.select({
                    totalLent: sql<number>`cast(coalesce(sum(${loans.principalAmount}), 0) as float)`,
                    activePrincipal: sql<number>`cast(coalesce(sum(case when ${loans.status} = 'active' then ${loans.principalAmount} else 0 end), 0) as float)`
                }).from(loans).where(eq(loans.tenantId, user.tenantId));

                const [txAgg] = await db.select({
                    totalCollected: sql<number>`cast(coalesce(sum(${transactions.amount}), 0) as float)`
                }).from(transactions).where(eq(transactions.tenantId, user.tenantId));

                const data = {
                    totalLent: Number(loanAgg?.totalLent ?? 0),
                    totalCollected: Number(txAgg?.totalCollected ?? 0),
                    activePrincipal: Number(loanAgg?.activePrincipal ?? 0)
                };

                return {
                    response: `Financial Overview:\n- Total Lent: $${data.totalLent}\n- Total Collected: $${data.totalCollected}\n- Active Principal: $${data.activePrincipal}`,
                    tools_called: ["get_financial_overview"],
                    data
                };
            } else if (textLower.includes("active loan") || textLower.includes("loans")) {
                const activeLoans = await db.select({
                    id: loans.id,
                    borrowerName: borrowers.name,
                    principalAmount: loans.principalAmount,
                })
                .from(loans)
                .leftJoin(borrowers, eq(loans.borrowerId, borrowers.id))
                .where(and(eq(loans.tenantId, user.tenantId), eq(loans.status, "active")))
                .orderBy(desc(loans.createdAt))
                .limit(20);

                let replyContent = `Active Loans (${activeLoans.length}):\n` +
                    activeLoans.slice(0, 5).map((l: any) => `- Loan #${l.id}: ${l.borrowerName || 'Unknown'} - $${l.principalAmount}`).join("\n");

                if (activeLoans.length > 5) replyContent += `\n...and ${activeLoans.length - 5} more.`;

                return {
                    response: replyContent,
                    tools_called: ["get_active_loans"],
                    data: { loans: activeLoans }
                };
            } else if (textLower.includes("borrower") || textLower.includes("summary")) {
                const match = textLower.match(/\d+/);
                if (match) {
                    const borrowerId = parseInt(match[0], 10);
                    const borrower = await db.query.borrowers.findFirst({
                        where: and(eq(borrowers.id, borrowerId), eq(borrowers.tenantId, user.tenantId))
                    });

                    if (!borrower) {
                        return { response: "Borrower not found." };
                    }

                    const activeLoans = await db.select().from(loans).where(and(eq(loans.borrowerId, borrowerId), eq(loans.tenantId, user.tenantId), eq(loans.status, "active")));
                    const loanIds = activeLoans.map((loan) => loan.id);
                    let totalPaid = 0;

                    if (loanIds.length > 0) {
                        const [txsResult] = await db.select({
                            total: sql<number>`cast(coalesce(sum(${transactions.amount}), 0) as float)`
                        }).from(transactions).where(and(eq(transactions.tenantId, user.tenantId), inArray(transactions.loanId, loanIds)));
                        totalPaid = Number(txsResult?.total ?? 0);
                    }

                    const totalPrincipal = activeLoans.reduce((sum, loan) => sum + Number(loan.principalAmount), 0);
                    const data = {
                        borrower: { id: borrower.id, name: borrower.name, creditScore: borrower.creditScore },
                        activeLoansCount: activeLoans.length,
                        totalPrincipalLent: totalPrincipal,
                        totalRepaid: totalPaid,
                        estimatedOutstandingPrincipal: totalPrincipal - totalPaid
                    };

                    const replyContent = `Borrower Summary (${data.borrower?.name || 'Unknown'}):\n- Credit Score: ${data.borrower?.creditScore || 'N/A'}\n- Active Loans: ${data.activeLoansCount || 0}\n- Total Lent: $${data.totalPrincipalLent || 0}\n- Total Repaid: $${data.totalRepaid || 0}\n- Estimated Outstanding: $${data.estimatedOutstandingPrincipal || 0}`;

                    return {
                        response: replyContent,
                        tools_called: ["get_borrower_summary"],
                        data
                    };
                } else {
                    return { response: "Please provide a borrower ID. For example: 'borrower 1 summary'" };
                }
            } else {
                return { response: "I'm sorry, I don't understand. I can help you with a financial overview, active loans, or a borrower summary (please provide an ID)." };
            }
        } catch (error) {
            console.error("AI chat tool error:", error);
            set.status = 500;
            return { error: "Failed to process chat message" };
        }
    }, {
        body: t.Object({
            message: t.String()
        })
    })
    .get("/tools", ({ user, set }) => {
        if (!user?.tenantId) {
            set.status = 401;
            return { error: "Unauthorized" };
        }

        return toolsSchemas;
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
