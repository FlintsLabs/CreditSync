import { Elysia, t } from "elysia";
import { db } from "../db";
import { loans, borrowers, bankLoans } from "../db/schema";
import { eq, desc } from "drizzle-orm";
import { calculateLoanSchedule, LoanCalculationParams, RepaymentType } from "../lib/calculator";

export const loansRoute = new Elysia({ prefix: "/loans" })
    .get("/", async () => {
        // TODO: Context Tenant
        return await db.select({
            id: loans.id,
            borrowerName: borrowers.name,
            principal: loans.principalAmount,
            status: loans.status,
            createdAt: loans.createdAt
        })
            .from(loans)
            .leftJoin(borrowers, eq(loans.borrowerId, borrowers.id))
            .where(eq(loans.tenantId, "default_tenant"))
            .orderBy(desc(loans.createdAt));
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
    .post("/", async ({ body }) => {
        const result = await db.insert(loans).values({
            tenantId: "default_tenant",
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
