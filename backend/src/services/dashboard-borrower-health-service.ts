import { and, eq } from "drizzle-orm";
import { borrowers, loans } from "../db/schema";
import { getLoanPaymentHealth } from "./loan-payment-health-service";

type Executor = any;

export interface DashboardBorrowerHealthRow {
    loanId: number;
    loanPublicId: string;
    borrowerName: string;
    repaymentType: string;
    status: "current" | "due_today" | "overdue" | "settled";
    dueTodayAmount: string;
    overdueAmount: string;
    overdueItemCount: number;
    maxOverdueDays: number;
}

export async function getDashboardBorrowerHealth(
    executor: Executor,
    input: { tenantId: string; actorUserId: number; asOf: Date },
): Promise<DashboardBorrowerHealthRow[]> {
    const [tenantLoans, tenantBorrowers] = await Promise.all([
        executor.select().from(loans).where(and(eq(loans.tenantId, input.tenantId), eq(loans.status, "active"))),
        executor.select().from(borrowers).where(eq(borrowers.tenantId, input.tenantId)),
    ]);
    const borrowerNames = new Map<number, string>(tenantBorrowers.map((borrower: typeof borrowers.$inferSelect) => [borrower.id, borrower.name]));
    const rows: DashboardBorrowerHealthRow[] = [];

    for (const loan of tenantLoans as Array<typeof loans.$inferSelect>) {
        const health = await getLoanPaymentHealth(executor, loan, { asOf: input.asOf, actorUserId: input.actorUserId });
        rows.push({
            loanId: loan.id,
            loanPublicId: loan.publicId,
            borrowerName: borrowerNames.get(loan.borrowerId) ?? "",
            repaymentType: loan.repaymentType,
            ...health,
        });
    }

    return rows;
}
