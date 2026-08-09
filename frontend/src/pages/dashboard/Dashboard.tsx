import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AlertTriangle, ArrowRightLeft, CalendarClock, CreditCard, DollarSign, Users } from "lucide-react";
import { api } from "../../lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { Badge } from "../../components/ui/badge";
import { useTranslation } from "react-i18next";
import { getStoredUser, isTenantAdminUser } from "../../lib/session";

interface DashboardSummary {
    dueFromBorrowersToday: number;
    dueToFundsToday: number;
    netPositionToday: number;
    overdueBorrowerCount: number;
    overdueFundCount: number;
    underfundedLoanCount: number;
    unallocatedDrawdownCount: number;
}

interface BorrowerDueItem {
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

interface FundDueItem {
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

interface FundingAlerts {
    underfundedLoans: Array<{
        id: number;
        publicId?: string;
        borrowerName: string;
        principalAmount: number;
        fundedAmount: number;
        gap: number;
    }>;
    unallocatedDrawdowns: Array<{
        id: number;
        publicId?: string;
        bankProfileId: number | null;
        bankProfilePublicId?: string | null;
        totalAmount: number;
        allocatedAmount: number;
        availableAmount: number;
        nextDueDate: string | null;
    }>;
}

interface ReconciliationStatus {
    unreconciledBorrowerPayments: number;
    recordedFundRepayments: number;
    fundRepaymentsMissingScheduleLink: number;
    pendingBankImports: number;
    pendingManualReviews: number;
    borrowerPaymentsMissingSlip: number;
}

interface ProfitabilitySummary {
    borrowerRevenueCollected: number;
    fundCostPaid: number;
    realizedSpread: number;
    unrealizedSpread: number;
    deployedPrincipal: number;
    netCashPosition: number;
    realizedRoiPercent: number;
    carryForwardAvailable: number;
}

function formatCurrency(value: number, locale?: string) {
    return `฿${value.toLocaleString(locale, {
        minimumFractionDigits: 0,
        maximumFractionDigits: 2,
    })}`;
}

function isPastDue(date: string) {
    return date < new Date().toISOString().slice(0, 10);
}

function QueueBadge({ dueDate, status }: { dueDate: string; status: string }) {
    return (
        <Badge variant={isPastDue(dueDate) ? "destructive" : "secondary"}>
            {status}
        </Badge>
    );
}

function openBorrowerRepayment(navigate: ReturnType<typeof useNavigate>, item: BorrowerDueItem) {
    navigate(`/transactions/new?loanId=${item.loanPublicId ?? item.loanId}&scheduleId=${item.schedulePublicId ?? item.scheduleId}`);
}

function openFundRepayment(navigate: ReturnType<typeof useNavigate>, item: FundDueItem) {
    if (!item.bankProfilePublicId && !item.bankProfileId) {
        navigate("/funds");
        return;
    }

    navigate(`/funds/${item.bankProfilePublicId ?? item.bankProfileId}?bankLoanId=${item.bankLoanPublicId ?? item.bankLoanId}&scheduleId=${item.schedulePublicId ?? item.scheduleId}`);
}

export default function Dashboard() {
    const { t, i18n } = useTranslation();
    const navigate = useNavigate();
    const currentUser = getStoredUser();
    const isTenantAdmin = isTenantAdminUser(currentUser);
    const [loading, setLoading] = useState(true);
    const [errorMessage, setErrorMessage] = useState("");
    const [summary, setSummary] = useState<DashboardSummary | null>(null);
    const [borrowerQueue, setBorrowerQueue] = useState<BorrowerDueItem[]>([]);
    const [fundQueue, setFundQueue] = useState<FundDueItem[]>([]);
    const [alerts, setAlerts] = useState<FundingAlerts>({ underfundedLoans: [], unallocatedDrawdowns: [] });
    const [reconciliation, setReconciliation] = useState<ReconciliationStatus | null>(null);
    const [profitability, setProfitability] = useState<ProfitabilitySummary | null>(null);

    useEffect(() => {
        if (!isTenantAdmin) {
            navigate("/loans", { replace: true });
            return;
        }

        const loadDashboard = async () => {
            try {
                setLoading(true);
                setErrorMessage("");

                const [summaryRes, borrowerQueueRes, fundQueueRes, alertsRes, reconciliationRes, profitabilityRes] = await Promise.all([
                    api.get("/dashboard/summary"),
                    api.get("/dashboard/borrower-due-queue"),
                    api.get("/dashboard/fund-due-queue"),
                    api.get("/dashboard/funding-alerts"),
                    api.get("/dashboard/reconciliation-status"),
                    api.get("/dashboard/profitability-summary"),
                ]);

                setSummary(summaryRes.data ?? null);
                setBorrowerQueue(borrowerQueueRes.data ?? []);
                setFundQueue(fundQueueRes.data ?? []);
                setAlerts(alertsRes.data ?? { underfundedLoans: [], unallocatedDrawdowns: [] });
                setReconciliation(reconciliationRes.data ?? null);
                setProfitability(profitabilityRes.data ?? null);
            } catch (error) {
                console.error("Failed to load dashboard", error);
                setErrorMessage(t("dashboardPage.errors.load", "Unable to load the live dashboard right now."));
            } finally {
                setLoading(false);
            }
        };

        loadDashboard();
    }, [isTenantAdmin, navigate, t]);

    const borrowerDueNow = useMemo(() => borrowerQueue.slice(0, 8), [borrowerQueue]);
    const fundDueNow = useMemo(() => fundQueue.slice(0, 8), [fundQueue]);
    const overdueTotal = (summary?.overdueBorrowerCount ?? 0) + (summary?.overdueFundCount ?? 0);

    return (
        <div className="flex-1 space-y-8 p-4 pt-6">
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <div>
                    <h2 className="text-3xl font-bold tracking-tight">{t("dashboardPage.title", "Operations Dashboard")}</h2>
                    <p className="text-sm text-muted-foreground">
                        {t("dashboardPage.description", "Incoming cash, outgoing obligations, and funding gaps in one view")}
                    </p>
                </div>
                <div className="flex flex-wrap gap-2">
                    <Button variant="outline" onClick={() => navigate("/transactions/new")}>
                        {t("dashboardPage.actions.recordBorrowerPayment", "Record Borrower Payment")}
                    </Button>
                    <Button variant="outline" onClick={() => navigate("/funds")}>
                        {t("dashboardPage.actions.openFunds", "Open Funds")}
                    </Button>
                    <Button onClick={() => navigate("/matching")}>
                        {t("dashboardPage.actions.openMatching", "Open Matching")}
                    </Button>
                </div>
            </div>

            {errorMessage && (
                <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                    {errorMessage}
                </div>
            )}

            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                <Card>
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium">{t("dashboardPage.cards.dueFromBorrowers", "Due from Borrowers")}</CardTitle>
                        <DollarSign className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold">{loading ? "..." : formatCurrency(summary?.dueFromBorrowersToday ?? 0, i18n.language)}</div>
                        <p className="text-xs text-muted-foreground">{t("dashboardPage.cards.dueFromBorrowersDesc", "Scheduled cash expected from borrower schedules")}</p>
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium">{t("dashboardPage.cards.dueToFunds", "Due to Funds")}</CardTitle>
                        <CreditCard className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold">{loading ? "..." : formatCurrency(summary?.dueToFundsToday ?? 0, i18n.language)}</div>
                        <p className="text-xs text-muted-foreground">{t("dashboardPage.cards.dueToFundsDesc", "Scheduled repayments due back to funds or banks")}</p>
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium">{t("dashboardPage.cards.netPosition", "Net Position Today")}</CardTitle>
                        <CalendarClock className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                        <div className={`text-2xl font-bold ${(summary?.netPositionToday ?? 0) >= 0 ? "text-emerald-600" : "text-destructive"}`}>
                            {loading ? "..." : formatCurrency(summary?.netPositionToday ?? 0, i18n.language)}
                        </div>
                        <p className="text-xs text-muted-foreground">{t("dashboardPage.cards.netPositionDesc", "Incoming due today minus outgoing obligations due today")}</p>
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium">{t("dashboardPage.cards.overdueItems", "Overdue Items")}</CardTitle>
                        <AlertTriangle className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold">{loading ? "..." : overdueTotal}</div>
                        <p className="text-xs text-muted-foreground">
                            {t("dashboardPage.cards.overdueBreakdown", { defaultValue: "Borrowers {{borrowers}} • Funds {{funds}}", borrowers: summary?.overdueBorrowerCount ?? 0, funds: summary?.overdueFundCount ?? 0 })}
                        </p>
                    </CardContent>
                </Card>
            </div>

            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                <Card>
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium">{t("dashboardPage.cards.borrowerRevenue", "Borrower Revenue Collected")}</CardTitle>
                        <DollarSign className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold">{loading ? "..." : formatCurrency(profitability?.borrowerRevenueCollected ?? 0, i18n.language)}</div>
                        <p className="text-xs text-muted-foreground">{t("dashboardPage.cards.borrowerRevenueDesc", "Collected interest, fees, and penalties")}</p>
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium">{t("dashboardPage.cards.fundCostPaid", "Fund Cost Paid")}</CardTitle>
                        <CreditCard className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold">{loading ? "..." : formatCurrency(profitability?.fundCostPaid ?? 0, i18n.language)}</div>
                        <p className="text-xs text-muted-foreground">{t("dashboardPage.cards.fundCostPaidDesc", "Upstream interest, fees, VAT, and penalties already paid")}</p>
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium">{t("dashboardPage.cards.realizedSpread", "Realized Spread")}</CardTitle>
                        <CalendarClock className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                        <div className={`text-2xl font-bold ${(profitability?.realizedSpread ?? 0) >= 0 ? "text-emerald-600" : "text-destructive"}`}>
                            {loading ? "..." : formatCurrency(profitability?.realizedSpread ?? 0, i18n.language)}
                        </div>
                        <p className="text-xs text-muted-foreground">
                            ROI {profitability?.realizedRoiPercent?.toFixed(2) ?? "0.00"}% on deployed principal
                        </p>
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium">{t("dashboardPage.cards.unrealizedSpread", "Unrealized Spread")}</CardTitle>
                        <AlertTriangle className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                        <div className={`text-2xl font-bold ${(profitability?.unrealizedSpread ?? 0) >= 0 ? "text-emerald-600" : "text-destructive"}`}>
                            {loading ? "..." : formatCurrency(profitability?.unrealizedSpread ?? 0, i18n.language)}
                        </div>
                        <p className="text-xs text-muted-foreground">{t("dashboardPage.cards.unrealizedSpreadDesc", "Spread still locked in open contracts and installments")}</p>
                    </CardContent>
                </Card>
            </div>

            <div className="grid gap-4 xl:grid-cols-[1.3fr_0.9fr]">
                <Card>
                    <CardHeader className="flex flex-row items-center justify-between">
                        <CardTitle>{t("dashboardPage.sections.fundingAlerts", "Funding Alerts")}</CardTitle>
                        <Button size="sm" variant="outline" onClick={() => navigate("/matching")}>
                            {t("dashboardPage.actions.openMatchingWorkspace", "Open Matching Workspace")}
                        </Button>
                    </CardHeader>
                    <CardContent className="grid gap-4 lg:grid-cols-2">
                        <div className="space-y-3">
                            <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2 text-sm font-medium">
                                    <Users className="h-4 w-4" />
                                    {t("dashboardPage.sections.underfundedLoans", "Underfunded Loans")}
                                </div>
                                <Badge>{summary?.underfundedLoanCount ?? 0}</Badge>
                            </div>

                            {alerts.underfundedLoans.length === 0 ? (
                                <div className="rounded border border-dashed p-4 text-sm text-muted-foreground">
                                    {t("dashboardPage.empty.noUnderfundedLoans", "No underfunded loans right now.")}
                                </div>
                            ) : (
                                alerts.underfundedLoans.slice(0, 6).map((loan) => (
                                    <button
                                        key={loan.id}
                                        type="button"
                                        className="w-full rounded border p-3 text-left transition hover:border-primary/40 hover:bg-muted/50"
                                        onClick={() => navigate("/matching")}
                                    >
                                        <div className="flex items-center justify-between gap-3">
                                            <div>
                                                <div className="font-medium">{loan.borrowerName}</div>
                                                <div className="text-xs text-muted-foreground">
                                                    {t("dashboardPage.loanFundingSummary", { defaultValue: "Loan #{{id}} • Funded {{funded}} / {{principal}}", id: loan.id, funded: formatCurrency(loan.fundedAmount, i18n.language), principal: formatCurrency(loan.principalAmount, i18n.language) })}
                                                </div>
                                            </div>
                                            <div className="text-right">
                                                <div className="font-medium text-destructive">{formatCurrency(loan.gap, i18n.language)}</div>
                                                <div className="text-xs text-muted-foreground">{t("loans.remainingGap", "Gap")}</div>
                                            </div>
                                        </div>
                                    </button>
                                ))
                            )}
                        </div>

                        <div className="space-y-3">
                            <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2 text-sm font-medium">
                                    <ArrowRightLeft className="h-4 w-4" />
                                    {t("dashboardPage.sections.unallocatedDrawdowns", "Unallocated Drawdowns")}
                                </div>
                                <Badge>{summary?.unallocatedDrawdownCount ?? 0}</Badge>
                            </div>

                            {alerts.unallocatedDrawdowns.length === 0 ? (
                                <div className="rounded border border-dashed p-4 text-sm text-muted-foreground">
                                    {t("dashboardPage.empty.noUnallocatedDrawdowns", "No unallocated drawdowns right now.")}
                                </div>
                            ) : (
                                alerts.unallocatedDrawdowns.slice(0, 6).map((drawdown) => (
                                    <button
                                        key={drawdown.id}
                                        type="button"
                                        className="w-full rounded border p-3 text-left transition hover:border-primary/40 hover:bg-muted/50"
                                        onClick={() => navigate("/funds")}
                                    >
                                        <div className="flex items-center justify-between gap-3">
                                            <div>
                                                <div className="font-medium">{t("dashboardPage.drawdownLabel", { defaultValue: "Drawdown #{{id}}", id: drawdown.id })}</div>
                                                <div className="text-xs text-muted-foreground">
                                                    {t("dashboardPage.nextDue", { defaultValue: "Next due {{date}}", date: drawdown.nextDueDate || t("loanWizard.notScheduled", "Not scheduled") })}
                                                </div>
                                            </div>
                                            <div className="text-right">
                                                <div className="font-medium">{formatCurrency(drawdown.availableAmount, i18n.language)}</div>
                                                <div className="text-xs text-muted-foreground">{t("dashboardPage.available", "Available")}</div>
                                            </div>
                                        </div>
                                    </button>
                                ))
                            )}
                        </div>
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader>
                        <CardTitle>{t("dashboardPage.sections.reconciliationStatus", "Reconciliation Status")}</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3 text-sm">
                        <div className="rounded border p-3">
                            <div className="flex items-center justify-between gap-3">
                                <span className="text-muted-foreground">{t("dashboardPage.reconciliation.unmatchedBorrowerPayments", "Borrower payments not matched to schedule")}</span>
                                <span className="font-medium">{reconciliation?.unreconciledBorrowerPayments ?? 0}</span>
                            </div>
                        </div>
                        <div className="rounded border p-3">
                            <div className="flex items-center justify-between gap-3">
                                <span className="text-muted-foreground">{t("dashboardPage.reconciliation.recordedFundRepayments", "Recorded fund repayments")}</span>
                                <span className="font-medium">{reconciliation?.recordedFundRepayments ?? 0}</span>
                            </div>
                        </div>
                        <div className="rounded border p-3">
                            <div className="flex items-center justify-between gap-3">
                                <span className="text-muted-foreground">{t("dashboardPage.reconciliation.missingFundScheduleLink", "Fund repayments missing schedule link")}</span>
                                <span className="font-medium text-destructive">{reconciliation?.fundRepaymentsMissingScheduleLink ?? 0}</span>
                            </div>
                        </div>
                        <div className="rounded border p-3">
                            <div className="flex items-center justify-between gap-3">
                                <span className="text-muted-foreground">{t("dashboardPage.reconciliation.pendingBankImports", "Raw bank statement imports pending review")}</span>
                                <span className="font-medium">{reconciliation?.pendingBankImports ?? 0}</span>
                            </div>
                        </div>
                        <div className="rounded border p-3">
                            <div className="flex items-center justify-between gap-3">
                                <span className="text-muted-foreground">{t("dashboardPage.reconciliation.pendingManualReviews", "Pending LINE/OCR uploads review")}</span>
                                <span className="font-medium">{reconciliation?.pendingManualReviews ?? 0}</span>
                            </div>
                        </div>
                        <div className="rounded border p-3">
                            <div className="flex items-center justify-between gap-3">
                                <span className="text-muted-foreground">{t("dashboardPage.reconciliation.missingBorrowerSlip", "Borrower payments missing slip")}</span>
                                <span className="font-medium text-amber-600">{reconciliation?.borrowerPaymentsMissingSlip ?? 0}</span>
                            </div>
                        </div>
                    </CardContent>
                </Card>
            </div>

            <div className="grid gap-4 xl:grid-cols-2">
                <Card>
                    <CardHeader className="flex flex-row items-center justify-between">
                        <CardTitle>{t("dashboardPage.sections.borrowerDueQueue", "Borrower Due Queue")}</CardTitle>
                        <Button size="sm" variant="outline" onClick={() => navigate("/transactions/new")}>
                            {t("dashboardPage.actions.recordPayment", "Record Payment")}
                        </Button>
                    </CardHeader>
                    <CardContent className="space-y-3">
                        {borrowerDueNow.length === 0 ? (
                            <div className="rounded border border-dashed p-4 text-sm text-muted-foreground">
                                {t("dashboardPage.empty.noBorrowerDue", "No borrower installments are due right now.")}
                            </div>
                        ) : (
                            borrowerDueNow.map((item) => (
                                <div key={item.scheduleId} className="rounded border p-3">
                                    <div className="flex items-center justify-between gap-3">
                                        <div>
                                            <div className="font-medium">{item.borrowerName}</div>
                                            <div className="text-xs text-muted-foreground">
                                                {t("dashboardPage.borrowerQueueItem", { defaultValue: "Loan #{{loanId}} • Installment #{{installmentNo}} • {{repaymentType}}", loanId: item.loanId, installmentNo: item.installmentNo, repaymentType: item.repaymentType })}
                                            </div>
                                            <div className="text-xs text-muted-foreground">{t("dashboardPage.dueLabel", { defaultValue: "Due {{date}}", date: item.dueDate })}</div>
                                        </div>
                                        <div className="text-right">
                                            <div className="font-medium">{formatCurrency(Number(item.totalDueNow ?? item.remainingDue), i18n.language)}</div>
                                            <QueueBadge dueDate={item.dueDate} status={item.status} />
                                        </div>
                                    </div>
                                    <div className="mt-3 flex justify-end">
                                        <Button size="sm" variant="outline" onClick={() => openBorrowerRepayment(navigate, item)}>
                                            {t("dashboardPage.actions.recordThisPayment", "Record This Payment")}
                                        </Button>
                                    </div>
                                </div>
                            ))
                        )}
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader className="flex flex-row items-center justify-between">
                        <CardTitle>{t("dashboardPage.sections.fundDueQueue", "Fund Due Queue")}</CardTitle>
                        <Button size="sm" variant="outline" onClick={() => navigate("/funds")}>
                            {t("dashboardPage.actions.openFunds", "Open Funds")}
                        </Button>
                    </CardHeader>
                    <CardContent className="space-y-3">
                        {fundDueNow.length === 0 ? (
                            <div className="rounded border border-dashed p-4 text-sm text-muted-foreground">
                                {t("dashboardPage.empty.noFundDue", "No fund repayments are due right now.")}
                            </div>
                        ) : (
                            fundDueNow.map((item) => (
                                <div key={item.scheduleId} className="rounded border p-3">
                                    <div className="flex items-center justify-between gap-3">
                                        <div>
                                            <div className="font-medium">{t("dashboardPage.drawdownLabel", { defaultValue: "Drawdown #{{id}}", id: item.bankLoanId })}</div>
                                            <div className="text-xs text-muted-foreground">
                                                {t("dashboardPage.fundQueueItem", { defaultValue: "Installment #{{installmentNo}} • Fund #{{fundId}}", installmentNo: item.installmentNo, fundId: item.bankProfileId ?? "-" })}
                                            </div>
                                            <div className="text-xs text-muted-foreground">
                                                {t("dashboardPage.dueLabel", { defaultValue: "Due {{date}}", date: item.dueDate })}{item.note ? ` • ${item.note}` : ""}
                                            </div>
                                        </div>
                                        <div className="text-right">
                                            <div className="font-medium">{formatCurrency(Number(item.totalDueNow ?? item.remainingDue), i18n.language)}</div>
                                            <QueueBadge dueDate={item.dueDate} status={item.status} />
                                        </div>
                                    </div>
                                    <div className="mt-3 flex justify-end">
                                        <Button size="sm" variant="outline" onClick={() => openFundRepayment(navigate, item)}>
                                            {t("dashboardPage.actions.recordFundRepayment", "Record Fund Repayment")}
                                        </Button>
                                    </div>
                                </div>
                            ))
                        )}
                    </CardContent>
                </Card>
            </div>
        </div>
    );
}
