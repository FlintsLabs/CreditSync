import { Elysia, t } from "elysia";
import { db } from "../db";
import { borrowers, loans, transactions } from "../db/schema";
import { eq, and, desc, sql, inArray } from "drizzle-orm";
import { authPlugin } from "../middleware/auth";

// Define tool schemas for AI context
const toolsSchemas = [
    {
        name: "get_borrower_summary",
        description: "Get a summary of a specific borrower including their active loans, total outstanding balance, profile and credit score.",
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
        description: "Retrieve a list of all active loans for the current user/tenant.",
        parameters: {
            type: "object",
            properties: {},
            required: []
        }
    },
    {
        name: "get_financial_overview",
        description: "Get a high-level financial overview of the fund, including total lent, total collected, and total outstanding.",
        parameters: {
            type: "object",
            properties: {},
            required: []
        }
    }
];

export const aiToolsRoute = new Elysia({ prefix: "/ai-tools" })
    .use(authPlugin)
    .get("/tools", ({ user }) => {
        if (!user) throw new Error("Unauthorized");
        return toolsSchemas;
    })
    .post("/execute", async ({ body, user }) => {
        if (!user || !user.tenantId) {
            throw new Error("Unauthorized: Tenant context missing");
        }

        const { tool, parameters } = body as { tool: string; parameters: any };

        try {
            switch (tool) {
                case "get_borrower_summary": {
                    const borrowerId = Number(parameters.borrowerId);
                    if (isNaN(borrowerId)) {
                        return { error: "Invalid borrowerId" };
                    }

                    const borrower = await db.query.borrowers.findFirst({
                        where: and(
                            eq(borrowers.id, borrowerId),
                            eq(borrowers.tenantId, user.tenantId)
                        )
                    });

                    if (!borrower) {
                        return { error: "Borrower not found or unauthorized." };
                    }

                    const activeLoans = await db.select()
                        .from(loans)
                        .where(and(eq(loans.borrowerId, borrowerId), eq(loans.tenantId, user.tenantId), eq(loans.status, "active")));

                    const loanIds = activeLoans.map(l => l.id);
                    let totalPaid = 0;

                    if (loanIds.length > 0) {
                        // Get transactions for active loans using aggregation
                        const [txsResult] = await db.select({
                            total: sql<number>`cast(coalesce(sum(${transactions.amount}), 0) as float)`
                        })
                        .from(transactions)
                        .where(and(
                            eq(transactions.tenantId, user.tenantId),
                            inArray(transactions.loanId, loanIds)
                        ));

                        totalPaid = txsResult.total;
                    }

                    const totalPrincipal = activeLoans.reduce((sum, l) => sum + Number(l.principalAmount), 0);

                    return {
                        borrower: {
                            id: borrower.id,
                            name: borrower.name,
                            idCardNumber: borrower.idCardNumber,
                            creditScore: borrower.creditScore,
                            status: borrower.notes || "No notes available"
                        },
                        activeLoansCount: activeLoans.length,
                        totalPrincipalLent: totalPrincipal,
                        totalRepaid: totalPaid,
                        estimatedOutstandingPrincipal: totalPrincipal - totalPaid // Simplified for overview
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
                        },
                        orderBy: [desc(loans.createdAt)],
                        limit: 20
                    });

                    return {
                        loans: activeLoans.map(loan => ({
                            id: loan.id,
                            borrowerName: loan.borrower.name,
                            principalAmount: Number(loan.principalAmount),
                            installmentAmount: Number(loan.installmentAmount),
                            repaymentType: loan.repaymentType,
                            interestRate: Number(loan.interestRate),
                            startDate: loan.startDate
                        }))
                    };
                }

                case "get_financial_overview": {
                    // Aggregated financial overview
                    const [loanAgg] = await db.select({
                        totalLent: sql<number>`cast(coalesce(sum(${loans.principalAmount}), 0) as float)`,
                        activePrincipal: sql<number>`cast(coalesce(sum(case when ${loans.status} = 'active' then ${loans.principalAmount} else 0 end), 0) as float)`
                    }).from(loans).where(eq(loans.tenantId, user.tenantId));

                    const [txAgg] = await db.select({
                        totalCollected: sql<number>`cast(coalesce(sum(${transactions.amount}), 0) as float)`
                    }).from(transactions).where(eq(transactions.tenantId, user.tenantId));

                    return {
                        totalLent: loanAgg.totalLent,
                        totalCollected: txAgg.totalCollected,
                        activePrincipal: loanAgg.activePrincipal
                    };
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
