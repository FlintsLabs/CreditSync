import { Elysia, t } from "elysia";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { borrowers, loans, transactions } from "../db/schema";
import { authPlugin } from "../middleware/auth";
import { calculateLoanClosingSummary } from "../lib/calculator";

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
    },
    {
        name: "calculate_loan_payoff",
        description: "Calculate the pro-rated closing amount for a specific loan.",
        parameters: {
            type: "object",
            properties: {
                loanId: {
                    type: "number",
                    description: "The ID of the loan to calculate the payoff for."
                }
            },
            required: ["loanId"]
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
    }),
    t.Object({
        tool: t.Literal("calculate_loan_payoff"),
        parameters: t.Object({
            loanId: t.Number()
        })
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

                case "calculate_loan_payoff": {
                    const loanId = body.parameters.loanId;

                    const loan = await db.query.loans.findFirst({
                        where: and(
                            eq(loans.id, loanId),
                            eq(loans.tenantId, user.tenantId)
                        )
                    });

                    if (!loan) {
                        set.status = 404;
                        return { error: "Loan not found" };
                    }

                    const loanTransactions = await db.select()
                        .from(transactions)
                        .where(and(
                            eq(transactions.loanId, loanId),
                            eq(transactions.tenantId, user.tenantId)
                        ));

                    const summary = calculateLoanClosingSummary(loan, loanTransactions);

                    return summary;
                }
            }
        } catch (error) {
            console.error("AI tool execution failed:", error);
            set.status = 500;
            return { error: "Failed to execute tool" };
        }
    }, {
        body: executeToolBodySchema
    })
    .post("/chat", async ({ body, user, set }) => {
        if (!user?.tenantId) {
            set.status = 401;
            return { error: "Unauthorized" };
        }

        const { message } = body;
        const lowerMessage = message.toLowerCase();

        // Simple intent parsing for demonstration
        if (lowerMessage.includes("active loans") || lowerMessage.includes("สินเชื่อที่ยังใช้งานอยู่")) {
            return {
                reply: "Executing get_active_loans tool...",
                toolCall: { tool: "get_active_loans", parameters: {} }
            };
        } else if (lowerMessage.includes("financial overview") || lowerMessage.includes("ภาพรวมการเงิน")) {
             return {
                reply: "Executing get_financial_overview tool...",
                toolCall: { tool: "get_financial_overview", parameters: {} }
            };
        } else if (lowerMessage.includes("borrower summary") || lowerMessage.includes("ข้อมูลลูกหนี้")) {
            // Extract a simple ID if present, e.g. "borrower summary 1"
            const match = message.match(/\d+/);
            if (match) {
                 return {
                    reply: `Executing get_borrower_summary tool for ID ${match[0]}...`,
                    toolCall: { tool: "get_borrower_summary", parameters: { borrowerId: parseInt(match[0]) } }
                };
            } else {
                 return {
                    reply: "Please specify a borrower ID. Example: 'borrower summary 1'"
                };
            }
        } else if (lowerMessage.includes("calculate payoff") || lowerMessage.includes("คำนวณยอดปิด") || lowerMessage.includes("payoff")) {
             const match = message.match(/\d+/);
             if (match) {
                 return {
                    reply: `Executing calculate_loan_payoff tool for loan ID ${match[0]}...`,
                    toolCall: { tool: "calculate_loan_payoff", parameters: { loanId: parseInt(match[0]) } }
                };
             } else {
                 return {
                    reply: "Please specify a loan ID to calculate payoff. Example: 'calculate payoff 1'"
                 }
             }
        }

        return {
            reply: `I received your message: "${message}". I can help with active loans, financial overview, borrower summaries, and calculating loan payoffs. How can I help you?`
        };

    }, {
        body: t.Object({
            message: t.String()
        })
    });
