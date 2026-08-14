import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, CalendarDays, CheckCircle, Copy, User2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "../../../lib/api";
import { getStoredUser, isTenantAdminUser } from "../../../lib/session";
import { Button } from "../../../components/ui/Button";
import { Card, CardContent, CardHeader, CardTitle } from "../../../components/ui/Card";
import { Badge } from "../../../components/ui/badge";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "../../../components/ui/dialog";
import appI18n from "../../../lib/i18n";
import { formatMoneyExact } from "../../../lib/workflow-model";
import { LoanRenewalPanel } from "./LoanRenewalPanel";
import { LoanDisbursements } from "./LoanDisbursements";
import { LoanRepaymentHistory } from "./LoanRepaymentHistory";
import { FloatingInterestRateCard } from "./FloatingInterestRateCard";
import { LoanRestructurePanel } from "./LoanRestructurePanel";
import { LoanOpeningBalances, type OpeningBalanceComponent, type RestructureLineage, type RestructureWaiver } from "./LoanOpeningBalances";

interface LoanDetailData {
    id: string;
    publicId: string;
    borrowerPublicId: string | null;
    principalAmount: string;
    interestRate: string;
    repaymentType: string;
    termMonths: number | null;
    installmentAmount: string | null;
    totalInstallments: number | null;
    startDate: string | null;
    nextDueDate: string | null;
    outstandingPrincipal: string | null;
    outstandingInterest: string | null;
    outstandingFees: string | null;
    status: string;
    bankProfilePublicId?: string | null;
    bankLoanPublicId?: string | null;
    dailyLoanCalculation?: {
        durationUnit: "days" | "weeks" | "months";
        durationValue: number;
        totalInstallments: number;
        installmentAmount: string;
        totalInterest: string;
        dailyInterest: string;
        flatDailyRatePercent: string;
    } | null;
    restructureLineage?: RestructureLineage | null;
    openingBalanceComponents?: OpeningBalanceComponent[];
    restructureWaivers?: RestructureWaiver[];
}

interface BorrowerData {
    id: string;
    publicId?: string;
    name: string;
    phone?: string | null;
}

interface LoanScheduleRow {
    id: string;
    publicId: string;
    installmentNo: number;
    dueDate: string;
    scheduledTotal: string;
    remainingDue: string;
    status: string;
}

interface AllocationRow {
    id: string;
    bankLoanPublicId?: string | null;
    bankProfilePublicId?: string | null;
    bankProfileName?: string | null;
    allocatedAmount: string;
    allocationDate?: string;
    allocationType?: string;
    note?: string | null;
}

interface LoanProfitability {
    borrowerRevenueCollected: string;
    fundCostPaid: string;
    realizedSpread: string;
    unrealizedSpread: string;
    fundedPrincipal: string;
    unallocatedPrincipalGap: string;
    estimatedOutstandingFundingCost: string;
    fundingShare: number;
    fundingComposition: Array<{
        bankLoanPublicId: string | null;
        bankProfilePublicId: string | null;
        netAllocatedPrincipal: string;
        shareOfLoanPrincipal: number;
        shareOfDrawdown: number;
        estimatedBankInterestPaid: string;
        estimatedBankFeesPaid: string;
        estimatedBankVatPaid: string;
        estimatedBankPenaltiesPaid: string;
        outstandingCostAllocated: string;
    }>;
}

interface LoanAllocationState {
    principalAmount: string;
    netAllocatedPrincipal: string;
    remainingGap: string;
    overfundedAmount: string;
    state: string;
}

function formatCurrency(value: number) {
    return new Intl.NumberFormat(appI18n.language, {
        style: "currency", currency: "THB", minimumFractionDigits: 2,
    }).format(value);
}

export default function LoanDetail() {
    const { t, i18n } = useTranslation();
    const navigate = useNavigate();
    const { id } = useParams();
    const currentUser = getStoredUser();
    const isTenantAdmin = isTenantAdminUser(currentUser);
    const [loading, setLoading] = useState(true);
    const [errorMessage, setErrorMessage] = useState("");
    const [copiedLoanId, setCopiedLoanId] = useState(false);
    const [loan, setLoan] = useState<LoanDetailData | null>(null);
    const [borrower, setBorrower] = useState<BorrowerData | null>(null);
    const [schedule, setSchedule] = useState<LoanScheduleRow[]>([]);
    const [allocations, setAllocations] = useState<AllocationRow[]>([]);
    const [profitability, setProfitability] = useState<LoanProfitability | null>(null);
    const [allocationState, setAllocationState] = useState<LoanAllocationState | null>(null);
    const [activationOpen, setActivationOpen] = useState(false);
    const [activating, setActivating] = useState(false);

    useEffect(() => {
        const run = async () => {
            if (!id) {
                setErrorMessage(t("loanDetail.errors.notFound", "Loan not found."));
                setLoading(false);
                return;
            }

            try {
                setLoading(true);
                const [loanRes, scheduleRes, allocationsRes, allocationStateRes] = await Promise.all([
                    api.get(`/loans/${id}`),
                    api.get(`/loans/${id}/schedule`),
                    api.get(`/loans/${id}/funding-allocations`),
                    api.get(`/loans/${id}/allocation-state`),
                ]);
                const profitabilityRes = isTenantAdmin
                    ? await api.get(`/loans/${id}/profitability`)
                    : { data: null };

                const loanData = loanRes.data ?? null;
                setLoan(loanData);
                setSchedule(scheduleRes.data ?? []);
                setAllocations(allocationsRes.data ?? []);
                setProfitability(profitabilityRes.data ?? null);
                setAllocationState(allocationStateRes.data ?? null);

                if (loanData?.borrowerPublicId) {
                    const borrowerRes = await api.get(`/borrowers/${loanData.borrowerPublicId}`);
                    setBorrower(borrowerRes.data ?? null);
                } else {
                    setBorrower(null);
                }

                setErrorMessage("");
            } catch (error) {
                console.error("Failed to load loan detail", error);
                setErrorMessage(t("loanDetail.errors.load", "Unable to load loan detail right now."));
            } finally {
                setLoading(false);
            }
        };

        run();
    }, [id, isTenantAdmin, t]);

    const nextDueRow = schedule.find((row) => Number(row.remainingDue) > 0) ?? null;

    const activateDraft = async () => {
        if (!loan || loan.status !== "draft" || activating) return;
        try {
            setActivating(true);
            const response = await api.post(`/loans/${loan.publicId}/activate`);
            setLoan(response.data);
            setActivationOpen(false);
            setErrorMessage("");
        } catch (error) {
            console.error("Failed to activate loan draft", error);
            setErrorMessage(t("loanDetail.activation.error"));
        } finally {
            setActivating(false);
        }
    };

    return (
        <div className="space-y-6">
            <div className="flex flex-wrap items-center gap-4">
                <Button variant="ghost" size="icon" onClick={() => navigate("/loans")}>
                    <ArrowLeft className="h-4 w-4" />
                </Button>
                <div className="min-w-0 flex-1">
                    <h2 className="text-2xl font-bold tracking-tight">{loading ? t("common.loading", "Loading...") : t("loanDetail.title", "Loan agreement")}</h2>
                    {!loading && loan?.publicId && <div className="mt-1 flex min-w-0 items-center gap-1 text-xs text-muted-foreground"><span className="shrink-0">{t("loanDetail.loanId", "ID")}:</span><code className="truncate font-mono">{loan.publicId}</code><button type="button" className="shrink-0 rounded p-1 hover:bg-muted" aria-label={t("loanDetail.copyLoanId", "Copy loan ID")} title={t("loanDetail.copyLoanId", "Copy loan ID")} onClick={() => { void navigator.clipboard.writeText(loan.publicId); setCopiedLoanId(true); window.setTimeout(() => setCopiedLoanId(false), 2000); }}><Copy className="h-3.5 w-3.5" /></button>{copiedLoanId && <span className="shrink-0 text-emerald-600">{t("loanDetail.copied", "Copied")}</span>}</div>}
                    <p className="text-muted-foreground">{t("loanDetail.description", "Profitability, funding composition, and installment status in one view.")}</p>
                </div>
                {!loading && loan?.status === "draft" && (
                    <Button className="w-full shrink-0 sm:w-auto" onClick={() => setActivationOpen(true)}>
                        <CheckCircle className="mr-2 h-4 w-4" />
                        {t("loanDetail.activation.action")}
                    </Button>
                )}
            </div>

            <Dialog open={activationOpen} onOpenChange={(open) => !activating && setActivationOpen(open)}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>{t("loanDetail.activation.title")}</DialogTitle>
                        <DialogDescription>{t("loanDetail.activation.warning")}</DialogDescription>
                    </DialogHeader>
                    <dl className="grid gap-3 text-sm sm:grid-cols-2">
                        <div><dt className="text-muted-foreground">{t("loanDetail.activation.borrower")}</dt><dd className="font-medium">{borrower?.name ?? t("loanDetail.unknownBorrower")}</dd></div>
                        <div><dt className="text-muted-foreground">{t("loanDetail.activation.principal")}</dt><dd className="font-medium tabular-nums">{formatMoneyExact(loan?.principalAmount ?? "0.00", i18n.language)}</dd></div>
                        <div><dt className="text-muted-foreground">{t("loanDetail.activation.repaymentType")}</dt><dd className="font-medium">{t(`loanWizard.repaymentOptions.${loan?.repaymentType ?? "floating"}`)}</dd></div>
                        <div><dt className="text-muted-foreground">{t("loanDetail.activation.startDate")}</dt><dd className="font-medium">{loan?.startDate ?? "-"}</dd></div>
                    </dl>
                    <DialogFooter>
                        <Button variant="outline" disabled={activating} onClick={() => setActivationOpen(false)}>{t("common.cancel")}</Button>
                        <Button disabled={activating} onClick={() => void activateDraft()}>
                            {activating ? t("loanDetail.activation.activating") : t("loanDetail.activation.confirm")}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {errorMessage && (
                <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                    {errorMessage}
                </div>
            )}

            {loading ? (
                <div>{t("common.loading", "Loading...")}</div>
            ) : !loan ? (
                <Card>
                    <CardContent className="py-10 text-center text-muted-foreground">
                        {t("loanDetail.missing", "This loan does not exist anymore.")}
                    </CardContent>
                </Card>
            ) : (
                <>
                    {loan.repaymentType === "daily" && loan.dailyLoanCalculation && (
                        <Card>
                            <CardHeader><CardTitle>{t("loanDetail.dailyTerms.title", "Daily repayment terms")}</CardTitle></CardHeader>
                            <CardContent className="grid gap-3 text-sm sm:grid-cols-2 xl:grid-cols-6">
                                <div><div className="text-muted-foreground">{t("loanDetail.dailyTerms.duration", "Duration")}</div><div className="font-medium">{loan.dailyLoanCalculation.durationValue} {t(`loanDetail.dailyTerms.units.${loan.dailyLoanCalculation.durationUnit}`, loan.dailyLoanCalculation.durationUnit)}</div></div>
                                <div><div className="text-muted-foreground">{t("loanDetail.dailyTerms.agreedInstallment", "Agreed instalment")}</div><div className="font-medium">{formatCurrency(Number(loan.dailyLoanCalculation.installmentAmount))}</div></div>
                                <div><div className="text-muted-foreground">{t("loanDetail.dailyTerms.installments", "Total instalments")}</div><div className="font-medium">{loan.dailyLoanCalculation.totalInstallments}</div></div>
                                <div><div className="text-muted-foreground">{t("loanDetail.dailyTerms.totalInterest", "Total interest")}</div><div className="font-medium">{formatCurrency(Number(loan.dailyLoanCalculation.totalInterest))}</div></div>
                                <div><div className="text-muted-foreground">{t("loanDetail.dailyTerms.dailyInterest", "Daily interest")}</div><div className="font-medium">{formatCurrency(Number(loan.dailyLoanCalculation.dailyInterest))}</div></div>
                                <div><div className="text-muted-foreground">{t("loanDetail.dailyTerms.flatRate", "Flat daily rate")}</div><div className="font-medium">{Number(loan.dailyLoanCalculation.flatDailyRatePercent).toFixed(4)}%</div></div>
                            </CardContent>
                            <CardContent className="pt-0 text-xs text-muted-foreground">{t("loanDetail.dailyTerms.notice", "The agreed instalment is fixed. A smaller payment leaves the scheduled remainder due; early settlement requires its own preview.")}</CardContent>
                        </Card>
                    )}
                    {loan.repaymentType === "floating" && <FloatingInterestRateCard loanPublicId={loan.publicId ?? loan.id} />}
                    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                        <Card>
                            <CardHeader className="pb-2">
                                <CardTitle className="text-sm font-medium text-muted-foreground">{t("loanWizard.borrower", "Borrower")}</CardTitle>
                            </CardHeader>
                            <CardContent className="space-y-2 text-sm">
                                <div className="flex items-center gap-2 font-medium">
                                    <User2 className="h-4 w-4 text-muted-foreground" />
                                    {borrower?.name ?? t("loanDetail.unknownBorrower", "Unknown borrower")}
                                </div>
                                {borrower?.phone && <div className="text-muted-foreground">{borrower.phone}</div>}
                                {borrower && (
                                    <Link to={`/borrowers/${borrower.publicId ?? borrower.id}`} className="text-primary text-xs hover:underline">
                                        {t("loanDetail.openBorrowerProfile", "Open borrower profile")}
                                    </Link>
                                )}
                            </CardContent>
                        </Card>

                        <Card>
                            <CardHeader className="pb-2">
                                <CardTitle className="text-sm font-medium text-muted-foreground">{t("loanDetail.loanPosition", "Loan Position")}</CardTitle>
                            </CardHeader>
                            <CardContent className="space-y-2 text-sm">
                                {loan.bankProfilePublicId && !loan.bankLoanPublicId && <div className="rounded bg-muted p-2 text-xs"><span className="font-medium">{t("loanDetail.ownCapital.title", "Own capital")}</span><span className="text-muted-foreground"> · {t("loanDetail.ownCapital.description", "Allocated directly from a capital pool; this is not a bank drawdown.")}</span></div>}
                                {loan.bankLoanPublicId && <div className="rounded bg-muted p-2 text-xs"><span className="font-medium">{t("loanDetail.bankDrawdown.title", "Bank drawdown")}</span><span className="text-muted-foreground"> · {t("loanDetail.bankDrawdown.description", "Funding is allocated from a specific drawdown.")}</span></div>}
                                <div className="flex justify-between">
                                    <span>{t("loanWizard.columns.principal", "Principal")}</span>
                                    <span className="font-medium">{formatCurrency(Number(loan.principalAmount ?? 0))}</span>
                                </div>
                                <div className="flex justify-between">
                                    <span>{t("loanWizard.outstandingPrincipal", "Outstanding principal")}</span>
                                    <span className="font-medium">{formatCurrency(Number(loan.outstandingPrincipal ?? 0))}</span>
                                </div>
                                <div className="flex justify-between">
                                    <span>{t("loanDetail.outstandingInterest", "Outstanding interest")}</span>
                                    <span className="font-medium">{formatCurrency(Number(loan.outstandingInterest ?? 0))}</span>
                                </div>
                                <div className="flex justify-between">
                                    <span>{t("common.status", "Status")}</span>
                                    <span className="font-medium uppercase">{loan.status}</span>
                                </div>
                            </CardContent>
                        </Card>

                        <Card>
                            <CardHeader className="pb-2">
                                <CardTitle className="text-sm font-medium text-muted-foreground">{t("loans.fundingState", "Funding State")}</CardTitle>
                            </CardHeader>
                            <CardContent className="space-y-2 text-sm">
                                <div className="flex justify-between">
                                    <span>{t("loanDetail.state", "State")}</span>
                                    <span className="font-medium capitalize">{allocationState?.state?.replaceAll("_", " ") ?? "-"}</span>
                                </div>
                                <div className="flex justify-between">
                                    <span>{t("loanDetail.fundedPrincipal", "Funded principal")}</span>
                                    <span className="font-medium">{formatCurrency(Number(allocationState?.netAllocatedPrincipal ?? 0))}</span>
                                </div>
                                <div className="flex justify-between">
                                    <span>{t("loans.remainingGap", "Remaining gap")}</span>
                                    <span className={`font-medium ${Number(allocationState?.remainingGap ?? 0) > 0 ? "text-destructive" : "text-emerald-600"}`}>
                                        {formatCurrency(Number(allocationState?.remainingGap ?? 0))}
                                    </span>
                                </div>
                                <div className="flex justify-between">
                                    <span>{t("loanDetail.overfunded", "Overfunded")}</span>
                                    <span className="font-medium">{formatCurrency(Number(allocationState?.overfundedAmount ?? 0))}</span>
                                </div>
                            </CardContent>
                        </Card>

                        <Card>
                            <CardHeader className="pb-2">
                                <CardTitle className="text-sm font-medium text-muted-foreground">{t("loanWizard.nextDue", "Next Due")}</CardTitle>
                            </CardHeader>
                            <CardContent className="space-y-2 text-sm">
                                {nextDueRow ? (
                                    <>
                                        <div className="flex items-center gap-2">
                                            <CalendarDays className="h-4 w-4 text-muted-foreground" />
                                            <span className="font-medium">{nextDueRow.dueDate}</span>
                                        </div>
                                        <div className="flex justify-between">
                                            <span>{t("loanDetail.remainingDue", "Remaining due")}</span>
                                            <span className="font-medium">{formatCurrency(Number(nextDueRow.remainingDue ?? 0))}</span>
                                        </div>
                                        <Link to={`/transactions/new?loanId=${loan.publicId ?? loan.id}&scheduleId=${nextDueRow.publicId ?? nextDueRow.id}`} className="text-primary text-xs hover:underline">
                                            {t("dashboardPage.actions.recordThisPayment", "Record this payment")}
                                        </Link>
                                    </>
                                ) : (
                                    <div className="text-muted-foreground">{t("loanDetail.noPendingInstallment", "No pending installment right now.")}</div>
                                )}
                            </CardContent>
                        </Card>
                    </div>

                    <LoanOpeningBalances loanPublicId={loan.publicId} lineage={loan.restructureLineage} components={loan.openingBalanceComponents} waivers={loan.restructureWaivers} />
                    <LoanRestructurePanel loan={loan} onExecuted={() => window.location.reload()} />
                    <LoanDisbursements loanPublicId={loan.publicId ?? loan.id} />

                    <LoanRepaymentHistory
                        key={loan.publicId ?? loan.id}
                        loanPublicId={loan.publicId ?? loan.id}
                        borrowerName={borrower?.name ?? t("loanDetail.unknownBorrower", "Unknown borrower")}
                        borrowerPublicId={loan.borrowerPublicId}
                    />

                    <Card>
                        <CardHeader>
                            <CardTitle>{t("loanDetail.profitabilitySnapshot", "Profitability Snapshot")}</CardTitle>
                        </CardHeader>
                            <CardContent className="grid gap-4 md:grid-cols-2 xl:grid-cols-6">
                            <div>
                                <div className="text-xs text-muted-foreground">{t("dashboardPage.cards.borrowerRevenue", "Revenue collected")}</div>
                                <div className="font-medium">{formatCurrency(Number(profitability?.borrowerRevenueCollected ?? 0))}</div>
                            </div>
                            <div>
                                <div className="text-xs text-muted-foreground">{t("dashboardPage.cards.fundCostPaid", "Fund cost paid")}</div>
                                <div className="font-medium">{formatCurrency(Number(profitability?.fundCostPaid ?? 0))}</div>
                            </div>
                            <div>
                                <div className="text-xs text-muted-foreground">{t("funds.metrics.realizedSpread", "Realized spread")}</div>
                                <div className={`font-medium ${Number(profitability?.realizedSpread ?? 0) >= 0 ? "text-emerald-600" : "text-destructive"}`}>
                                    {formatCurrency(Number(profitability?.realizedSpread ?? 0))}
                                </div>
                            </div>
                            <div>
                                <div className="text-xs text-muted-foreground">{t("loans.unrealizedSpread", "Unrealized spread")}</div>
                                <div className={`font-medium ${Number(profitability?.unrealizedSpread ?? 0) >= 0 ? "text-emerald-600" : "text-destructive"}`}>
                                    {formatCurrency(Number(profitability?.unrealizedSpread ?? 0))}
                                </div>
                            </div>
                            <div>
                                <div className="text-xs text-muted-foreground">{t("loanDetail.fundingShare", "Funding share")}</div>
                                <div className="font-medium">{((Number(profitability?.fundingShare ?? 0)) * 100).toFixed(1)}%</div>
                            </div>
                            <div>
                                <div className="text-xs text-muted-foreground">{t("loanDetail.outstandingFundingCost", "Outstanding funding cost")}</div>
                                <div className="font-medium">{formatCurrency(Number(profitability?.estimatedOutstandingFundingCost ?? 0))}</div>
                            </div>
                        </CardContent>
                    </Card>

                    <div className="grid gap-4 xl:grid-cols-[1.15fr_0.85fr]">
                        <Card>
                            <CardHeader>
                                <CardTitle>{t("loanDetail.fundingComposition", "Funding Composition")}</CardTitle>
                            </CardHeader>
                            <CardContent>
                                {profitability?.fundingComposition?.length ? (
                                    <div className="space-y-3">
                                        {profitability.fundingComposition.map((item) => (
                                            <div key={item.bankLoanPublicId} className="rounded border p-3 text-sm">
                                                <div className="flex items-center justify-between gap-3">
                                                    <div>
                                                        <div className="font-medium">{t("dashboardPage.drawdownLabel", { defaultValue: "Drawdown #{{id}}", id: item.bankLoanPublicId })}</div>
                                                        <div className="text-xs text-muted-foreground">
                                                            {t("loanDetail.shareOfLoan", "Share of loan")}: {(item.shareOfLoanPrincipal * 100).toFixed(1)}% • {t("loanDetail.shareOfDrawdownCost", "Share of drawdown cost")}: {(item.shareOfDrawdown * 100).toFixed(1)}%
                                                        </div>
                                                    </div>
                                                    <Link to={`/funds/${item.bankProfilePublicId}?bankLoanId=${item.bankLoanPublicId}`} className="text-primary text-xs hover:underline">
                                                        {t("loanDetail.openDrawdown", "Open drawdown")}
                                                    </Link>
                                                </div>
                                                <div className="mt-3 grid gap-3 md:grid-cols-3">
                                                    <div>
                                                        <div className="text-xs text-muted-foreground">{t("loanDetail.allocatedPrincipal", "Allocated principal")}</div>
                                                        <div className="font-medium">{formatCurrency(Number(item.netAllocatedPrincipal))}</div>
                                                    </div>
                                                    <div>
                                                        <div className="text-xs text-muted-foreground">{t("loanDetail.estimatedCostPaid", "Estimated cost paid")}</div>
                                                        <div className="font-medium">
                                                            {formatCurrency(
                                                                Number(item.estimatedBankInterestPaid) +
                                                                Number(item.estimatedBankFeesPaid) +
                                                                Number(item.estimatedBankVatPaid) +
                                                                Number(item.estimatedBankPenaltiesPaid)
                                                            )}
                                                        </div>
                                                    </div>
                                                    <div>
                                                        <div className="text-xs text-muted-foreground">{t("loanDetail.outstandingCostAllocated", "Outstanding cost allocated")}</div>
                                                        <div className="font-medium">{formatCurrency(Number(item.outstandingCostAllocated))}</div>
                                                    </div>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                ) : loan.bankProfilePublicId && !loan.bankLoanPublicId ? (
                                    <div className="rounded border border-dashed p-4 text-sm text-muted-foreground">
                                        {t("loanDetail.ownCapital.noDrawdown", "This loan is funded directly from own capital, not an unmatched drawdown.")}
                                    </div>
                                ) : (
                                    <div className="rounded border border-dashed p-4 text-sm text-muted-foreground">
                                        {t("loanDetail.noFundingComposition", "This loan has not been matched to any funding drawdown yet.")}
                                    </div>
                                )}
                            </CardContent>
                        </Card>

                        <Card>
                            <CardHeader>
                                <CardTitle>{t("loanDetail.repaymentSchedule", "Repayment Schedule")}</CardTitle>
                            </CardHeader>
                            <CardContent>
                                {schedule.length === 0 ? (
                                    <div className="rounded border border-dashed p-4 text-sm text-muted-foreground">
                                        {t("loanDetail.noRepaymentSchedule", "No repayment schedule available for this loan.")}
                                    </div>
                                ) : (
                                    <div className="space-y-2">
                                        {schedule.slice(0, 8).map((row) => (
                                            <div key={row.id} className="rounded border p-3 text-sm">
                                                <div className="flex items-center justify-between gap-3">
                                                    <div>
                                                        <div className="font-medium">{t("loanDetail.installmentLabel", { defaultValue: "Installment #{{id}}", id: row.installmentNo })}</div>
                                                        <div className="text-xs text-muted-foreground">{row.dueDate}</div>
                                                    </div>
                                                    <div className="text-right">
                                                        <div className="font-medium">{formatCurrency(Number(row.remainingDue ?? 0))}</div>
                                                        <Badge variant={row.status === "overdue" ? "destructive" : row.status === "paid" ? "secondary" : "outline"}>
                                                            {t(`loans.paymentHealth.scheduleStatus.${row.status}`, { defaultValue: row.status })}
                                                        </Badge>
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
                            <CardTitle>{t("loanDetail.allocationHistory", "Allocation History")}</CardTitle>
                        </CardHeader>
                        <CardContent>
                            {allocations.length === 0 ? (
                                <div className="rounded border border-dashed p-4 text-sm text-muted-foreground">
                                    {t("loanDetail.noAllocationHistory", "No funding allocations have been recorded for this loan yet.")}
                                </div>
                            ) : (
                                <div className="space-y-2">
                                    {allocations.map((row) => (
                                        <div key={row.id} className="rounded border p-3 text-sm">
                                            <div className="flex items-center justify-between gap-3">
                                                <div>
                                                    <div className="font-medium">
                                                        {row.allocationType} {row.bankLoanPublicId ? `• Drawdown #${row.bankLoanPublicId}` : ""}
                                                    </div>
                                                    <div className="text-xs text-muted-foreground">
                                                        {row.bankProfileName ?? t("matching.unknownSource", "Unknown source")} • {row.allocationDate ?? "-"}
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

                    {loan.repaymentType === "daily" && ["active", "paid"].includes(loan.status) && (
                        <LoanRenewalPanel loan={loan} />
                    )}
                </>
            )}
        </div>
    );
}
