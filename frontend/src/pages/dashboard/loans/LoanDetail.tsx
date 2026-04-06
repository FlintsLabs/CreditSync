import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, CalendarDays, User2 } from "lucide-react";
import { api } from "../../../lib/api";
import { Button } from "../../../components/ui/Button";
import { Card, CardContent, CardHeader, CardTitle } from "../../../components/ui/Card";

interface LoanDetailData {
    id: number;
    borrowerId: number;
    principalAmount: string;
    interestRate: string;
    repaymentType: string;
    installmentAmount: string | null;
    totalInstallments: number | null;
    startDate: string | null;
    nextDueDate: string | null;
    outstandingPrincipal: string | null;
    outstandingInterest: string | null;
    outstandingFees: string | null;
    status: string;
}

interface BorrowerData {
    id: number;
    name: string;
    phone?: string | null;
}

interface LoanScheduleRow {
    id: number;
    installmentNo: number;
    dueDate: string;
    scheduledTotal: string;
    remainingDue: string;
    status: string;
}

interface AllocationRow {
    id: number;
    bankLoanId?: number | null;
    bankProfileId?: number | null;
    bankProfileName?: string | null;
    allocatedAmount: string;
    allocationDate?: string;
    allocationType?: string;
    note?: string | null;
}

interface LoanProfitability {
    borrowerRevenueCollected: number;
    fundCostPaid: number;
    realizedSpread: number;
    unrealizedSpread: number;
    fundedPrincipal: number;
    unallocatedPrincipalGap: number;
    estimatedOutstandingFundingCost: number;
    fundingShare: number;
    fundingComposition: Array<{
        bankLoanId: number;
        bankProfileId: number | null;
        netAllocatedPrincipal: number;
        shareOfLoanPrincipal: number;
        shareOfDrawdown: number;
        estimatedBankInterestPaid: number;
        estimatedBankFeesPaid: number;
        estimatedBankVatPaid: number;
        estimatedBankPenaltiesPaid: number;
        outstandingCostAllocated: number;
    }>;
}

interface LoanAllocationState {
    principalAmount: number;
    netAllocatedPrincipal: number;
    remainingGap: number;
    overfundedAmount: number;
    state: string;
}

function formatCurrency(value: number) {
    return `฿${value.toLocaleString(undefined, {
        minimumFractionDigits: 0,
        maximumFractionDigits: 2,
    })}`;
}

export default function LoanDetail() {
    const navigate = useNavigate();
    const { id } = useParams();
    const [loading, setLoading] = useState(true);
    const [errorMessage, setErrorMessage] = useState("");
    const [loan, setLoan] = useState<LoanDetailData | null>(null);
    const [borrower, setBorrower] = useState<BorrowerData | null>(null);
    const [schedule, setSchedule] = useState<LoanScheduleRow[]>([]);
    const [allocations, setAllocations] = useState<AllocationRow[]>([]);
    const [profitability, setProfitability] = useState<LoanProfitability | null>(null);
    const [allocationState, setAllocationState] = useState<LoanAllocationState | null>(null);

    useEffect(() => {
        const run = async () => {
            if (!id) {
                setErrorMessage("Loan not found.");
                setLoading(false);
                return;
            }

            try {
                setLoading(true);
                const [loanRes, scheduleRes, allocationsRes, profitabilityRes, allocationStateRes] = await Promise.all([
                    api.get(`/loans/${id}`),
                    api.get(`/loans/${id}/schedule`),
                    api.get(`/loans/${id}/funding-allocations`),
                    api.get(`/loans/${id}/profitability`),
                    api.get(`/loans/${id}/allocation-state`),
                ]);

                const loanData = loanRes.data ?? null;
                setLoan(loanData);
                setSchedule(scheduleRes.data ?? []);
                setAllocations(allocationsRes.data ?? []);
                setProfitability(profitabilityRes.data ?? null);
                setAllocationState(allocationStateRes.data ?? null);

                if (loanData?.borrowerId) {
                    const borrowerRes = await api.get(`/borrowers/${loanData.borrowerId}`);
                    setBorrower(borrowerRes.data ?? null);
                } else {
                    setBorrower(null);
                }

                setErrorMessage("");
            } catch (error) {
                console.error("Failed to load loan detail", error);
                setErrorMessage("Unable to load loan detail right now.");
            } finally {
                setLoading(false);
            }
        };

        run();
    }, [id]);

    const nextDueRow = schedule.find((row) => Number(row.remainingDue) > 0) ?? null;

    return (
        <div className="space-y-6">
            <div className="flex items-center gap-4">
                <Button variant="ghost" size="icon" onClick={() => navigate("/dashboard/loans")}>
                    <ArrowLeft className="h-4 w-4" />
                </Button>
                <div>
                    <h2 className="text-2xl font-bold tracking-tight">
                        {loading ? "Loading..." : `Loan #${loan?.id ?? ""}`}
                    </h2>
                    <p className="text-muted-foreground">Profitability, funding composition, and installment status in one view.</p>
                </div>
            </div>

            {errorMessage && (
                <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                    {errorMessage}
                </div>
            )}

            {loading ? (
                <div>Loading...</div>
            ) : !loan ? (
                <Card>
                    <CardContent className="py-10 text-center text-muted-foreground">
                        This loan does not exist anymore.
                    </CardContent>
                </Card>
            ) : (
                <>
                    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                        <Card>
                            <CardHeader className="pb-2">
                                <CardTitle className="text-sm font-medium text-muted-foreground">Borrower</CardTitle>
                            </CardHeader>
                            <CardContent className="space-y-2 text-sm">
                                <div className="flex items-center gap-2 font-medium">
                                    <User2 className="h-4 w-4 text-muted-foreground" />
                                    {borrower?.name ?? "Unknown borrower"}
                                </div>
                                {borrower?.phone && <div className="text-muted-foreground">{borrower.phone}</div>}
                                {borrower && (
                                    <Link to={`/dashboard/borrowers/${borrower.id}`} className="text-primary text-xs hover:underline">
                                        Open borrower profile
                                    </Link>
                                )}
                            </CardContent>
                        </Card>

                        <Card>
                            <CardHeader className="pb-2">
                                <CardTitle className="text-sm font-medium text-muted-foreground">Loan Position</CardTitle>
                            </CardHeader>
                            <CardContent className="space-y-2 text-sm">
                                <div className="flex justify-between">
                                    <span>Principal</span>
                                    <span className="font-medium">{formatCurrency(Number(loan.principalAmount ?? 0))}</span>
                                </div>
                                <div className="flex justify-between">
                                    <span>Outstanding principal</span>
                                    <span className="font-medium">{formatCurrency(Number(loan.outstandingPrincipal ?? 0))}</span>
                                </div>
                                <div className="flex justify-between">
                                    <span>Outstanding interest</span>
                                    <span className="font-medium">{formatCurrency(Number(loan.outstandingInterest ?? 0))}</span>
                                </div>
                                <div className="flex justify-between">
                                    <span>Status</span>
                                    <span className="font-medium uppercase">{loan.status}</span>
                                </div>
                            </CardContent>
                        </Card>

                        <Card>
                            <CardHeader className="pb-2">
                                <CardTitle className="text-sm font-medium text-muted-foreground">Funding State</CardTitle>
                            </CardHeader>
                            <CardContent className="space-y-2 text-sm">
                                <div className="flex justify-between">
                                    <span>State</span>
                                    <span className="font-medium capitalize">{allocationState?.state?.replaceAll("_", " ") ?? "-"}</span>
                                </div>
                                <div className="flex justify-between">
                                    <span>Funded principal</span>
                                    <span className="font-medium">{formatCurrency(Number(allocationState?.netAllocatedPrincipal ?? 0))}</span>
                                </div>
                                <div className="flex justify-between">
                                    <span>Remaining gap</span>
                                    <span className={`font-medium ${Number(allocationState?.remainingGap ?? 0) > 0 ? "text-destructive" : "text-emerald-600"}`}>
                                        {formatCurrency(Number(allocationState?.remainingGap ?? 0))}
                                    </span>
                                </div>
                                <div className="flex justify-between">
                                    <span>Overfunded</span>
                                    <span className="font-medium">{formatCurrency(Number(allocationState?.overfundedAmount ?? 0))}</span>
                                </div>
                            </CardContent>
                        </Card>

                        <Card>
                            <CardHeader className="pb-2">
                                <CardTitle className="text-sm font-medium text-muted-foreground">Next Due</CardTitle>
                            </CardHeader>
                            <CardContent className="space-y-2 text-sm">
                                {nextDueRow ? (
                                    <>
                                        <div className="flex items-center gap-2">
                                            <CalendarDays className="h-4 w-4 text-muted-foreground" />
                                            <span className="font-medium">{nextDueRow.dueDate}</span>
                                        </div>
                                        <div className="flex justify-between">
                                            <span>Remaining due</span>
                                            <span className="font-medium">{formatCurrency(Number(nextDueRow.remainingDue ?? 0))}</span>
                                        </div>
                                        <Link to={`/dashboard/transactions/new?loanId=${loan.id}&scheduleId=${nextDueRow.id}`} className="text-primary text-xs hover:underline">
                                            Record this payment
                                        </Link>
                                    </>
                                ) : (
                                    <div className="text-muted-foreground">No pending installment right now.</div>
                                )}
                            </CardContent>
                        </Card>
                    </div>

                    <Card>
                        <CardHeader>
                            <CardTitle>Profitability Snapshot</CardTitle>
                        </CardHeader>
                        <CardContent className="grid gap-4 md:grid-cols-2 xl:grid-cols-6">
                            <div>
                                <div className="text-xs text-muted-foreground">Revenue collected</div>
                                <div className="font-medium">{formatCurrency(Number(profitability?.borrowerRevenueCollected ?? 0))}</div>
                            </div>
                            <div>
                                <div className="text-xs text-muted-foreground">Fund cost paid</div>
                                <div className="font-medium">{formatCurrency(Number(profitability?.fundCostPaid ?? 0))}</div>
                            </div>
                            <div>
                                <div className="text-xs text-muted-foreground">Realized spread</div>
                                <div className={`font-medium ${Number(profitability?.realizedSpread ?? 0) >= 0 ? "text-emerald-600" : "text-destructive"}`}>
                                    {formatCurrency(Number(profitability?.realizedSpread ?? 0))}
                                </div>
                            </div>
                            <div>
                                <div className="text-xs text-muted-foreground">Unrealized spread</div>
                                <div className={`font-medium ${Number(profitability?.unrealizedSpread ?? 0) >= 0 ? "text-emerald-600" : "text-destructive"}`}>
                                    {formatCurrency(Number(profitability?.unrealizedSpread ?? 0))}
                                </div>
                            </div>
                            <div>
                                <div className="text-xs text-muted-foreground">Funding share</div>
                                <div className="font-medium">{((Number(profitability?.fundingShare ?? 0)) * 100).toFixed(1)}%</div>
                            </div>
                            <div>
                                <div className="text-xs text-muted-foreground">Outstanding funding cost</div>
                                <div className="font-medium">{formatCurrency(Number(profitability?.estimatedOutstandingFundingCost ?? 0))}</div>
                            </div>
                        </CardContent>
                    </Card>

                    <div className="grid gap-4 xl:grid-cols-[1.15fr_0.85fr]">
                        <Card>
                            <CardHeader>
                                <CardTitle>Funding Composition</CardTitle>
                            </CardHeader>
                            <CardContent>
                                {profitability?.fundingComposition?.length ? (
                                    <div className="space-y-3">
                                        {profitability.fundingComposition.map((item) => (
                                            <div key={item.bankLoanId} className="rounded border p-3 text-sm">
                                                <div className="flex items-center justify-between gap-3">
                                                    <div>
                                                        <div className="font-medium">Drawdown #{item.bankLoanId}</div>
                                                        <div className="text-xs text-muted-foreground">
                                                            Share of loan: {(item.shareOfLoanPrincipal * 100).toFixed(1)}% • Share of drawdown cost: {(item.shareOfDrawdown * 100).toFixed(1)}%
                                                        </div>
                                                    </div>
                                                    <Link to={`/dashboard/funds/${item.bankProfileId}?bankLoanId=${item.bankLoanId}`} className="text-primary text-xs hover:underline">
                                                        Open drawdown
                                                    </Link>
                                                </div>
                                                <div className="mt-3 grid gap-3 md:grid-cols-3">
                                                    <div>
                                                        <div className="text-xs text-muted-foreground">Allocated principal</div>
                                                        <div className="font-medium">{formatCurrency(item.netAllocatedPrincipal)}</div>
                                                    </div>
                                                    <div>
                                                        <div className="text-xs text-muted-foreground">Estimated cost paid</div>
                                                        <div className="font-medium">
                                                            {formatCurrency(
                                                                item.estimatedBankInterestPaid +
                                                                item.estimatedBankFeesPaid +
                                                                item.estimatedBankVatPaid +
                                                                item.estimatedBankPenaltiesPaid
                                                            )}
                                                        </div>
                                                    </div>
                                                    <div>
                                                        <div className="text-xs text-muted-foreground">Outstanding cost allocated</div>
                                                        <div className="font-medium">{formatCurrency(item.outstandingCostAllocated)}</div>
                                                    </div>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                ) : (
                                    <div className="rounded border border-dashed p-4 text-sm text-muted-foreground">
                                        This loan has not been matched to any funding drawdown yet.
                                    </div>
                                )}
                            </CardContent>
                        </Card>

                        <Card>
                            <CardHeader>
                                <CardTitle>Repayment Schedule</CardTitle>
                            </CardHeader>
                            <CardContent>
                                {schedule.length === 0 ? (
                                    <div className="rounded border border-dashed p-4 text-sm text-muted-foreground">
                                        No repayment schedule available for this loan.
                                    </div>
                                ) : (
                                    <div className="space-y-2">
                                        {schedule.slice(0, 8).map((row) => (
                                            <div key={row.id} className="rounded border p-3 text-sm">
                                                <div className="flex items-center justify-between gap-3">
                                                    <div>
                                                        <div className="font-medium">Installment #{row.installmentNo}</div>
                                                        <div className="text-xs text-muted-foreground">{row.dueDate}</div>
                                                    </div>
                                                    <div className="text-right">
                                                        <div className="font-medium">{formatCurrency(Number(row.remainingDue ?? 0))}</div>
                                                        <div className="text-xs text-muted-foreground capitalize">{row.status}</div>
                                                    </div>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </CardContent>
                        </Card>
                    </div>

                    <Card>
                        <CardHeader>
                            <CardTitle>Allocation History</CardTitle>
                        </CardHeader>
                        <CardContent>
                            {allocations.length === 0 ? (
                                <div className="rounded border border-dashed p-4 text-sm text-muted-foreground">
                                    No funding allocations have been recorded for this loan yet.
                                </div>
                            ) : (
                                <div className="space-y-2">
                                    {allocations.map((row) => (
                                        <div key={row.id} className="rounded border p-3 text-sm">
                                            <div className="flex items-center justify-between gap-3">
                                                <div>
                                                    <div className="font-medium">
                                                        {row.allocationType} {row.bankLoanId ? `• Drawdown #${row.bankLoanId}` : ""}
                                                    </div>
                                                    <div className="text-xs text-muted-foreground">
                                                        {row.bankProfileName ?? "Unknown source"} • {row.allocationDate ?? "-"}
                                                    </div>
                                                </div>
                                                <div className={`font-medium ${Number(row.allocatedAmount) < 0 ? "text-destructive" : "text-emerald-600"}`}>
                                                    {Number(row.allocatedAmount) < 0 ? "-" : "+"}{formatCurrency(Math.abs(Number(row.allocatedAmount)))}
                                                </div>
                                            </div>
                                            {row.note && <div className="mt-1 text-xs text-muted-foreground">{row.note}</div>}
                                        </div>
                                    ))}
                                </div>
                            )}
                        </CardContent>
                    </Card>
                </>
            )}
        </div>
    );
}
