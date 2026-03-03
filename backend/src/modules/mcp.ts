import { Elysia } from "elysia";
import { db } from "../db";
import { loans, borrowers, transactions } from "../db/schema";
import { eq, desc } from "drizzle-orm";

export const mcpRoute = new Elysia({ prefix: "/mcp" })
    .get("/loans", async () => {
        // AI Endpoint for listing all active loans and borrower data
        const loanList = await db.select({
            id: loans.id,
            principal: loans.principalAmount,
            status: loans.status,
            repaymentType: loans.repaymentType,
            interestRate: loans.interestRate,
            borrowerName: borrowers.name,
            borrowerCreditScore: borrowers.creditScore
        })
        .from(loans)
        .leftJoin(borrowers, eq(loans.borrowerId, borrowers.id))
        .orderBy(desc(loans.createdAt));

        return loanList;
    })
    .get("/transactions", async () => {
        // AI Endpoint for viewing recent transactions globally
        const txList = await db.select({
            id: transactions.id,
            amount: transactions.amount,
            type: transactions.type,
            date: transactions.transactionDate,
        })
        .from(transactions)
        .orderBy(desc(transactions.transactionDate))
        .limit(50);

        return txList;
    })
    .get("/portfolio", async () => {
        // AI Endpoint for summarizing total expected vs actual repayment
        // This is a basic mock return, actual will compute over sums
        return {
            totalActiveLoans: 120,
            totalPrincipalLent: "2500000.00",
            totalCollected: "450000.00",
            healthScore: 85
        };
    });
