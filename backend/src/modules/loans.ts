import { Elysia, t } from "elysia";
import { db } from "../db";
import { loans, borrowers, transactions } from "../db/schema";
import { eq, desc, and } from "drizzle-orm";
import { calculateLoanSchedule, LoanCalculationParams, RepaymentType, calculateLoanClosingSummary } from "../lib/calculator";

import { authPlugin } from "../middleware/auth";

export const loansRoute = new Elysia({ prefix: "/loans" })
    .use(authPlugin)
    .get("/", async ({ user }) => {
        if (!user) return [];
        // This is a simplified query for a list view.
        // A real app might need more complex aggregation for total paid, etc.
        const loanList = await db.select({
            id: loans.id,
            borrowerName: borrowers.name,
            principal: loans.principalAmount,
            status: loans.status,
            createdAt: loans.createdAt,
            repaymentType: loans.repaymentType,
            interestRate: loans.interestRate,
        })
            .from(loans)
            .leftJoin(borrowers, eq(loans.borrowerId, borrowers.id))
            .where(eq(loans.tenantId, user.tenantId))
            .orderBy(desc(loans.createdAt));
        
        return loanList;
    })
    .get("/:id/closing-summary", async ({ params, user, set }) => {
        if (!user) {
            set.status = 401;
            return { error: "Unauthorized" };
        }

        const loanId = params.id;

        const loan = await db.query.loans.findFirst({
            where: and(eq(loans.id, loanId), eq(loans.tenantId, user.tenantId))
        });

        if (!loan) {
            set.status = 404;
            return { error: "Loan not found" };
        }

        const loanTransactions = await db.select()
            .from(transactions)
            .where(and(eq(transactions.loanId, loanId), eq(transactions.tenantId, user.tenantId)));

        const summary = calculateLoanClosingSummary(loan, loanTransactions);

        return summary;
    }, {
        params: t.Object({
            id: t.Numeric()
        })
    })
    .post("/calculate", ({ body }) => {
        const schedule = calculateLoanSchedule({
            principal: body.principal,
            interestRate: body.interestRate,
            termMonths: body.termMonths,
            repaymentType: body.repaymentType as RepaymentType,
            startDate: new Date(body.startDate)
        });
        return schedule;
    }, {
        body: t.Object({
            principal: t.Number(),
            interestRate: t.Number(),
            termMonths: t.Number(),
            repaymentType: t.String(),
            startDate: t.String()
        })
    })
    .post("/", async ({ body, user }) => {
        if (!user) throw new Error("Unauthorized");
        const result = await db.insert(loans).values({
            tenantId: user.tenantId,
            borrowerId: body.borrowerId,
            bankLoanId: body.bankLoanId,
            principalAmount: body.principal.toString(),
            interestRate: body.interestRate.toString(),
            repaymentType: body.repaymentType,
            totalInstallments: body.totalInstallments,
            installmentAmount: body.installmentAmount.toString(),
            startDate: body.startDate,
            status: "active"
        }).returning();

        return result[0];
    }, {
        body: t.Object({
            borrowerId: t.Number(),
            bankLoanId: t.Optional(t.Number()),
            principal: t.Number(),
            interestRate: t.Number(),
            repaymentType: t.String(),
            totalInstallments: t.Number(),
            installmentAmount: t.Number(),
            startDate: t.String()
        })
    });
