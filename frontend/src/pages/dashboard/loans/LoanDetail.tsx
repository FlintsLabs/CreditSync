import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, CalendarDays, CheckCircle, Copy, User2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import Decimal from "decimal.js";
import { api } from "../../../lib/api";
import { getStoredUser, isTenantAdminUser } from "../../../lib/session";
import { Button } from "../../../components/ui/Button";
import { Input } from "../../../components/ui/Input";
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
import { formatMoneyExact } from "../../../lib/workflow-model";
import { LoanRenewalPanel } from "./LoanRenewalPanel";
import { LoanDisbursements, type LoanDisbursementsHandle } from "./LoanDisbursements";
import type { DisbursementSummaryInput } from "../../../lib/disbursement-view";
import { FloatingInterestRateCard } from "./FloatingInterestRateCard";
import { FloatingInterestSummary, type FloatingInterestPolicyView } from "./FloatingInterestSummary";
import { IntermediatedDisbursementPanel } from "./IntermediatedDisbursementPanel";
import { LoanRestructurePanel } from "./LoanRestructurePanel";
import { LoanReplacementPanel } from "./LoanReplacementPanel";
import { LoanOpeningBalances, type OpeningBalanceComponent, type RestructureLineage, type RestructureWaiver } from "./LoanOpeningBalances";
import { LoanDetailTabs, type LoanDetailTab } from "./LoanDetailTabs";
import { LoanInformationTab } from "./LoanInformationTab";
import { LoanAgentsTab } from "./LoanAgentsTab";
import { LoanPaymentHistoryTab } from "./LoanPaymentHistoryTab";
import { LoanRepaymentScheduleTab } from "./LoanRepaymentScheduleTab";

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
    floatingInterestPolicy?: FloatingInterestPolicyView | null;
    floatingPayoutSummary?: {
        fullPeriodInterest: string;
        advanceInterest: string;
        netBorrowerPayout: string;
        periodDays: number;
        firstPeriodStartDate: string;
        firstPeriodDueDate: string;
    } | null;
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
    replacementLineage?: {
        status: "executed" | "reversed";
        replacedFromPublicId: string | null;
        replacedToPublicId: string | null;
    } | null;
    openingBalanceComponents?: OpeningBalanceComponent[];
    restructureWaivers?: RestructureWaiver[];
}

interface BorrowerData {
    id: string;
    publicId?: string;
    name: string;
    phone?: string | null;
    tags?: string[] | null;
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

interface LoanSettlementPreview {
    id: string;
    publicId: string;
    loanPublicId: string;
    status: "ready" | "expired" | "executed";
    asOfDate: string;
    outstandingPrincipal: string;
    dueInterest: string;
    accruedNotDueInterest: string;
    outstandingFees: string;
    outstandingPenalties: string;
    nonRefundableAdvanceInterest: string;
    settlementTotal: string;
    balanceVersion: string;
    previewHash: string;
    expiresAt: string;
}

interface LoanSettlementExecution extends LoanSettlementPreview {
    status: "executed";
    reason: string;
    auditPublicId: string;
    correlationId: string;
    transaction: {
        id: string;
        publicId: string;
        amount: string;
        principalComponent: string;
        interestComponent: string;
        feeComponent: string;
        penaltyComponent: string;
        type: "close_account";
        entryType: "repayment";
        transactionDate: string;
        postedAt: string;
    };
}

function bangkokBusinessDate() {
    return new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Bangkok",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).format(new Date());
}

function domainErrorCode(error: unknown) {
    return (error as { response?: { data?: { code?: string } } }).response?.data?.code;
}

export default function LoanDetail() {
    const { t, i18n } = useTranslation();
    const navigate = useNavigate();
    const { id } = useParams();
    const currentUser = getStoredUser();
    const isTenantAdmin = isTenantAdminUser(currentUser);
    const [loading, setLoading] = useState(true);
    const [activeTab, setActiveTab] = useState<LoanDetailTab>("information");
    const [errorMessage, setErrorMessage] = useState("");
    const [copiedLoanId, setCopiedLoanId] = useState(false);
    const [loan, setLoan] = useState<LoanDetailData | null>(null);
    const [borrower, setBorrower] = useState<BorrowerData | null>(null);
    const [allocations, setAllocations] = useState<AllocationRow[]>([]);
    const [profitability, setProfitability] = useState<LoanProfitability | null>(null);
    const [allocationState, setAllocationState] = useState<LoanAllocationState | null>(null);
    const [disbursementSummary, setDisbursementSummary] = useState<DisbursementSummaryInput | null>(null);
    const [activationOpen, setActivationOpen] = useState(false);
    const [activating, setActivating] = useState(false);
    const activationIntentRef = useRef<{ loanPublicId: string; key: string } | null>(null);
    const settlementIntentRef = useRef<{ fingerprint: string; key: string } | null>(null);
    const settlementReversalIntentRef = useRef<{ fingerprint: string; key: string } | null>(null);
    const [settlementDate, setSettlementDate] = useState(bangkokBusinessDate);
    const [settlementPreview, setSettlementPreview] = useState<LoanSettlementPreview | null>(null);
    const [settlementOpen, setSettlementOpen] = useState(false);
    const [settlementReason, setSettlementReason] = useState("");
    const [settlementConfirmed, setSettlementConfirmed] = useState(false);
    const [settlementBusy, setSettlementBusy] = useState(false);
    const [settlementError, setSettlementError] = useState("");
    const [settlementExecuted, setSettlementExecuted] = useState(false);
    const [executedSettlementPublicId, setExecutedSettlementPublicId] = useState<string | null>(null);
    const [settlementReversalReason, setSettlementReversalReason] = useState("");
    const [settlementReversalConfirmed, setSettlementReversalConfirmed] = useState(false);
    const [postSettlementRefreshStatus, setPostSettlementRefreshStatus] = useState<"idle" | "refreshing" | "failed">("idle");
    const [replacementRefreshToken, setReplacementRefreshToken] = useState(0);
    const disbursementsRef = useRef<LoanDisbursementsHandle>(null);
    const money = (value: string | null | undefined) => formatMoneyExact(value ?? "0.00", i18n.language);
    const isPositiveMoney = (value: string | null | undefined) => new Decimal(value ?? "0").isPositive();
    const isNegativeMoney = (value: string | null | undefined) => new Decimal(value ?? "0").isNegative();

    useEffect(() => {
        const run = async () => {
            if (!id) {
                setErrorMessage(t("loanDetail.errors.notFound", "Loan not found."));
                setLoading(false);
                return;
            }

            try {
                setLoading(true);
                setDisbursementSummary(null);
                const [loanRes, allocationsRes, allocationStateRes] = await Promise.all([
                    api.get(`/loans/${id}`),
                    api.get(`/loans/${id}/funding-allocations`),
                    api.get(`/loans/${id}/allocation-state`),
                ]);
                const profitabilityRes = isTenantAdmin
                    ? await api.get(`/loans/${id}/profitability`)
                    : { data: null };

                const loanData = loanRes.data ?? null;
                setLoan(loanData);
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
    }, [id, isTenantAdmin, replacementRefreshToken, t]);

    const activateDraft = async () => {
        if (!loan || loan.status !== "draft" || activating) return;
        try {
            setActivating(true);
            if (activationIntentRef.current?.loanPublicId !== loan.publicId) {
                activationIntentRef.current = { loanPublicId: loan.publicId, key: crypto.randomUUID() };
            }
            const response = await api.post(`/loans/${loan.publicId}/activate`, undefined, {
                headers: { "Idempotency-Key": activationIntentRef.current.key },
            });
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

    const refreshSettlementDependents = async () => {
        if (!loan) throw new Error("Loan is unavailable");
        const [loanResponse, profitabilityResponse] = await Promise.all([
            api.get<LoanDetailData>(`/loans/${loan.publicId}`),
            isTenantAdmin
                ? api.get<LoanProfitability>(`/loans/${loan.publicId}/profitability`)
                : Promise.resolve({ data: null }),
        ]);
        setLoan(loanResponse.data);
        setProfitability(profitabilityResponse.data);
    };

    const requestSettlementPreview = async () => {
        if (!loan) throw new Error("Loan is unavailable");
        const response = await api.post<LoanSettlementPreview>("/loan-settlements/preview", {
            loanPublicId: loan.publicId,
            asOfDate: settlementDate,
        });
        return response.data;
    };

    const previewSettlement = async () => {
        if (!loan || settlementBusy) return;
        try {
            setSettlementBusy(true);
            setSettlementError("");
            const preview = await requestSettlementPreview();
            setSettlementPreview(preview);
            setSettlementConfirmed(false);
            setSettlementReason("");
            setSettlementError("");
            setSettlementExecuted(false);
            setSettlementOpen(true);
            settlementIntentRef.current = null;
        } catch (error) {
            console.error("Failed to preview floating-loan settlement", error);
            setSettlementError(t("loanDetail.settlement.errors.preview"));
        } finally {
            setSettlementBusy(false);
        }
    };

    const executeSettlement = async () => {
        if (!settlementPreview || !settlementConfirmed || !settlementReason.trim() || settlementBusy) return;
        const reason = settlementReason.trim();
        const fingerprint = `${settlementPreview.publicId}:${settlementPreview.previewHash}:${reason}`;
        if (settlementIntentRef.current?.fingerprint !== fingerprint) {
            settlementIntentRef.current = { fingerprint, key: crypto.randomUUID() };
        }
        try {
            setSettlementBusy(true);
            const executedPublicId = settlementPreview.publicId;
            await api.post<LoanSettlementExecution>(`/loan-settlements/${executedPublicId}/execute`, {
                previewHash: settlementPreview.previewHash,
                confirmed: true,
                reason,
            }, { headers: { "Idempotency-Key": settlementIntentRef.current.key } });
            setSettlementPreview(null);
            setSettlementConfirmed(false);
            setSettlementError("");
            setSettlementExecuted(true);
            setExecutedSettlementPublicId(executedPublicId);
            setPostSettlementRefreshStatus("refreshing");
            try {
                await refreshSettlementDependents();
                setPostSettlementRefreshStatus("idle");
                setErrorMessage("");
            } catch (refreshError) {
                console.error("Settlement executed but authoritative loan detail could not be refreshed", refreshError);
                setPostSettlementRefreshStatus("failed");
                setErrorMessage(t("loanDetail.settlement.errors.refreshAfterExecution"));
            }
        } catch (error) {
            if (domainErrorCode(error) === "STALE_SETTLEMENT_PREVIEW") {
                setSettlementConfirmed(false);
                settlementIntentRef.current = null;
                setSettlementError(t("loanDetail.settlement.errors.stale"));
                try {
                    setSettlementPreview(await requestSettlementPreview());
                } catch (refreshError) {
                    console.error("Failed to refresh stale floating-loan settlement", refreshError);
                    setSettlementPreview(null);
                    setSettlementError(t("loanDetail.settlement.errors.refresh"));
                }
            } else {
                console.error("Failed to execute floating-loan settlement", error);
                setSettlementError(t("loanDetail.settlement.errors.execute"));
            }
        } finally {
            setSettlementBusy(false);
        }
    };

    const reverseSettlement = async () => {
        if (!executedSettlementPublicId || !settlementReversalConfirmed || !settlementReversalReason.trim() || settlementBusy) return;
        const reason = settlementReversalReason.trim();
        const fingerprint = `${executedSettlementPublicId}:${reason}`;
        if (settlementReversalIntentRef.current?.fingerprint !== fingerprint) {
            settlementReversalIntentRef.current = { fingerprint, key: crypto.randomUUID() };
        }
        try {
            setSettlementBusy(true);
            setSettlementError("");
            await api.post(`/loan-settlements/${executedSettlementPublicId}/reverse`, { reason }, {
                headers: { "Idempotency-Key": settlementReversalIntentRef.current.key },
            });
            await refreshSettlementDependents();
            setSettlementOpen(false);
            setSettlementExecuted(false);
            setExecutedSettlementPublicId(null);
            setSettlementReversalReason("");
            setSettlementReversalConfirmed(false);
            setErrorMessage("");
        } catch (error) {
            console.error("Failed to reverse floating-loan settlement", error);
            setSettlementError(t("loanDetail.settlement.errors.reverse"));
        } finally {
            setSettlementBusy(false);
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

            <Dialog open={settlementOpen} onOpenChange={(open) => {
                if (settlementBusy) return;
                setSettlementOpen(open);
                if (!open) {
                    setSettlementConfirmed(false);
                    setSettlementError("");
                    setSettlementExecuted(false);
                }
            }}>
                <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
                    <DialogHeader>
                        <DialogTitle>{t("loanDetail.settlement.confirmTitle")}</DialogTitle>
                        <DialogDescription>{t("loanDetail.settlement.confirmDescription")}</DialogDescription>
                    </DialogHeader>
                    {settlementError && <div role="alert" className="rounded border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-200">{settlementError}</div>}
                    {settlementExecuted ? (
                        <>
                            <div role="status" aria-live="polite" className="flex items-center gap-2 rounded border border-emerald-500/30 bg-emerald-500/10 p-4 font-medium text-emerald-700 dark:text-emerald-300">
                                <CheckCircle className="h-5 w-5" />{t("loanDetail.settlement.executed")}
                            </div>
                            {postSettlementRefreshStatus === "failed" && (
                                <div role="alert" className="rounded border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-200">
                                    {t("loanDetail.settlement.errors.refreshAfterExecution")}
                                </div>
                            )}
                            <div className="grid gap-2">
                                <label htmlFor="settlement-reversal-reason">{t("loanDetail.settlement.reversalReason")}</label>
                                <Input id="settlement-reversal-reason" value={settlementReversalReason} onChange={(event) => {
                                    setSettlementReversalReason(event.target.value);
                                    setSettlementReversalConfirmed(false);
                                    settlementReversalIntentRef.current = null;
                                }} />
                            </div>
                            <label className="flex items-start gap-2 text-sm">
                                <input type="checkbox" className="mt-1" checked={settlementReversalConfirmed} onChange={(event) => setSettlementReversalConfirmed(event.target.checked)} />
                                <span>{t("loanDetail.settlement.reversalConfirmation")}</span>
                            </label>
                        </>
                    ) : settlementPreview ? (
                        <>
                            <dl className="grid gap-3 text-sm sm:grid-cols-2">
                                {([
                                    ["outstandingPrincipal", settlementPreview.outstandingPrincipal],
                                    ["dueInterest", settlementPreview.dueInterest],
                                    ["accruedNotDueInterest", settlementPreview.accruedNotDueInterest],
                                    ["outstandingFees", settlementPreview.outstandingFees],
                                    ["outstandingPenalties", settlementPreview.outstandingPenalties],
                                    ["nonRefundableAdvanceInterest", settlementPreview.nonRefundableAdvanceInterest],
                                    ["settlementTotal", settlementPreview.settlementTotal],
                                ] as const).map(([label, value]) => (
                                    <div key={label} className={label === "settlementTotal" ? "rounded border bg-muted/30 p-3 sm:col-span-2" : ""}>
                                        <dt className="text-muted-foreground">{t(`loanDetail.settlement.${label}`)}</dt>
                                        <dd className="font-medium tabular-nums">{money(value)}</dd>
                                    </div>
                                ))}
                            </dl>
                            <div className="rounded border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-200">{t("loanDetail.settlement.nonRefundableNote")}</div>
                            <div className="text-xs text-muted-foreground">{t("loanDetail.settlement.expires", { value: new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Bangkok" }).format(new Date(settlementPreview.expiresAt)) })}</div>
                            <div className="grid gap-2">
                                <label htmlFor="settlement-reason">{t("loanDetail.settlement.reason")}</label>
                                <Input id="settlement-reason" value={settlementReason} onChange={(event) => { setSettlementReason(event.target.value); setSettlementConfirmed(false); settlementIntentRef.current = null; }} />
                            </div>
                            <label className="flex items-start gap-2 text-sm">
                                <input type="checkbox" className="mt-1" checked={settlementConfirmed} onChange={(event) => setSettlementConfirmed(event.target.checked)} />
                                <span>{t("loanDetail.settlement.confirmation")}</span>
                            </label>
                        </>
                    ) : null}
                    <DialogFooter>
                        <Button variant="outline" disabled={settlementBusy} onClick={() => setSettlementOpen(false)}>{t("common.cancel")}</Button>
                        {!settlementExecuted && <Button disabled={settlementBusy || !settlementPreview || !settlementConfirmed || !settlementReason.trim()} onClick={() => void executeSettlement()}>
                            {settlementBusy ? t("loanDetail.settlement.executing") : t("loanDetail.settlement.execute")}
                        </Button>}
                        {settlementExecuted && <Button variant="destructive" disabled={settlementBusy || !settlementReversalConfirmed || !settlementReversalReason.trim()} onClick={() => void reverseSettlement()}>
                            {settlementBusy ? t("loanDetail.settlement.reversing") : t("loanDetail.settlement.reverse")}
                        </Button>}
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
            ) : postSettlementRefreshStatus !== "idle" ? (
                <Card>
                    <CardContent className="py-10 text-center text-muted-foreground">
                        {t(`loanDetail.settlement.${postSettlementRefreshStatus === "refreshing" ? "refreshingAfterExecution" : "latestDetailUnavailable"}`)}
                    </CardContent>
                </Card>
            ) : !loan ? (
                <Card>
                    <CardContent className="py-10 text-center text-muted-foreground">
                        {t("loanDetail.missing", "This loan does not exist anymore.")}
                    </CardContent>
                </Card>
            ) : (
                <LoanDetailTabs value={activeTab} onChange={setActiveTab} renderPanel={(tab) => tab === "agents"
                    ? <LoanAgentsTab loanPublicId={loan.publicId} />
                    : tab === "payments"
                        ? <LoanPaymentHistoryTab loanPublicId={loan.publicId} />
                        : tab === "schedule"
                            ? <LoanRepaymentScheduleTab loanPublicId={loan.publicId} />
                            : <LoanInformationTab>
                <>
                    {loan.repaymentType === "daily" && loan.dailyLoanCalculation && (
                        <Card>
                            <CardHeader><CardTitle>{t("loanDetail.dailyTerms.title", "Daily repayment terms")}</CardTitle></CardHeader>
                            <CardContent className="grid gap-3 text-sm sm:grid-cols-2 xl:grid-cols-6">
                                <div><div className="text-muted-foreground">{t("loanDetail.dailyTerms.duration", "Duration")}</div><div className="font-medium">{loan.dailyLoanCalculation.durationValue} {t(`loanDetail.dailyTerms.units.${loan.dailyLoanCalculation.durationUnit}`, loan.dailyLoanCalculation.durationUnit)}</div></div>
                                <div><div className="text-muted-foreground">{t("loanDetail.dailyTerms.agreedInstallment", "Agreed instalment")}</div><div className="font-medium">{money(loan.dailyLoanCalculation.installmentAmount)}</div></div>
                                <div><div className="text-muted-foreground">{t("loanDetail.dailyTerms.installments", "Total instalments")}</div><div className="font-medium">{loan.dailyLoanCalculation.totalInstallments}</div></div>
                                <div><div className="text-muted-foreground">{t("loanDetail.dailyTerms.totalInterest", "Total interest")}</div><div className="font-medium">{money(loan.dailyLoanCalculation.totalInterest)}</div></div>
                                <div><div className="text-muted-foreground">{t("loanDetail.dailyTerms.dailyInterest", "Daily interest")}</div><div className="font-medium">{money(loan.dailyLoanCalculation.dailyInterest)}</div></div>
                                <div><div className="text-muted-foreground">{t("loanDetail.dailyTerms.flatRate", "Flat daily rate")}</div><div className="font-medium">{loan.dailyLoanCalculation.flatDailyRatePercent}%</div></div>
                            </CardContent>
                            <CardContent className="pt-0 text-xs text-muted-foreground">{t("loanDetail.dailyTerms.notice", "The agreed instalment is fixed. A smaller payment leaves the scheduled remainder due; early settlement requires its own preview.")}</CardContent>
                        </Card>
                    )}
                    {loan.repaymentType === "floating" && loan.floatingInterestPolicy && (
                        <FloatingInterestSummary
                            policy={loan.floatingInterestPolicy}
                            fullPeriodInterest={loan.floatingPayoutSummary?.fullPeriodInterest}
                            advanceInterest={loan.floatingPayoutSummary?.advanceInterest}
                            netBorrowerPayout={loan.floatingPayoutSummary?.netBorrowerPayout}
                            periodDays={loan.floatingPayoutSummary?.periodDays}
                            firstPeriodStartDate={loan.floatingPayoutSummary?.firstPeriodStartDate}
                            firstPeriodDueDate={loan.floatingPayoutSummary?.firstPeriodDueDate}
                            postedGrossAmount={disbursementSummary?.postedGrossAmount}
                            postedEventCount={disbursementSummary?.postedEventCount}
                            dueInterest={loan.status === "active" ? settlementPreview?.dueInterest ?? loan.outstandingInterest : undefined}
                            accruedNotDueInterest={loan.status === "active" ? settlementPreview?.accruedNotDueInterest : undefined}
                        >
                            {loan.status === "active" && (
                                <div className="flex flex-col gap-3 border-t pt-4 sm:flex-row sm:items-end">
                                    <div className="grid flex-1 gap-2">
                                        <label htmlFor="settlement-date">{t("loanDetail.settlement.date")}</label>
                                        <Input id="settlement-date" type="date" value={settlementDate} onChange={(event) => { setSettlementDate(event.target.value); setSettlementPreview(null); setSettlementConfirmed(false); setSettlementError(""); settlementIntentRef.current = null; }} />
                                    </div>
                                    <Button disabled={settlementBusy || !settlementDate} onClick={() => void previewSettlement()}>{settlementBusy ? t("loanDetail.settlement.previewing") : t("loanDetail.settlement.preview")}</Button>
                                </div>
                            )}
                            {settlementError && !settlementOpen && (
                                <div role="alert" className="rounded border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                                    {settlementError}
                                </div>
                            )}
                        </FloatingInterestSummary>
                    )}
                    {loan.repaymentType === "floating" && <FloatingInterestRateCard loanPublicId={loan.publicId ?? loan.id} periodUnit={loan.floatingInterestPolicy?.periodUnit ?? "day"} />}
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
                                {borrower?.tags && borrower.tags.length > 0 && (
                                    <div data-testid="loan-borrower-tags" className="flex flex-wrap gap-1">
                                        {borrower.tags.slice(0, 3).map((tag) => (
                                            <Badge key={tag} variant="secondary" className="h-5 px-1.5 py-0 text-[10px]">
                                                {tag}
                                            </Badge>
                                        ))}
                                        {borrower.tags.length > 3 && <span className="self-center text-[10px] text-muted-foreground">+{borrower.tags.length - 3}</span>}
                                    </div>
                                )}
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
                                    <span className="font-medium">{money(loan.principalAmount)}</span>
                                </div>
                                <div className="flex justify-between">
                                    <span>{t("loanWizard.outstandingPrincipal", "Outstanding principal")}</span>
                                    <span className="font-medium">{money(loan.outstandingPrincipal)}</span>
                                </div>
                                <div className="flex justify-between">
                                    <span>{t("loanDetail.outstandingInterest", "Outstanding interest")}</span>
                                    <span className="font-medium">{money(loan.outstandingInterest)}</span>
                                </div>
                                <div className="flex justify-between">
                                    <span>{t("common.status", "Status")}</span>
                                    <span className="font-medium">{t(`loans.status.${loan.status}`, { defaultValue: loan.status })}</span>
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
                                    <span className="font-medium">{money(allocationState?.netAllocatedPrincipal)}</span>
                                </div>
                                <div className="flex justify-between">
                                    <span>{t("loans.remainingGap", "Remaining gap")}</span>
                                    <span className={`font-medium ${isPositiveMoney(allocationState?.remainingGap) ? "text-destructive" : "text-emerald-600"}`}>
                                        {money(allocationState?.remainingGap)}
                                    </span>
                                </div>
                                <div className="flex justify-between">
                                    <span>{t("loanDetail.overfunded", "Overfunded")}</span>
                                    <span className="font-medium">{money(allocationState?.overfundedAmount)}</span>
                                </div>
                            </CardContent>
                        </Card>

                        <Card>
                            <CardHeader className="pb-2">
                                <CardTitle className="text-sm font-medium text-muted-foreground">{t("loanWizard.nextDue", "Next Due")}</CardTitle>
                            </CardHeader>
                            <CardContent className="space-y-2 text-sm">
                                {loan.nextDueDate ? (
                                    <>
                                        <div className="flex items-center gap-2">
                                            <CalendarDays className="h-4 w-4 text-muted-foreground" />
                                            <span className="font-medium">{loan.nextDueDate}</span>
                                        </div>
                                        <Link to={`/transactions/new?loanId=${loan.publicId ?? loan.id}`} className="text-primary text-xs hover:underline">
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
                    {loan.replacementLineage && <Card>
                        <CardHeader><CardTitle>{t("replacement.lineage.title")}</CardTitle></CardHeader>
                        <CardContent><nav aria-label={t("replacement.lineage.title")} className="flex flex-wrap gap-3 text-sm">
                            {loan.replacementLineage.replacedFromPublicId && <Link className="text-primary hover:underline" to={`/loans/${loan.replacementLineage.replacedFromPublicId}`}>{t("replacement.lineage.from")}</Link>}
                            {loan.replacementLineage.replacedToPublicId && <Link className="text-primary hover:underline" to={`/loans/${loan.replacementLineage.replacedToPublicId}`}>{t("replacement.lineage.to")}</Link>}
                            <span className="text-muted-foreground">{t(`replacement.lineage.${loan.replacementLineage.status}`)}</span>
                        </nav></CardContent>
                    </Card>}
                    {loan.status === "active" && <LoanReplacementPanel oldLoanPublicId={loan.publicId} onInvalidated={() => setReplacementRefreshToken((value) => value + 1)} />}
                    <LoanRestructurePanel loan={loan} onExecuted={() => window.location.reload()} />

                    <LoanDisbursements ref={disbursementsRef} loanPublicId={loan.publicId ?? loan.id} onSummaryChange={setDisbursementSummary} />

                    <IntermediatedDisbursementPanel loanPublicId={loan.publicId ?? loan.id} onPosted={async () => {
                        if (!disbursementsRef.current) throw new Error("Disbursement ledger is unavailable");
                        await disbursementsRef.current.refresh();
                    }} />

                    <Card>
                        <CardHeader>
                            <CardTitle>{t("loanDetail.profitabilitySnapshot", "Profitability Snapshot")}</CardTitle>
                        </CardHeader>
                            <CardContent className="grid gap-4 md:grid-cols-2 xl:grid-cols-6">
                            <div>
                                <div className="text-xs text-muted-foreground">{t("dashboardPage.cards.borrowerRevenue", "Revenue collected")}</div>
                                <div className="font-medium">{money(profitability?.borrowerRevenueCollected)}</div>
                            </div>
                            <div>
                                <div className="text-xs text-muted-foreground">{t("dashboardPage.cards.fundCostPaid", "Fund cost paid")}</div>
                                <div className="font-medium">{money(profitability?.fundCostPaid)}</div>
                            </div>
                            <div>
                                <div className="text-xs text-muted-foreground">{t("funds.metrics.realizedSpread", "Realized spread")}</div>
                                <div className={`font-medium ${isNegativeMoney(profitability?.realizedSpread) ? "text-destructive" : "text-emerald-600"}`}>
                                    {money(profitability?.realizedSpread)}
                                </div>
                            </div>
                            <div>
                                <div className="text-xs text-muted-foreground">{t("loans.unrealizedSpread", "Unrealized spread")}</div>
                                <div className={`font-medium ${isNegativeMoney(profitability?.unrealizedSpread) ? "text-destructive" : "text-emerald-600"}`}>
                                    {money(profitability?.unrealizedSpread)}
                                </div>
                            </div>
                            <div>
                                <div className="text-xs text-muted-foreground">{t("loanDetail.fundingShare", "Funding share")}</div>
                                <div className="font-medium">{new Intl.NumberFormat(i18n.language, { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(profitability?.fundingShare ?? 0)}</div>
                            </div>
                            <div>
                                <div className="text-xs text-muted-foreground">{t("loanDetail.outstandingFundingCost", "Outstanding funding cost")}</div>
                                <div className="font-medium">{money(profitability?.estimatedOutstandingFundingCost)}</div>
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
                                                        <div className="font-medium">{money(item.netAllocatedPrincipal)}</div>
                                                    </div>
                                                    <div>
                                                        <div className="text-xs text-muted-foreground">{t("loanDetail.estimatedCostPaid", "Estimated cost paid")}</div>
                                                        <div className="space-y-0.5 text-xs font-medium">
                                                            <div>{t("loanDetail.costComponents.interest")}: {money(item.estimatedBankInterestPaid)}</div>
                                                            <div>{t("loanDetail.costComponents.fees")}: {money(item.estimatedBankFeesPaid)}</div>
                                                            <div>{t("loanDetail.costComponents.vat")}: {money(item.estimatedBankVatPaid)}</div>
                                                            <div>{t("loanDetail.costComponents.penalties")}: {money(item.estimatedBankPenaltiesPaid)}</div>
                                                        </div>
                                                    </div>
                                                    <div>
                                                        <div className="text-xs text-muted-foreground">{t("loanDetail.outstandingCostAllocated", "Outstanding cost allocated")}</div>
                                                        <div className="font-medium">{money(item.outstandingCostAllocated)}</div>
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
                                                <div className={`font-medium ${isNegativeMoney(row.allocatedAmount) ? "text-destructive" : "text-emerald-600"}`}>
                                                    {isNegativeMoney(row.allocatedAmount) ? "" : "+"}{money(row.allocatedAmount)}
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
                </LoanInformationTab>} />
            )}
        </div>
    );
}
