export interface DashboardSummary {
    dueFromBorrowersToday: string;
    dueToFundsToday: string;
    netPositionToday: string;
    overdueBorrowerCount: number;
    overdueFundCount: number;
    underfundedLoanCount: number;
    unallocatedDrawdownCount: number;
}

export interface BorrowerDueItem {
    scheduleId: number;
    schedulePublicId?: string;
    dueDate: string;
    remainingDue: string;
    penaltyDue?: string;
    totalDueNow?: string;
    overdueDays?: number;
    status: string;
    installmentNo: number;
    loanId: number;
    loanPublicId?: string;
    borrowerName: string;
    repaymentType: string;
}

export interface FundDueItem {
    scheduleId: number;
    schedulePublicId?: string;
    dueDate: string;
    remainingDue: string;
    penaltyDue?: string;
    totalDueNow?: string;
    overdueDays?: number;
    status: string;
    installmentNo: number;
    bankLoanId: number;
    bankLoanPublicId?: string;
    bankProfileId: number | null;
    bankProfilePublicId?: string | null;
    note: string | null;
}

export interface FundingAlerts {
    underfundedLoans: Array<{ id: number; publicId?: string; borrowerName: string; principalAmount: string; fundedAmount: string; gap: string }>;
    unallocatedDrawdowns: Array<{ id: number; publicId?: string; bankProfileId: number | null; bankProfilePublicId?: string | null; totalAmount: string; allocatedAmount: string; availableAmount: string; nextDueDate: string | null }>;
}

export interface ReconciliationStatus {
    unreconciledBorrowerPayments: number;
    recordedFundRepayments: number;
    fundRepaymentsMissingScheduleLink: number;
    pendingBankImports: number;
    pendingManualReviews: number;
    borrowerPaymentsMissingSlip: number;
}

export interface ProfitabilitySummary {
    borrowerRevenueCollected: string;
    fundCostPaid: string;
    realizedSpread: string;
    unrealizedSpread: string;
    deployedPrincipal: string;
    netCashPosition: string;
    realizedRoiPercent: string;
    carryForwardAvailable: string;
}

export interface DashboardInputs { summary: DashboardSummary | null; reconciliation: ReconciliationStatus | null }

export type DashboardPriorityKey = "overdueBorrowers" | "overdueFunds" | "underfundedLoans" | "missingFundSchedule" | "unallocatedDrawdowns" | "pendingReviews" | "missingSlips";
export interface DashboardPriority { key: DashboardPriorityKey; count: number; href: string; tone: "danger" | "warning" | "attention" }

export function buildDashboardPriorities({ summary, reconciliation }: DashboardInputs): DashboardPriority[] {
    const candidates: DashboardPriority[] = [
        { key: "overdueBorrowers", count: summary?.overdueBorrowerCount ?? 0, href: "/transactions/new", tone: "danger" },
        { key: "overdueFunds", count: summary?.overdueFundCount ?? 0, href: "/funds", tone: "danger" },
        { key: "underfundedLoans", count: summary?.underfundedLoanCount ?? 0, href: "/matching", tone: "warning" },
        { key: "missingFundSchedule", count: reconciliation?.fundRepaymentsMissingScheduleLink ?? 0, href: "/reconciliation", tone: "warning" },
        { key: "unallocatedDrawdowns", count: summary?.unallocatedDrawdownCount ?? 0, href: "/funds", tone: "attention" },
        { key: "pendingReviews", count: (reconciliation?.pendingManualReviews ?? 0) + (reconciliation?.pendingBankImports ?? 0), href: "/payments", tone: "attention" },
        { key: "missingSlips", count: reconciliation?.borrowerPaymentsMissingSlip ?? 0, href: "/payments", tone: "attention" },
    ];
    return candidates.filter((item) => item.count > 0);
}

function moneyCents(value: string) {
    const match = value.trim().match(/^(-?)(\d+)(?:\.(\d{1,2}))?$/);
    if (!match) return 0n;
    const cents = BigInt(match[2]) * 100n + BigInt((match[3] ?? "").padEnd(2, "0"));
    return match[1] ? -cents : cents;
}

export function compareMoney(left: string, right: string) {
    const difference = moneyCents(left) - moneyCents(right);
    return difference === 0n ? 0 : difference > 0n ? 1 : -1;
}
