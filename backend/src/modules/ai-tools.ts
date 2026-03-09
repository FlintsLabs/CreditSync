import { Elysia, t } from "elysia";
import { db } from "../db";
import { borrowers, loans, transactions } from "../db/schema";
import { eq, and } from "drizzle-orm";
import { authPlugin } from "../middleware/auth";

/**
 * AI Tools Module (MCP / Flow Ready)
 *
 * This module exposes specific endpoints designed to be called by
 * AI agents (like Model Context Protocol or custom AI flows).
 * The endpoints return structured data or perform specific calculations
 * that are useful for AI-driven summaries, risk assessments, or insights.
 */
export const aiToolsRoute = new Elysia({ prefix: "/ai/tools" })
    .use(authPlugin)

    // Tool: Summarize a specific borrower's financial standing
    .post("/summarize-borrower", async ({ body, user, set }) => {
        if (!user) {
            set.status = 401;
            return { error: "Unauthorized" };
        }

        const borrower = await db.query.borrowers.findFirst({
            where: and(eq(borrowers.id, body.borrowerId), eq(borrowers.tenantId, user.tenantId))
        });

        if (!borrower) {
            set.status = 404;
            return { error: "Borrower not found" };
        }

        const activeLoans = await db.query.loans.findMany({
            where: and(eq(loans.borrowerId, borrower.id), eq(loans.status, "active"))
        });

        const totalActivePrincipal = activeLoans.reduce((sum, loan) => sum + Number(loan.principalAmount), 0);

        // This structured response is intended for an LLM to read and summarize
        return {
            borrowerInfo: {
                id: borrower.id,
                name: borrower.name,
                creditScore: borrower.creditScore,
                tags: borrower.tags
            },
            financialSummary: {
                totalActiveLoansCount: activeLoans.length,
                totalActivePrincipal: totalActivePrincipal,
                loans: activeLoans.map(l => ({
                    id: l.id,
                    principal: l.principalAmount,
                    interestRate: l.interestRate,
                    repaymentType: l.repaymentType
                }))
            },
            aiInstruction: "Based on this data, assess the risk of lending more money to this borrower."
        };
    }, {
        body: t.Object({
            borrowerId: t.Number({ description: "The ID of the borrower to summarize" })
        }),
        detail: {
            tags: ["AI Tools"],
            description: "Fetches a comprehensive financial summary of a specific borrower for AI context."
        }
    })

    // Tool: Calculate Portfolio Risk or ROI estimation (Simplified)
    .post("/portfolio-insight", async ({ user, set }) => {
        if (!user) {
            set.status = 401;
            return { error: "Unauthorized" };
        }

        // Fetching high-level metrics for an AI to analyze
        const allActiveLoans = await db.select({
            principal: loans.principalAmount,
            interestRate: loans.interestRate
        }).from(loans).where(and(eq(loans.tenantId, user.tenantId), eq(loans.status, "active")));

        const totalLentOut = allActiveLoans.reduce((sum, loan) => sum + Number(loan.principal), 0);

        // Rough expected return calculation based on principal * interest rate
        const expectedReturn = allActiveLoans.reduce((sum, loan) => sum + (Number(loan.principal) * (Number(loan.interestRate) / 100)), 0);

        return {
            portfolioMetrics: {
                totalActiveLoans: allActiveLoans.length,
                totalCapitalDeployed: totalLentOut,
                estimatedExpectedReturn: expectedReturn,
                estimatedRoiPercentage: totalLentOut > 0 ? ((expectedReturn / totalLentOut) * 100).toFixed(2) : 0
            },
            aiInstruction: "Analyze these portfolio metrics. Is the ROI percentage healthy? What recommendations can you provide?"
        };
    }, {
        detail: {
            tags: ["AI Tools"],
            description: "Provides high-level portfolio metrics (Total Lent, Expected Return) for AI-driven insights."
        }
    });
