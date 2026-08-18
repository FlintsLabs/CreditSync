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
    scheduleId: number | null;
    schedulePublicId?: string;
    dueDate: string | null;
    remainingDue: string;
    penaltyDue?: string;
    totalDueNow?: string;
    overdueDays?: number;
    overdueItemCount?: number;
    status: string;
    installmentNo: number | null;
    loanId: number;
    loanPublicId?: string;
    borrowerName: string;
    repaymentType: string;
}

export function buildBorrowerRepaymentHref(item: BorrowerDueItem) {
    const parameters = new URLSearchParams({ loanId: String(item.loanPublicId ?? item.loanId) });
    const scheduleId = item.schedulePublicId ?? item.scheduleId;
    if (scheduleId !== null && scheduleId !== undefined) parameters.set("scheduleId", String(scheduleId));
    return `/transactions/new?${parameters.toString()}`;
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

export function getCollectionRatePercent(collected: string, expected: string) {
    const expectedCents = moneyCents(expected);
    if (expectedCents <= 0n) return "0.00";
    const scaledPercent = (moneyCents(collected) * 10000n * 2n + expectedCents) / (expectedCents * 2n);
    const whole = scaledPercent / 100n;
    const fraction = (scaledPercent % 100n).toString().padStart(2, "0");
    return `${whole}.${fraction}`;
}

export interface DashboardAnalytics {
    collectionRate: { expected: string; actual: string };
    daily: Array<{ date: string; expected: string; actual: string; interest: string }>;
    monthly: Array<{ month: string; expectedInterest: string; actualInterest: string }>;
    deployedPrincipal: string;
    outstandingPrincipal: string;
}
