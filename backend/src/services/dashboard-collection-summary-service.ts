import { compareDashboardMoneyDescending, isPositiveDashboardMoney, sumDashboardMoney } from "../lib/dashboard-money";

export const dashboardCollectionCategoryKeys = [
    "floating_daily_interest",
    "floating_weekly_interest",
    "daily_installment",
    "weekly_installment",
    "monthly_installment",
    "other",
] as const;

export type DashboardCollectionCategoryKey = typeof dashboardCollectionCategoryKeys[number];

export interface DashboardCollectionLoan {
    loanId: number;
    loanPublicId: string;
    borrowerName: string;
    repaymentType: string;
    interestPeriodUnit?: string | null;
    floatingAccrualCycle?: string | null;
    dueTodayAmount: string;
}

export interface DashboardCollectionAssignment {
    loanId: number;
    intermediaryPublicId: string;
    intermediaryName: string;
    role: string;
    status: string;
    effectiveFrom: string;
    effectiveTo: string | null;
}

interface DashboardCollectionItem {
    loanPublicId: string;
    borrowerName: string;
    dueTodayAmount: string;
}

export interface DashboardCollectionSummary {
    totalDueToday: string;
    categories: Array<{ key: DashboardCollectionCategoryKey; totalDueToday: string; items: DashboardCollectionItem[] }>;
    intermediaries: Array<{ intermediaryPublicId: string; intermediaryName: string; totalDueToday: string; items: DashboardCollectionItem[] }>;
}

function categoryForLoan(loan: DashboardCollectionLoan): DashboardCollectionCategoryKey {
    if (loan.repaymentType === "floating") {
        return loan.interestPeriodUnit === "week" || loan.floatingAccrualCycle === "weekly"
            ? "floating_weekly_interest"
            : "floating_daily_interest";
    }
    if (loan.repaymentType === "daily") return "daily_installment";
    if (loan.repaymentType === "weekly") return "weekly_installment";
    if (loan.repaymentType === "monthly") return "monthly_installment";
    return "other";
}

function isCurrentCollectionAssignment(assignment: DashboardCollectionAssignment, businessDate: string) {
    return assignment.status === "active"
        && (assignment.role === "collection" || assignment.role === "both")
        && assignment.effectiveFrom.slice(0, 10) <= businessDate
        && (!assignment.effectiveTo || assignment.effectiveTo.slice(0, 10) > businessDate);
}

export function buildDashboardCollectionSummary(input: {
    businessDate: string;
    loans: DashboardCollectionLoan[];
    assignments: DashboardCollectionAssignment[];
}): DashboardCollectionSummary {
    const dueLoans = input.loans.filter((loan) => isPositiveDashboardMoney(loan.dueTodayAmount));
    const itemFor = (loan: DashboardCollectionLoan): DashboardCollectionItem => ({
        loanPublicId: loan.loanPublicId,
        borrowerName: loan.borrowerName,
        dueTodayAmount: loan.dueTodayAmount,
    });
    const categories = dashboardCollectionCategoryKeys.map((key) => {
        const loans = dueLoans.filter((loan) => categoryForLoan(loan) === key);
        return { key, totalDueToday: sumDashboardMoney(loans.map((loan) => loan.dueTodayAmount)), items: loans.map(itemFor) };
    });
    const assignmentByLoanId = new Map(
        input.assignments
            .filter((assignment) => isCurrentCollectionAssignment(assignment, input.businessDate))
            .map((assignment) => [assignment.loanId, assignment]),
    );
    const intermediaryItems = new Map<string, { intermediaryName: string; items: DashboardCollectionItem[] }>();
    for (const loan of dueLoans) {
        const assignment = assignmentByLoanId.get(loan.loanId);
        if (!assignment) continue;
        const current = intermediaryItems.get(assignment.intermediaryPublicId) ?? { intermediaryName: assignment.intermediaryName, items: [] };
        current.items.push(itemFor(loan));
        intermediaryItems.set(assignment.intermediaryPublicId, current);
    }
    const intermediaries = [...intermediaryItems.entries()]
        .map(([intermediaryPublicId, value]) => ({
            intermediaryPublicId,
            intermediaryName: value.intermediaryName,
            totalDueToday: sumDashboardMoney(value.items.map((item) => item.dueTodayAmount)),
            items: value.items,
        }))
        .sort((left, right) => compareDashboardMoneyDescending(left.totalDueToday, right.totalDueToday) || left.intermediaryName.localeCompare(right.intermediaryName));

    return {
        totalDueToday: sumDashboardMoney(dueLoans.map((loan) => loan.dueTodayAmount)),
        categories,
        intermediaries,
    };
}
