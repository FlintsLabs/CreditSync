import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AlertTriangle, ArrowRightLeft, CalendarClock, CreditCard, DollarSign, Users } from "lucide-react";
import { api } from "../../lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { Badge } from "../../components/ui/badge";

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
    dueDate: string;
    remainingDue: string;
    penaltyDue?: string;
    totalDueNow?: string;
    overdueDays?: number;
    status: string;
    installmentNo: number;
    loanId: number;
    borrowerName: string;
    repaymentType: string;
}

interface FundDueItem {
    scheduleId: number;
    dueDate: string;
    remainingDue: string;
    penaltyDue?: string;
    totalDueNow?: string;
    overdueDays?: number;
    status: string;
    installmentNo: number;
    bankLoanId: number;
    bankProfileId: number | null;
    note: string | null;
}

interface FundingAlerts {
    underfundedLoans: Array<{
        id: number;
        borrowerName: string;
        principalAmount: number;
        fundedAmount: number;
        gap: number;
    }>;
    unallocatedDrawdowns: Array<{
        id: number;
        bankProfileId: number | null;
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

function formatCurrency(value: number) {
    return `฿${value.toLocaleString(undefined, {
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
    navigate(`/dashboard/transactions/new?loanId=${item.loanId}&scheduleId=${item.scheduleId}`);
}

function openFundRepayment(navigate: ReturnType<typeof useNavigate>, item: FundDueItem) {
    if (!item.bankProfileId) {
        navigate("/dashboard/funds");
        return;
    }

    navigate(`/dashboard/funds/${item.bankProfileId}?bankLoanId=${item.bankLoanId}&scheduleId=${item.scheduleId}`);
}

export default function Dashboard() {
    const navigate = useNavigate();
    const [loading, setLoading] = useState(true);
    const [errorMessage, setErrorMessage] = useState("");
    const [summary, setSummary] = useState<DashboardSummary | null>(null);
    const [borrowerQueue, setBorrowerQueue] = useState<BorrowerDueItem[]>([]);
    const [fundQueue, setFundQueue] = useState<FundDueItem[]>([]);
    const [alerts, setAlerts] = useState<FundingAlerts>({ underfundedLoans: [], unallocatedDrawdowns: [] });
    const [reconciliation, setReconciliation] = useState<ReconciliationStatus | null>(null);
    const [profitability, setProfitability] = useState<ProfitabilitySummary | null>(null);

    useEffect(() => {
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
                setErrorMessage("Unable to load the live dashboard right now.");
            } finally {
                setLoading(false);
            }
        };

        loadDashboard();
    }, []);

    const borrowerDueNow = useMemo(() => borrowerQueue.slice(0, 8), [borrowerQueue]);
    const fundDueNow = useMemo(() => fundQueue.slice(0, 8), [fundQueue]);
    const overdueTotal = (summary?.overdueBorrowerCount ?? 0) + (summary?.overdueFundCount ?? 0);

    return (
        <div className="flex-1 space-y-8 p-4 pt-6">
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <div>
                    <h2 className="text-3xl font-bold tracking-tight">Operations Dashboard</h2>
                    <p className="text-sm text-muted-foreground">
                        เงินที่จะเข้า, เงินที่ต้องจ่ายคืน, และช่องว่างการ match funds ในมุมมองเดียว
                    </p>
                </div>
                <div className="flex flex-wrap gap-2">
                    <Button variant="outline" onClick={() => navigate("/dashboard/transactions/new")}>
                        Record Borrower Payment
                    </Button>
                    <Button variant="outline" onClick={() => navigate("/dashboard/funds")}>
                        Open Funds
                    </Button>
                    <Button onClick={() => navigate("/dashboard/matching")}>
                        Open Matching
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
                        <CardTitle className="text-sm font-medium">Due from Borrowers</CardTitle>
                        <DollarSign className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold">{loading ? "..." : formatCurrency(summary?.dueFromBorrowersToday ?? 0)}</div>
                        <p className="text-xs text-muted-foreground">ยอดที่ควรรับเข้าตาม borrower schedules</p>
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium">Due to Funds</CardTitle>
                        <CreditCard className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold">{loading ? "..." : formatCurrency(summary?.dueToFundsToday ?? 0)}</div>
                        <p className="text-xs text-muted-foreground">ยอดที่ควรจ่ายคืน upstream funds หรือ bank</p>
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium">Net Position Today</CardTitle>
                        <CalendarClock className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                        <div className={`text-2xl font-bold ${(summary?.netPositionToday ?? 0) >= 0 ? "text-emerald-600" : "text-destructive"}`}>
                            {loading ? "..." : formatCurrency(summary?.netPositionToday ?? 0)}
                        </div>
                        <p className="text-xs text-muted-foreground">ยอดรับเข้า ลบด้วยยอดจ่ายคืนที่ถึงกำหนด</p>
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium">Overdue Items</CardTitle>
                        <AlertTriangle className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold">{loading ? "..." : overdueTotal}</div>
                        <p className="text-xs text-muted-foreground">
                            Borrowers {summary?.overdueBorrowerCount ?? 0} • Funds {summary?.overdueFundCount ?? 0}
                        </p>
                    </CardContent>
                </Card>
            </div>

            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                <Card>
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium">Borrower Revenue Collected</CardTitle>
                        <DollarSign className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold">{loading ? "..." : formatCurrency(profitability?.borrowerRevenueCollected ?? 0)}</div>
                        <p className="text-xs text-muted-foreground">Interest, fee, และ penalty ที่เก็บได้แล้ว</p>
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium">Fund Cost Paid</CardTitle>
                        <CreditCard className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold">{loading ? "..." : formatCurrency(profitability?.fundCostPaid ?? 0)}</div>
                        <p className="text-xs text-muted-foreground">ดอกเบี้ย, fee, VAT, penalty ที่จ่าย upstream แล้ว</p>
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium">Realized Spread</CardTitle>
                        <CalendarClock className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                        <div className={`text-2xl font-bold ${(profitability?.realizedSpread ?? 0) >= 0 ? "text-emerald-600" : "text-destructive"}`}>
                            {loading ? "..." : formatCurrency(profitability?.realizedSpread ?? 0)}
                        </div>
                        <p className="text-xs text-muted-foreground">
                            ROI {profitability?.realizedRoiPercent?.toFixed(2) ?? "0.00"}% on deployed principal
                        </p>
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium">Unrealized Spread</CardTitle>
                        <AlertTriangle className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                        <div className={`text-2xl font-bold ${(profitability?.unrealizedSpread ?? 0) >= 0 ? "text-emerald-600" : "text-destructive"}`}>
                            {loading ? "..." : formatCurrency(profitability?.unrealizedSpread ?? 0)}
                        </div>
                        <p className="text-xs text-muted-foreground">ส่วนต่างที่ยังค้างอยู่ในสัญญา/งวดที่ยังไม่ปิด</p>
                    </CardContent>
                </Card>
            </div>

            <div className="grid gap-4 xl:grid-cols-[1.3fr_0.9fr]">
                <Card>
                    <CardHeader className="flex flex-row items-center justify-between">
                        <CardTitle>Funding Alerts</CardTitle>
                        <Button size="sm" variant="outline" onClick={() => navigate("/dashboard/matching")}>
                            Open Matching Workspace
                        </Button>
                    </CardHeader>
                    <CardContent className="grid gap-4 lg:grid-cols-2">
                        <div className="space-y-3">
                            <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2 text-sm font-medium">
                                    <Users className="h-4 w-4" />
                                    Underfunded Loans
                                </div>
                                <Badge>{summary?.underfundedLoanCount ?? 0}</Badge>
                            </div>

                            {alerts.underfundedLoans.length === 0 ? (
                                <div className="rounded border border-dashed p-4 text-sm text-muted-foreground">
                                    No underfunded loans right now.
                                </div>
                            ) : (
                                alerts.underfundedLoans.slice(0, 6).map((loan) => (
                                    <button
                                        key={loan.id}
                                        type="button"
                                        className="w-full rounded border p-3 text-left transition hover:border-primary/40 hover:bg-muted/50"
                                        onClick={() => navigate("/dashboard/matching")}
                                    >
                                        <div className="flex items-center justify-between gap-3">
                                            <div>
                                                <div className="font-medium">{loan.borrowerName}</div>
                                                <div className="text-xs text-muted-foreground">
                                                    Loan #{loan.id} • Funded {formatCurrency(loan.fundedAmount)} / {formatCurrency(loan.principalAmount)}
                                                </div>
                                            </div>
                                            <div className="text-right">
                                                <div className="font-medium text-destructive">{formatCurrency(loan.gap)}</div>
                                                <div className="text-xs text-muted-foreground">Gap</div>
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
                                    Unallocated Drawdowns
                                </div>
                                <Badge>{summary?.unallocatedDrawdownCount ?? 0}</Badge>
                            </div>

                            {alerts.unallocatedDrawdowns.length === 0 ? (
                                <div className="rounded border border-dashed p-4 text-sm text-muted-foreground">
                                    No unallocated drawdowns right now.
                                </div>
                            ) : (
                                alerts.unallocatedDrawdowns.slice(0, 6).map((drawdown) => (
                                    <button
                                        key={drawdown.id}
                                        type="button"
                                        className="w-full rounded border p-3 text-left transition hover:border-primary/40 hover:bg-muted/50"
                                        onClick={() => navigate("/dashboard/funds")}
                                    >
                                        <div className="flex items-center justify-between gap-3">
                                            <div>
                                                <div className="font-medium">Drawdown #{drawdown.id}</div>
                                                <div className="text-xs text-muted-foreground">
                                                    Next due {drawdown.nextDueDate || "Not scheduled"}
                                                </div>
                                            </div>
                                            <div className="text-right">
                                                <div className="font-medium">{formatCurrency(drawdown.availableAmount)}</div>
                                                <div className="text-xs text-muted-foreground">Available</div>
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
                        <CardTitle>Reconciliation Status</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3 text-sm">
                        <div className="rounded border p-3">
                            <div className="flex items-center justify-between gap-3">
                                <span className="text-muted-foreground">Borrower payments not matched to schedule</span>
                                <span className="font-medium">{reconciliation?.unreconciledBorrowerPayments ?? 0}</span>
                            </div>
                        </div>
                        <div className="rounded border p-3">
                            <div className="flex items-center justify-between gap-3">
                                <span className="text-muted-foreground">Recorded fund repayments</span>
                                <span className="font-medium">{reconciliation?.recordedFundRepayments ?? 0}</span>
                            </div>
                        </div>
                        <div className="rounded border p-3">
                            <div className="flex items-center justify-between gap-3">
                                <span className="text-muted-foreground">Fund repayments missing schedule link</span>
                                <span className="font-medium text-destructive">{reconciliation?.fundRepaymentsMissingScheduleLink ?? 0}</span>
                            </div>
                        </div>
                        <div className="rounded border p-3">
                            <div className="flex items-center justify-between gap-3">
                                <span className="text-muted-foreground">Raw bank statement imports pending review</span>
                                <span className="font-medium">{reconciliation?.pendingBankImports ?? 0}</span>
                            </div>
                        </div>
                        <div className="rounded border p-3">
                            <div className="flex items-center justify-between gap-3">
                                <span className="text-muted-foreground">Pending LINE/OCR uploads review</span>
                                <span className="font-medium">{reconciliation?.pendingManualReviews ?? 0}</span>
                            </div>
                        </div>
                        <div className="rounded border p-3">
                            <div className="flex items-center justify-between gap-3">
                                <span className="text-muted-foreground">Borrower payments missing slip</span>
                                <span className="font-medium text-amber-600">{reconciliation?.borrowerPaymentsMissingSlip ?? 0}</span>
                            </div>
                        </div>
                    </CardContent>
                </Card>
            </div>

            <div className="grid gap-4 xl:grid-cols-2">
                <Card>
                    <CardHeader className="flex flex-row items-center justify-between">
                        <CardTitle>Borrower Due Queue</CardTitle>
                        <Button size="sm" variant="outline" onClick={() => navigate("/dashboard/transactions/new")}>
                            Record Payment
                        </Button>
                    </CardHeader>
                    <CardContent className="space-y-3">
                        {borrowerDueNow.length === 0 ? (
                            <div className="rounded border border-dashed p-4 text-sm text-muted-foreground">
                                No borrower installments are due right now.
                            </div>
                        ) : (
                            borrowerDueNow.map((item) => (
                                <div key={item.scheduleId} className="rounded border p-3">
                                    <div className="flex items-center justify-between gap-3">
                                        <div>
                                            <div className="font-medium">{item.borrowerName}</div>
                                            <div className="text-xs text-muted-foreground">
                                                Loan #{item.loanId} • Installment #{item.installmentNo} • {item.repaymentType}
                                            </div>
                                            <div className="text-xs text-muted-foreground">Due {item.dueDate}</div>
                                        </div>
                                        <div className="text-right">
                                            <div className="font-medium">{formatCurrency(Number(item.totalDueNow ?? item.remainingDue))}</div>
                                            <QueueBadge dueDate={item.dueDate} status={item.status} />
                                        </div>
                                    </div>
                                    <div className="mt-3 flex justify-end">
                                        <Button size="sm" variant="outline" onClick={() => openBorrowerRepayment(navigate, item)}>
                                            Record This Payment
                                        </Button>
                                    </div>
                                </div>
                            ))
                        )}
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader className="flex flex-row items-center justify-between">
                        <CardTitle>Fund Due Queue</CardTitle>
                        <Button size="sm" variant="outline" onClick={() => navigate("/dashboard/funds")}>
                            Open Funds
                        </Button>
                    </CardHeader>
                    <CardContent className="space-y-3">
                        {fundDueNow.length === 0 ? (
                            <div className="rounded border border-dashed p-4 text-sm text-muted-foreground">
                                No fund repayments are due right now.
                            </div>
                        ) : (
                            fundDueNow.map((item) => (
                                <div key={item.scheduleId} className="rounded border p-3">
                                    <div className="flex items-center justify-between gap-3">
                                        <div>
                                            <div className="font-medium">Drawdown #{item.bankLoanId}</div>
                                            <div className="text-xs text-muted-foreground">
                                                Installment #{item.installmentNo} • Fund #{item.bankProfileId ?? "-"}
                                            </div>
                                            <div className="text-xs text-muted-foreground">
                                                Due {item.dueDate}{item.note ? ` • ${item.note}` : ""}
                                            </div>
                                        </div>
                                        <div className="text-right">
                                            <div className="font-medium">{formatCurrency(Number(item.totalDueNow ?? item.remainingDue))}</div>
                                            <QueueBadge dueDate={item.dueDate} status={item.status} />
                                        </div>
                                    </div>
                                    <div className="mt-3 flex justify-end">
                                        <Button size="sm" variant="outline" onClick={() => openFundRepayment(navigate, item)}>
                                            Record Fund Repayment
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
