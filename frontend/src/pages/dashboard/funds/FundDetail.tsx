import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ArrowLeft, ArrowRightLeft, Building2, CalendarDays, Wallet } from "lucide-react";
import { Link } from "react-router-dom";
import { Button } from "../../../components/ui/Button";
import { Card, CardContent, CardHeader, CardTitle } from "../../../components/ui/Card";
import { useTranslation } from "react-i18next";
import { api } from "../../../lib/api";
import { Input } from "../../../components/ui/Input";
import { Badge } from "../../../components/ui/badge";
import { formatMoneyExact } from "../../../lib/workflow-model";
import Decimal from "decimal.js";

interface BankProfile {
    id: number;
    publicId?: string;
    name: string;
    type: string;
    creditLimit: string | null;
    accountingMode?: string;
    opportunityCostRate?: string | null;
    providerName?: string | null;
    referenceNo?: string | null;
    reinvestProfitMode?: string | null;
    note?: string | null;
    status?: string | null;
}

interface BankLoan {
    id: number;
    amount: string;
    interestRate: string | null;
    startDate: string | null;
    termMonths: number | null;
    repaymentCycle: string | null;
    repaymentMode: string | null;
    installmentAmount: string | null;
    totalInstallments: number | null;
    nextDueDate: string | null;
    outstandingPrincipal: string | null;
    outstandingInterest: string | null;
    outstandingFees: string | null;
    status: string | null;
}

interface BankLoanSchedule {
    id: number;
    installmentNo: number;
    dueDate: string;
    scheduledPrincipal: string;
    scheduledInterest: string;
    scheduledFee: string;
    scheduledVat: string;
    scheduledTotal: string;
    remainingDue: string;
    penaltyDue?: string;
    totalDueNow?: string;
    overdueDays?: number;
    status: string;
}

interface BankLoanRepayment {
    id: number;
    scheduleId: number | null;
    paymentDate: string;
    amount: string;
    principalComponent: string;
    interestComponent: string;
    feeComponent: string;
    vatComponent: string;
    penaltyComponent: string;
    paymentMethod: string | null;
    reference: string | null;
    note: string | null;
}

interface Allocation {
    id: number;
    loanId: number;
    borrowerName: string | null;
    allocatedAmount: string;
    allocationDate: string;
    allocationType: string;
    note: string | null;
}

interface SettlementSummary {
    realizedSpread: string;
    unrealizedSpread: string;
    surplusBalance: string;
    deficitBalance: string;
    carryForwardAvailable: string;
    ownerSupportTotal?: string;
    poolCurrentBalance?: string;
}

interface SourceProfitability {
    borrowerCashCollected: string;
    borrowerRevenueCollected: string;
    fundCostPaid: string;
    realizedSpread: string;
    unrealizedSpread: string;
    deployedPrincipal: string;
    netCashPosition: string;
    realizedRoiPercent: string;
    carryForwardAvailable: string;
    opportunityCostAccrued?: string;
    economicSpread?: string;
    reconciliation: FundRevenueReconciliation;
}

interface FundRevenueReconciliation {
    contractAttributedRevenue: string;
    ledgerRecordedRevenue: string;
    difference: string;
    status: "matched" | "needs_reconciliation";
}

interface DrawdownProfitability {
    borrowerRevenueCollected: number;
    fundCostPaid: number;
    realizedSpread: number;
    unrealizedSpread: number;
    deployedPrincipal: number;
    netCashPosition: number;
    realizedRoiPercent: number;
    carryForwardAvailable: number;
    outstandingCost: number;
    surplusBalance: number;
    deficitBalance: number;
}

interface DrawdownAllocationState {
    bankLoanId: number;
    drawdownAmount: number;
    netAllocatedPrincipal: number;
    remainingCapacity: number;
    overallocatedAmount: number;
    state: string;
}

interface FundRolloverEntry {
    id: number;
    fromBankProfileId: number | null;
    toBankProfileId: number | null;
    fromBankLoanId: number | null;
    toBankLoanId: number | null;
    entryType: string;
    amount: string;
    effectiveDate: string;
    note: string | null;
}

interface FundingUsageAllocation {
    loanPublicId: string;
    borrowerPublicId: string | null;
    borrowerName: string | null;
    loanStatus: string;
    principalAmount: string;
    outstandingPrincipal: string;
    netAllocatedAmount: string;
    collectedInterest: string;
    latestAllocationDate: string;
    fundingRoutes: Array<{
        type: "direct" | "drawdown";
        bankLoanPublicId: string | null;
        netAllocatedAmount: string;
    }>;
}

interface FundingUsage {
    accountingMode: string;
    creditLimit: string;
    netAllocatedPrincipal: string;
    availableAmount: string;
    utilizationPercent: string;
    allocations: FundingUsageAllocation[];
}

export default function FundDetail() {
    const { t, i18n } = useTranslation();
    const navigate = useNavigate();
    const { id } = useParams();
    const [searchParams, setSearchParams] = useSearchParams();

    const [fund, setFund] = useState<BankProfile | null>(null);
    const [allFunds, setAllFunds] = useState<BankProfile[]>([]);
    const [bankLoans, setBankLoans] = useState<BankLoan[]>([]);
    const [selectedBankLoanId, setSelectedBankLoanId] = useState<number | null>(null);
    const [selectedSchedule, setSelectedSchedule] = useState<BankLoanSchedule[]>([]);
    const [selectedRepayments, setSelectedRepayments] = useState<BankLoanRepayment[]>([]);
    const [selectedAllocations, setSelectedAllocations] = useState<Allocation[]>([]);
    const [settlementSummary, setSettlementSummary] = useState<SettlementSummary | null>(null);
    const [sourceProfitability, setSourceProfitability] = useState<SourceProfitability | null>(null);
    const [fundingUsage, setFundingUsage] = useState<FundingUsage | null>(null);
    const [includeSettledFunding, setIncludeSettledFunding] = useState(false);

    const loanStatusPresentation = (status: string) => {
        if (status === "active") return {
            label: t("fundDetail.loanStatuses.active", "Active"),
            className: "border-emerald-200 bg-emerald-100 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300",
        };
        if (status === "paid" || status === "closed") return {
            label: t(`fundDetail.loanStatuses.${status}`, status),
            className: "border-slate-200 bg-slate-100 text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200",
        };
        if (status === "draft" || status === "pending") return {
            label: t(`fundDetail.loanStatuses.${status}`, status),
            className: "border-amber-200 bg-amber-100 text-amber-800 dark:border-amber-800 dark:bg-amber-950/60 dark:text-amber-300",
        };
        return {
            label: t("fundDetail.loanStatuses.problem", "Needs review"),
            className: "border-red-200 bg-red-100 text-red-800 dark:border-red-800 dark:bg-red-950/60 dark:text-red-300",
        };
    };
    const [rollovers, setRollovers] = useState<FundRolloverEntry[]>([]);
    const [selectedDrawdownProfitability, setSelectedDrawdownProfitability] = useState<DrawdownProfitability | null>(null);
    const [selectedDrawdownAllocationState, setSelectedDrawdownAllocationState] = useState<DrawdownAllocationState | null>(null);
    const [selectedScheduleId, setSelectedScheduleId] = useState<number | null>(null);
    const [hasAutoSelected, setHasAutoSelected] = useState(false);
    const [loading, setLoading] = useState(true);
    const [scheduleLoading, setScheduleLoading] = useState(false);
    const [createSubmitting, setCreateSubmitting] = useState(false);
    const [repaymentSubmitting, setRepaymentSubmitting] = useState(false);
    const [rolloverSubmitting, setRolloverSubmitting] = useState(false);
    const [errorMessage, setErrorMessage] = useState("");
    const [isAddingDrawdown, setIsAddingDrawdown] = useState(false);
    const [drawdownAmount, setDrawdownAmount] = useState("");
    const [drawdownInterestRate, setDrawdownInterestRate] = useState("");
    const [drawdownStartDate, setDrawdownStartDate] = useState("");
    const [drawdownTermMonths, setDrawdownTermMonths] = useState("12");
    const [drawdownRepaymentCycle, setDrawdownRepaymentCycle] = useState("monthly");
    const [drawdownInstallmentAmount, setDrawdownInstallmentAmount] = useState("");
    const [repaymentAmount, setRepaymentAmount] = useState("");
    const [repaymentDate, setRepaymentDate] = useState("");
    const [repaymentMethod, setRepaymentMethod] = useState("");
    const [repaymentReference, setRepaymentReference] = useState("");
    const [repaymentNote, setRepaymentNote] = useState("");
    const [rolloverTargetProfileId, setRolloverTargetProfileId] = useState("");
    const [rolloverAmount, setRolloverAmount] = useState("");
    const [rolloverDate, setRolloverDate] = useState(new Date().toISOString().slice(0, 10));
    const [rolloverType, setRolloverType] = useState("surplus_transfer");
    const [rolloverNote, setRolloverNote] = useState("");
    const [capitalModeSubmitting, setCapitalModeSubmitting] = useState(false);
    const targetBankLoanId = searchParams.get("bankLoanId");
    const targetScheduleId = searchParams.get("scheduleId");

    const loadFund = async (fundId: string) => {
        const [fundRes, loansRes, profilesRes, settlementRes, profitabilityRes, rolloversRes, usageRes] = await Promise.all([
            api.get(`/bank-profiles/${fundId}`),
            api.get("/bank-loans", { params: { bankProfileId: fundId } }),
            api.get("/bank-profiles"),
            api.get(`/bank-profiles/${fundId}/settlement-summary`),
            api.get(`/bank-profiles/${fundId}/profitability`),
            api.get("/fund-rollovers", { params: { bankProfileId: fundId } }),
            api.get(`/bank-profiles/${fundId}/funding-usage`),
        ]);

        setFund(fundRes.data ?? null);
        setBankLoans(loansRes.data ?? []);
        setAllFunds(profilesRes.data ?? []);
        setSettlementSummary(settlementRes.data ?? null);
        setSourceProfitability(profitabilityRes.data ?? null);
        setRollovers(rolloversRes.data ?? []);
        setFundingUsage(usageRes.data ?? null);
    };

    const loadFundingUsage = async (fundId: string, includeSettled: boolean) => {
        const response = await api.get(`/bank-profiles/${fundId}/funding-usage`, {
            params: includeSettled ? { includeSettled: "true" } : undefined,
        });
        setFundingUsage(response.data ?? null);
    };

    useEffect(() => {
        const run = async () => {
            if (!id) {
                setErrorMessage(t("fundDetail.errors.notFound", "Funding source not found."));
                setLoading(false);
                return;
            }

            try {
                await loadFund(id);
                setErrorMessage("");
            } catch (error) {
                console.error("Failed to load fund details", error);
                setErrorMessage(t("fundDetail.errors.loadFund", "Unable to load the funding source right now."));
            } finally {
                setLoading(false);
            }
        };

        run();
    }, [id]);

    useEffect(() => {
        setHasAutoSelected(false);
    }, [targetBankLoanId, targetScheduleId]);

    useEffect(() => {
        if (!bankLoans.length || !targetBankLoanId || hasAutoSelected) {
            return;
        }

        const bankLoanId = Number(targetBankLoanId);
        if (!Number.isFinite(bankLoanId)) {
            return;
        }

        if (selectedBankLoanId === bankLoanId) {
            setHasAutoSelected(true);
            return;
        }

        if (!bankLoans.some((loan) => loan.id === bankLoanId)) {
            return;
        }

        setHasAutoSelected(true);
        loadSchedule(bankLoanId);
    }, [bankLoans, targetBankLoanId, targetScheduleId, selectedBankLoanId, hasAutoSelected]);

    const loadSchedule = async (bankLoanId: number) => {
        try {
            setScheduleLoading(true);
            const [scheduleRes, repaymentsRes, allocationsRes, profitabilityRes, allocationStateRes] = await Promise.all([
                api.get(`/bank-loans/${bankLoanId}/schedule`),
                api.get(`/bank-loans/${bankLoanId}/repayments`),
                api.get(`/bank-loans/${bankLoanId}/allocations`),
                api.get(`/bank-loans/${bankLoanId}/profitability`),
                api.get(`/bank-loans/${bankLoanId}/allocation-state`),
            ]);
            const scheduleRows = scheduleRes.data ?? [];
            setSelectedBankLoanId(bankLoanId);
            setSelectedSchedule(scheduleRows);
            setSelectedRepayments(repaymentsRes.data ?? []);
            setSelectedAllocations(allocationsRes.data ?? []);
            setSelectedDrawdownProfitability(profitabilityRes.data ?? null);
            setSelectedDrawdownAllocationState(allocationStateRes.data ?? null);
            if (targetScheduleId) {
                const matchedSchedule = scheduleRows.find((item: BankLoanSchedule) => item.id === Number(targetScheduleId));
                if (matchedSchedule) {
                    setSelectedScheduleId(matchedSchedule.id);
                    setRepaymentAmount(matchedSchedule.totalDueNow ?? matchedSchedule.remainingDue);
                    setRepaymentDate(new Date().toISOString().slice(0, 10));
                    setRepaymentMethod("");
                    setRepaymentReference("");
                    setRepaymentNote("");
                } else {
                    setSelectedScheduleId(null);
                    setRepaymentAmount("");
                }
            } else {
                setSelectedScheduleId(null);
                setRepaymentAmount("");
            }
        } catch (error) {
            console.error("Failed to load bank loan schedule", error);
            setErrorMessage(t("fundDetail.errors.loadDrawdownSchedule", "Unable to load the drawdown schedule right now."));
        } finally {
            setScheduleLoading(false);
        }
    };

    const refreshDrawdownData = async (bankLoanId: number, fundId: number) => {
        const [loansRes, scheduleRes, repaymentsRes, allocationsRes, settlementRes, sourceProfitabilityRes, drawdownProfitabilityRes, drawdownAllocationStateRes, rolloversRes] = await Promise.all([
            api.get("/bank-loans", { params: { bankProfileId: fundId } }),
            api.get(`/bank-loans/${bankLoanId}/schedule`),
            api.get(`/bank-loans/${bankLoanId}/repayments`),
            api.get(`/bank-loans/${bankLoanId}/allocations`),
            api.get(`/bank-profiles/${fundId}/settlement-summary`),
            api.get(`/bank-profiles/${fundId}/profitability`),
            api.get(`/bank-loans/${bankLoanId}/profitability`),
            api.get(`/bank-loans/${bankLoanId}/allocation-state`),
            api.get("/fund-rollovers", { params: { bankProfileId: fundId } }),
        ]);

        setBankLoans(loansRes.data ?? []);
        setSelectedSchedule(scheduleRes.data ?? []);
        setSelectedRepayments(repaymentsRes.data ?? []);
        setSelectedAllocations(allocationsRes.data ?? []);
        setSettlementSummary(settlementRes.data ?? null);
        setSourceProfitability(sourceProfitabilityRes.data ?? null);
        setSelectedDrawdownProfitability(drawdownProfitabilityRes.data ?? null);
        setSelectedDrawdownAllocationState(drawdownAllocationStateRes.data ?? null);
        setRollovers(rolloversRes.data ?? []);
    };

    const resetDrawdownForm = () => {
        setIsAddingDrawdown(false);
        setDrawdownAmount("");
        setDrawdownInterestRate("");
        setDrawdownStartDate("");
        setDrawdownTermMonths("12");
        setDrawdownRepaymentCycle("monthly");
        setDrawdownInstallmentAmount("");
    };

    const handleCreateDrawdown = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (!fund) return;
        if (!drawdownAmount || !drawdownInterestRate || !drawdownStartDate) {
            setErrorMessage(t("fundDetail.errors.completeDrawdown", "Please complete amount, interest rate, and start date before saving the drawdown."));
            return;
        }

        try {
            setCreateSubmitting(true);
            setErrorMessage("");

            await api.post("/bank-loans", {
                bankProfileId: fund.id,
                amount: Number(drawdownAmount),
                interestRate: Number(drawdownInterestRate),
                startDate: drawdownStartDate,
                termMonths: Number(drawdownTermMonths || 12),
                repaymentCycle: drawdownRepaymentCycle,
                repaymentMode: "fixed_installment",
                installmentAmount: drawdownInstallmentAmount ? Number(drawdownInstallmentAmount) : undefined,
            });

            await loadFund(fund.publicId ?? id ?? String(fund.id));
            resetDrawdownForm();
        } catch (error) {
            console.error("Failed to create drawdown", error);
            setErrorMessage(t("fundDetail.errors.createDrawdown", "Unable to create the drawdown right now."));
        } finally {
            setCreateSubmitting(false);
        }
    };

    const handleSelectScheduleForRepayment = (item: BankLoanSchedule) => {
        setSelectedScheduleId(item.id);
        setRepaymentAmount(item.totalDueNow ?? item.remainingDue);
        setRepaymentDate(new Date().toISOString().slice(0, 10));
        setRepaymentMethod("");
        setRepaymentReference("");
        setRepaymentNote("");
        setSearchParams((current) => {
            const next = new URLSearchParams(current);
            if (selectedBankLoanId) {
                next.set("bankLoanId", String(selectedBankLoanId));
            }
            next.set("scheduleId", String(item.id));
            return next;
        }, { replace: true });
    };

    const handleRecordRepayment = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();

        if (!fund || !selectedBankLoanId || !selectedScheduleId) {
            setErrorMessage(t("fundDetail.errors.selectScheduleFirst", "Please select a schedule row before recording a repayment."));
            return;
        }

        if (!repaymentAmount || Number(repaymentAmount) <= 0) {
            setErrorMessage(t("fundDetail.errors.enterRepaymentAmount", "Please enter a repayment amount greater than zero."));
            return;
        }

        try {
            setRepaymentSubmitting(true);
            setErrorMessage("");

            await api.post(`/bank-loans/${selectedBankLoanId}/repayments`, {
                scheduleId: selectedScheduleId,
                amount: Number(repaymentAmount),
                paymentDate: repaymentDate || undefined,
                paymentMethod: repaymentMethod || undefined,
                reference: repaymentReference || undefined,
                note: repaymentNote || undefined,
            });

            await refreshDrawdownData(selectedBankLoanId, fund.id);
            setSelectedScheduleId(null);
            setRepaymentAmount("");
            setRepaymentDate("");
            setRepaymentMethod("");
            setRepaymentReference("");
            setRepaymentNote("");
            setSearchParams((current) => {
                const next = new URLSearchParams(current);
                next.delete("scheduleId");
                return next;
            }, { replace: true });
        } catch (error) {
            console.error("Failed to record repayment", error);
            setErrorMessage(t("fundDetail.errors.recordRepayment", "Unable to record the repayment right now."));
        } finally {
            setRepaymentSubmitting(false);
        }
    };

    const handleCreateRollover = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (!fund) return;
        if (!rolloverAmount || Number(rolloverAmount) <= 0) {
            setErrorMessage(t("fundDetail.errors.enterRolloverAmount", "Please enter a rollover amount greater than zero."));
            return;
        }

        try {
            setRolloverSubmitting(true);
            setErrorMessage("");

            await api.post("/fund-rollovers", {
                fromBankProfileId: fund.id,
                toBankProfileId: rolloverTargetProfileId ? Number(rolloverTargetProfileId) : undefined,
                entryType: rolloverType,
                amount: Number(rolloverAmount),
                effectiveDate: rolloverDate,
                note: rolloverNote || undefined,
            });

            await loadFund(fund.publicId ?? id ?? String(fund.id));
            setRolloverTargetProfileId("");
            setRolloverAmount("");
            setRolloverType("surplus_transfer");
            setRolloverNote("");
        } catch (error: any) {
            console.error("Failed to create rollover", error);
            setErrorMessage(error?.response?.data?.error || t("fundDetail.errors.saveRollover", "Unable to save the rollover entry right now."));
        } finally {
            setRolloverSubmitting(false);
        }
    };

    const fundLimit = fundingUsage?.creditLimit ?? fund?.creditLimit ?? "0.00";
    const availableAmount = fundingUsage?.availableAmount ?? "0.00";
    const allocatedAmount = fundingUsage?.netAllocatedPrincipal ?? "0.00";
    const utilizationRate = Number(fundingUsage?.utilizationPercent ?? "0.00");
    const rolloverTargets = useMemo(
        () => allFunds.filter((item) => item.id !== fund?.id),
        [allFunds, fund?.id]
    );

    const enableOwnCapital = async () => {
        if (!fund || !id) return;
        try {
            setCapitalModeSubmitting(true);
            setErrorMessage("");
            await api.put(`/bank-profiles/${id}`, {
                name: fund.name,
                type: fund.type,
                creditLimit: fund.creditLimit ?? "0.00",
                providerName: fund.providerName ?? undefined,
                referenceNo: fund.referenceNo ?? undefined,
                accountingMode: "capital_pool",
                reinvestProfitMode: fund.reinvestProfitMode ?? "manual_distribution",
                opportunityCostRate: fund.opportunityCostRate ?? "2.00",
                note: fund.note ?? undefined,
                status: fund.status ?? "active",
            });
            await loadFund(id);
        } catch (error) {
            console.error("Failed to enable own capital", error);
            setErrorMessage(t("fundDetail.errors.enableOwnCapital", "Unable to enable this source as own capital."));
        } finally {
            setCapitalModeSubmitting(false);
        }
    };

    return (
        <div className="space-y-6">
            <div className="flex items-center gap-4">
                <Button variant="ghost" size="icon" onClick={() => navigate("/funds")}>
                    <ArrowLeft className="h-4 w-4" />
                </Button>
                <div>
                    <h2 className="text-2xl font-bold tracking-tight">
                        {loading ? t("common.loading", "Loading...") : fund?.name ?? t("fundDetail.fundingSource", "Funding Source")}
                    </h2>
                    <p className="text-muted-foreground">
                        {fund?.type === "bank" ? t("fund_detail.revolving_credit") : t("funds.capital")}
                    </p>
                </div>
                {fund?.type === "personal" && fund.accountingMode !== "capital_pool" && (
                    <Button type="button" variant="outline" className="ml-auto" onClick={enableOwnCapital} disabled={capitalModeSubmitting}>
                        {capitalModeSubmitting
                            ? t("common.saving", "Saving...")
                            : t("fundDetail.enableOwnCapital", "Use as own capital (2% p.a.)")}
                    </Button>
                )}
            </div>

            {errorMessage && (
                <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                    {errorMessage}
                </div>
            )}

            {loading ? (
                <div>{t("common.loading")}</div>
            ) : !fund ? (
                <Card>
                    <CardContent className="py-10 text-center text-muted-foreground">
                        {t("fundDetail.missing", "This funding source does not exist anymore.")}
                    </CardContent>
                </Card>
            ) : (
                <>
                    <div data-testid="funding-summary-grid" className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
                        <Card>
                            <CardHeader className="pb-2">
                                <CardTitle className="text-sm font-medium text-muted-foreground">
                                    {fund.accountingMode === "capital_pool"
                                        ? t("fundDetail.availableOwnCapital", "Available own capital")
                                        : t("fund_detail.available_credit", "Available Credit")}
                                </CardTitle>
                            </CardHeader>
                            <CardContent>
                                <div className="flex min-w-0 items-center gap-3">
                                    <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary">
                                        {fund.type === "bank" ? <Building2 className="h-5 w-5" /> : <Wallet className="h-5 w-5" />}
                                    </div>
                                    <div data-testid="funding-available-amount" className="min-w-0 text-2xl font-bold tabular-nums sm:text-3xl">{formatMoneyExact(availableAmount, i18n.language)}</div>
                                </div>
                                <div className="mt-3 text-xs text-muted-foreground">
                                    {t("funds.limit")}: {formatMoneyExact(fundLimit, i18n.language)}
                                </div>
                                <div className="mt-1 text-xs text-muted-foreground">
                                    {t("fundDetail.allocatedToLoans", "Allocated to borrower loans")}: {formatMoneyExact(allocatedAmount, i18n.language)}
                                </div>
                                <div className="mt-3 h-2 w-full rounded-full bg-muted">
                                    <div className="h-2 rounded-full bg-primary" style={{ width: `${Math.min(utilizationRate, 100)}%` }} />
                                </div>
                                <p className="mt-1 text-xs text-right text-muted-foreground">
                                    {utilizationRate.toFixed(0)}% {t("fund_detail.utilization")}
                                </p>
                            </CardContent>
                        </Card>

                        <Card>
                            <CardHeader className="pb-2">
                                <CardTitle className="text-sm font-medium text-muted-foreground">{t("fundDetail.settlementPosition", "Settlement Position")}</CardTitle>
                            </CardHeader>
                            <CardContent className="space-y-2 text-sm">
                                <div className="flex justify-between">
                                    <span>{t("funds.metrics.realizedSpread", "Realized spread")}</span>
                                    <span className="font-medium">{formatMoneyExact(settlementSummary?.realizedSpread ?? "0.00", i18n.language)}</span>
                                </div>
                                <div className="flex justify-between">
                                    <span>{t("loans.unrealizedSpread", "Unrealized spread")}</span>
                                    <span className="font-medium">{formatMoneyExact(settlementSummary?.unrealizedSpread ?? "0.00", i18n.language)}</span>
                                </div>
                                <div className="flex justify-between">
                                    <span>{t("fundDetail.surplusBalance", "Surplus balance")}</span>
                                    <span className="font-medium text-emerald-600">{formatMoneyExact(settlementSummary?.surplusBalance ?? "0.00", i18n.language)}</span>
                                </div>
                                <div className="flex justify-between">
                                    <span>{t("fundDetail.deficitBalance", "Deficit balance")}</span>
                                    <span className="font-medium text-destructive">{formatMoneyExact(settlementSummary?.deficitBalance ?? "0.00", i18n.language)}</span>
                                </div>
                            </CardContent>
                        </Card>

                        <Card>
                            <CardHeader className="pb-2">
                                <CardTitle className="text-sm font-medium text-muted-foreground">{t("fundDetail.sourceProfitability", "Source Profitability")}</CardTitle>
                            </CardHeader>
                            <CardContent className="space-y-2 text-sm">
                                <div className="flex justify-between">
                                    <span>{t("dashboardPage.cards.borrowerRevenue", "Revenue collected")}</span>
                                    <span className="font-medium">{formatMoneyExact(sourceProfitability?.borrowerCashCollected ?? "0.00", i18n.language)}</span>
                                </div>
                                <div className="flex justify-between">
                                    <span>{t("dashboardPage.cards.fundCostPaid", "Fund cost paid")}</span>
                                    <span className="font-medium">{formatMoneyExact(sourceProfitability?.fundCostPaid ?? "0.00", i18n.language)}</span>
                                </div>
                                <div className="flex justify-between">
                                    <span>{t("funds.metrics.deployed", "Deployed principal")}</span>
                                    <span className="font-medium">{formatMoneyExact(sourceProfitability?.deployedPrincipal ?? "0.00", i18n.language)}</span>
                                </div>
                                <div className="flex justify-between">
                                    <span>{t("funds.metrics.netCash", "Net cash position")}</span>
                                    <span className={`font-medium ${new Decimal(sourceProfitability?.netCashPosition ?? 0).gte(0) ? "text-emerald-600" : "text-destructive"}`}>
                                        {formatMoneyExact(sourceProfitability?.netCashPosition ?? "0.00", i18n.language)}
                                    </span>
                                </div>
                                <div className="flex justify-between">
                                    <span>{t("fundDetail.realizedRoi", "Realized ROI")}</span>
                                    <span className="font-medium">{new Decimal(sourceProfitability?.realizedRoiPercent ?? 0).toFixed(2)}%</span>
                                </div>
                                {fund.accountingMode === "capital_pool" && (
                                    <>
                                        <div className="flex justify-between">
                                            <span>{t("fundDetail.opportunityCost", "Opportunity cost (non-cash)")}</span>
                                            <span className="font-medium">{formatMoneyExact(sourceProfitability?.opportunityCostAccrued ?? "0.00", i18n.language)}</span>
                                        </div>
                                        <div className="flex justify-between">
                                            <span>{t("fundDetail.economicSpread", "Economic spread")}</span>
                                            <span className="font-medium">{formatMoneyExact(sourceProfitability?.economicSpread ?? "0.00", i18n.language)}</span>
                                        </div>
                                    </>
                                )}
                            </CardContent>
                        </Card>
                    </div>

                    {sourceProfitability?.reconciliation && (
                        <Card>
                            <CardHeader className="pb-2">
                                <div className="flex flex-wrap items-center justify-between gap-3">
                                    <div>
                                        <CardTitle>{t("fundDetail.reconciliation.title", "Data reconciliation")}</CardTitle>
                                        <p className="text-sm text-muted-foreground">{t("fundDetail.reconciliation.description", "Comparison between contract-attributed revenue and the append-only source ledger.")}</p>
                                    </div>
                                    <Badge variant="outline" className={sourceProfitability.reconciliation.status === "matched"
                                        ? "border-emerald-200 bg-emerald-100 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
                                        : "border-amber-200 bg-amber-100 text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"}>
                                        {sourceProfitability.reconciliation.status === "matched"
                                            ? t("fundDetail.reconciliation.matched", "Matched")
                                            : t("fundDetail.reconciliation.needsReconciliation", "Needs reconciliation")}
                                    </Badge>
                                </div>
                            </CardHeader>
                            <CardContent>
                                <dl className="grid gap-4 text-sm sm:grid-cols-3">
                                    <div><dt className="text-muted-foreground">{t("fundDetail.reconciliation.contractRevenue", "Contract-attributed revenue")}</dt><dd className="mt-1 font-semibold tabular-nums">{formatMoneyExact(sourceProfitability.reconciliation.contractAttributedRevenue, i18n.language)}</dd></div>
                                    <div><dt className="text-muted-foreground">{t("fundDetail.reconciliation.ledgerRevenue", "Ledger-recorded revenue")}</dt><dd className="mt-1 font-semibold tabular-nums">{formatMoneyExact(sourceProfitability.reconciliation.ledgerRecordedRevenue, i18n.language)}</dd></div>
                                    <div><dt className="text-muted-foreground">{t("fundDetail.reconciliation.difference", "Difference")}</dt><dd className={`mt-1 font-semibold tabular-nums ${new Decimal(sourceProfitability.reconciliation.difference).isZero() ? "text-emerald-700 dark:text-emerald-300" : "text-amber-700 dark:text-amber-300"}`}>{formatMoneyExact(sourceProfitability.reconciliation.difference, i18n.language)}</dd></div>
                                </dl>
                                <p className="mt-4 text-xs text-muted-foreground">{t("fundDetail.reconciliation.readOnlyNote", "This status does not alter financial records.")}</p>
                            </CardContent>
                        </Card>
                    )}

                    <Card>
                        <CardHeader className="pb-2">
                            <div className="flex flex-wrap items-center justify-between gap-3">
                                <div>
                                    <CardTitle>{t("fundDetail.fundingUsageTitle", "Loans using this funding source")}</CardTitle>
                                    <p className="text-sm text-muted-foreground">{t("fundDetail.fundingUsageDescription", "Net funding allocated to each borrower loan.")}</p>
                                </div>
                                <label className="flex items-center gap-2 text-sm">
                                    <input
                                        type="checkbox"
                                        checked={includeSettledFunding}
                                        onChange={(event) => {
                                            const next = event.target.checked;
                                            setIncludeSettledFunding(next);
                                            if (id) void loadFundingUsage(id, next);
                                        }}
                                    />
                                    {t("fundDetail.includeSettledLoans", "Include settled loans")}
                                </label>
                            </div>
                        </CardHeader>
                        <CardContent>
                            {!fundingUsage ? (
                                <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">{t("common.loading", "Loading...")}</div>
                            ) : fundingUsage.allocations.length === 0 ? (
                                <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">{t("fundDetail.noFundingUsage", "No borrower loans are currently allocated from this funding source.")}</div>
                            ) : (
                                <div data-testid="funding-usage-list" className="divide-y">
                                    {fundingUsage.allocations.map((allocation) => {
                                        const routes = allocation.fundingRoutes;
                                        const routeLabel = routes.length !== 1
                                            ? t("fundDetail.multipleFundingRoutes", "Multiple funding routes")
                                            : routes[0]?.type === "direct"
                                                ? t("fundDetail.directAllocation", "Direct own-capital allocation")
                                                : t("fundDetail.drawdownAllocation", { defaultValue: "Drawdown {{id}}", id: routes[0]?.bankLoanPublicId ?? "-" });
                                        const status = loanStatusPresentation(allocation.loanStatus);
                                        return <Link
                                            key={allocation.loanPublicId}
                                            to={`/loans/${allocation.loanPublicId}`}
                                            className="block px-1 py-5 transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:px-3"
                                        >
                                            <div className="flex min-w-0 items-start justify-between gap-3">
                                                <div className="min-w-0">
                                                    <div className="truncate font-semibold">{allocation.borrowerName ?? "-"}</div>
                                                    <div className="mt-1 truncate font-mono text-xs text-muted-foreground" title={allocation.loanPublicId}>{allocation.loanPublicId}</div>
                                                </div>
                                                <Badge variant="outline" className={`shrink-0 ${status.className}`}>{status.label}</Badge>
                                            </div>
                                            <div className="mt-3 text-sm">
                                                <span className="text-muted-foreground">{t("fundDetail.fundingRoute", "Funding route")}: </span>
                                                <span className="font-medium">{routeLabel}</span>
                                            </div>
                                            <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-sm lg:grid-cols-4">
                                                <div><dt className="text-muted-foreground">{t("fundDetail.netAllocated", "Net allocated")}</dt><dd className="mt-1 font-semibold tabular-nums">{formatMoneyExact(allocation.netAllocatedAmount, i18n.language)}</dd></div>
                                                <div><dt className="text-muted-foreground">{t("loanWizard.outstandingPrincipal", "Outstanding principal")}</dt><dd className="mt-1 font-semibold tabular-nums">{formatMoneyExact(allocation.outstandingPrincipal, i18n.language)}</dd></div>
                                                <div><dt className="text-muted-foreground">{t("fundDetail.collectedInterestForSource", "Interest collected for this funding source")}</dt><dd className="mt-1 font-semibold tabular-nums text-emerald-700 dark:text-emerald-300">{formatMoneyExact(allocation.collectedInterest, i18n.language)}</dd></div>
                                                <div><dt className="text-muted-foreground">{t("fundDetail.latestAllocation", "Latest allocation")}</dt><dd className="mt-1 font-medium">{allocation.latestAllocationDate}</dd></div>
                                            </dl>
                                        </Link>;
                                    })}
                                </div>
                            )}
                        </CardContent>
                    </Card>

                    <div className="grid gap-4 xl:grid-cols-[1.5fr_1fr]">
                        {fund.accountingMode === "capital_pool" ? (
                            <Card>
                                <CardHeader className="pb-2"><CardTitle className="text-sm font-medium">{t("fundDetail.directCapitalTitle", "Direct own-capital allocation")}</CardTitle></CardHeader>
                                <CardContent><p className="text-sm text-muted-foreground">{t("fundDetail.directCapitalDescription", "Own capital is allocated directly to borrower loans and does not create a bank drawdown.")}</p></CardContent>
                            </Card>
                        ) : (
                        <Card>
                            <CardHeader className="pb-2">
                                <div className="flex items-center justify-between gap-4">
                                    <CardTitle className="text-sm font-medium">{t("fund_detail.active_withdrawals")}</CardTitle>
                                    <div className="flex items-center gap-2">
                                        <Link to="/matching">
                                            <Button type="button" size="sm" variant="outline">{t("dashboardPage.actions.openMatching", "Open Matching")}</Button>
                                        </Link>
                                        <Button
                                            type="button"
                                            size="sm"
                                            onClick={() => {
                                                setIsAddingDrawdown((value) => !value);
                                                setErrorMessage("");
                                            }}
                                        >
                                            {t("fundDetail.addDrawdown", "Add Drawdown")}
                                        </Button>
                                    </div>
                                </div>
                            </CardHeader>
                            <CardContent>
                                {isAddingDrawdown && (
                                    <form className="mb-6 grid gap-4 rounded-lg border border-dashed p-4 md:grid-cols-2" onSubmit={handleCreateDrawdown}>
                                        <div className="grid gap-1.5">
                                            <label className="text-sm font-medium">{t("transactionsForm.amount", "Amount")}</label>
                                            <Input type="number" value={drawdownAmount} onChange={(e) => setDrawdownAmount(e.target.value)} />
                                        </div>
                                        <div className="grid gap-1.5">
                                            <label className="text-sm font-medium">{t("loanWizard.interestRate", "Interest Rate (%)")}</label>
                                            <Input type="number" value={drawdownInterestRate} onChange={(e) => setDrawdownInterestRate(e.target.value)} />
                                        </div>
                                        <div className="grid gap-1.5">
                                            <label className="text-sm font-medium">{t("loanWizard.startDate", "Start Date")}</label>
                                            <Input type="date" value={drawdownStartDate} onChange={(e) => setDrawdownStartDate(e.target.value)} />
                                        </div>
                                        <div className="grid gap-1.5">
                                            <label className="text-sm font-medium">{t("loanWizard.termMonths", "Term (Months)")}</label>
                                            <Input type="number" value={drawdownTermMonths} onChange={(e) => setDrawdownTermMonths(e.target.value)} />
                                        </div>
                                        <div className="grid gap-1.5">
                                            <label className="text-sm font-medium">{t("fundDetail.repaymentCycle", "Repayment Cycle")}</label>
                                            <select className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={drawdownRepaymentCycle} onChange={(e) => setDrawdownRepaymentCycle(e.target.value)}>
                                                <option value="monthly">{t("loanWizard.repaymentOptions.monthly", "Monthly")}</option>
                                                <option value="weekly">{t("loanWizard.repaymentOptions.weekly", "Weekly")}</option>
                                                <option value="daily">{t("loanWizard.repaymentOptions.daily", "Daily")}</option>
                                            </select>
                                        </div>
                                        <div className="grid gap-1.5">
                                            <label className="text-sm font-medium">{t("fundDetail.fixedInstallmentOverride", "Fixed Installment Override")}</label>
                                            <Input type="number" placeholder={t("borrowerForm.optional", "Optional")} value={drawdownInstallmentAmount} onChange={(e) => setDrawdownInstallmentAmount(e.target.value)} />
                                        </div>
                                        <div className="flex items-end gap-2 md:col-span-2">
                                            <Button type="submit" disabled={createSubmitting}>{createSubmitting ? t("common.saving", "Saving...") : t("fundDetail.saveDrawdown", "Save Drawdown")}</Button>
                                            <Button type="button" variant="outline" onClick={resetDrawdownForm} disabled={createSubmitting}>{t("common.cancel", "Cancel")}</Button>
                                        </div>
                                    </form>
                                )}

                                {bankLoans.length === 0 ? (
                                    <div className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
                                        {t("fundDetail.noDrawdowns", "No bank loan withdrawals have been recorded for this funding source yet.")}
                                    </div>
                                ) : (
                                    <div className="space-y-4">
                                        {bankLoans.map((loan) => (
                                            <button key={loan.id} type="button" className="flex w-full items-center justify-between border-b pb-2 text-left last:border-0 last:pb-0" onClick={() => loadSchedule(loan.id)}>
                                                <div className="space-y-1">
                                                    <div className="font-semibold">{t("fundDetail.withdrawalLabel", { defaultValue: "Withdrawal #{{id}}", id: loan.id })}</div>
                                                    <div className="text-xs text-muted-foreground">
                                                        {loan.startDate || t("fundDetail.noStartDate", "No start date")} • {loan.repaymentCycle || t("loanWizard.repaymentOptions.monthly", "monthly")} • {t("fundDetail.termLabel", "Term")}: {loan.termMonths ?? 0} {t("fundDetail.months", "Months")}
                                                    </div>
                                                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                                        <CalendarDays className="h-3.5 w-3.5" />
                                                        {t("loanWizard.nextDue", "Next due")}: {loan.nextDueDate || t("fundDetail.notScheduled", "Not scheduled")}
                                                    </div>
                                                </div>
                                                <div className="text-right">
                                                    <div className="font-bold">฿{Number(loan.amount).toLocaleString(i18n.language)}</div>
                                                    <div className="text-xs text-muted-foreground">
                                                        {t("fundDetail.installment", "Installment")}: ฿{Number(loan.installmentAmount ?? 0).toLocaleString(i18n.language)}
                                                    </div>
                                                    <div className="text-xs text-muted-foreground">
                                                        {t("loanWizard.outstandingPrincipal", "Outstanding principal")}: ฿{Number(loan.outstandingPrincipal ?? 0).toLocaleString(i18n.language)}
                                                    </div>
                                                </div>
                                            </button>
                                        ))}
                                    </div>
                                )}
                            </CardContent>
                        </Card>
                        )}

                        <Card>
                            <CardHeader className="pb-2">
                                <CardTitle className="text-sm font-medium flex items-center gap-2">
                                    <ArrowRightLeft className="h-4 w-4" />
                                    {t("fundDetail.rolloverCarryForward", "Rollover / Carry-forward")}
                                </CardTitle>
                            </CardHeader>
                            <CardContent className="space-y-4">
                                <form className="space-y-3" onSubmit={handleCreateRollover}>
                                    <div className="grid gap-1.5">
                                        <label className="text-sm font-medium">{t("fundDetail.entryType", "Entry Type")}</label>
                                        <select className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={rolloverType} onChange={(e) => setRolloverType(e.target.value)}>
                                            <option value="surplus_transfer">{t("fundDetail.rolloverTypes.surplusTransfer", "Surplus transfer")}</option>
                                            <option value="deficit_support">{t("fundDetail.rolloverTypes.deficitSupport", "Deficit support")}</option>
                                            <option value="capitalization">{t("fundDetail.rolloverTypes.capitalization", "Capitalization")}</option>
                                            <option value="manual_adjustment">{t("fundDetail.rolloverTypes.manualAdjustment", "Manual adjustment")}</option>
                                        </select>
                                    </div>
                                    <div className="grid gap-1.5">
                                        <label className="text-sm font-medium">{t("fundDetail.targetFund", "Target Fund")}</label>
                                        <select className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={rolloverTargetProfileId} onChange={(e) => setRolloverTargetProfileId(e.target.value)}>
                                            <option value="">{t("fundDetail.noDestination", "No destination / same source")}</option>
                                            {rolloverTargets.map((item) => (
                                                <option key={item.id} value={item.id}>{item.name}</option>
                                            ))}
                                        </select>
                                    </div>
                                    <div className="grid gap-1.5">
                                        <label className="text-sm font-medium">{t("transactionsForm.amount", "Amount")}</label>
                                        <Input type="number" value={rolloverAmount} onChange={(e) => setRolloverAmount(e.target.value)} />
                                    </div>
                                    <div className="grid gap-1.5">
                                        <label className="text-sm font-medium">{t("fundDetail.effectiveDate", "Effective Date")}</label>
                                        <Input type="date" value={rolloverDate} onChange={(e) => setRolloverDate(e.target.value)} />
                                    </div>
                                    <div className="grid gap-1.5">
                                        <label className="text-sm font-medium">{t("transactionsForm.note", "Note")}</label>
                                        <Input value={rolloverNote} onChange={(e) => setRolloverNote(e.target.value)} />
                                    </div>
                                    <Button type="submit" className="w-full" disabled={rolloverSubmitting}>
                                        {rolloverSubmitting ? t("common.saving", "Saving...") : t("fundDetail.saveRollover", "Save Rollover")}
                                    </Button>
                                </form>

                                <div className="space-y-2">
                                    <div className="text-sm font-medium">{t("common.history", "History")}</div>
                                    {rollovers.length === 0 ? (
                                        <div className="rounded border border-dashed p-3 text-sm text-muted-foreground">
                                            {t("fundDetail.noCarryForwardEntries", "No carry-forward entries yet.")}
                                        </div>
                                    ) : (
                                        <div className="space-y-2">
                                            {rollovers.slice(0, 5).map((item) => (
                                                <div key={item.id} className="rounded border p-3 text-sm">
                                                    <div className="flex items-center justify-between gap-3">
                                                        <span className="font-medium">{t(`fundDetail.rolloverTypes.${item.entryType === "surplus_transfer" ? "surplusTransfer" : item.entryType === "deficit_support" ? "deficitSupport" : item.entryType === "capitalization" ? "capitalization" : "manualAdjustment"}`)}</span>
                                                        <span>฿{Number(item.amount).toLocaleString(i18n.language)}</span>
                                                    </div>
                                                    <div className="text-xs text-muted-foreground">{item.effectiveDate}</div>
                                                    {item.note && <div className="mt-1 text-xs text-muted-foreground">{item.note}</div>}
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            </CardContent>
                        </Card>
                    </div>

                    {selectedBankLoanId && (
                        <div className="grid gap-4 xl:grid-cols-[1.3fr_0.9fr_0.8fr]">
                            <Card className="xl:col-span-3">
                                <CardHeader>
                                    <CardTitle>{t("fundDetail.selectedDrawdownPosition", "Selected Drawdown Position")}</CardTitle>
                                </CardHeader>
                                <CardContent className="grid gap-4 md:grid-cols-4 xl:grid-cols-6">
                                    <div>
                                        <div className="text-xs text-muted-foreground">{t("matching.allocationState", "Allocation state")}</div>
                                        <div className="font-medium capitalize">{selectedDrawdownAllocationState?.state?.replaceAll("_", " ") || "-"}</div>
                                    </div>
                                    <div>
                                        <div className="text-xs text-muted-foreground">{t("loanDetail.allocatedPrincipal", "Allocated principal")}</div>
                                        <div className="font-medium">฿{Number(selectedDrawdownAllocationState?.netAllocatedPrincipal ?? 0).toLocaleString(i18n.language)}</div>
                                    </div>
                                    <div>
                                        <div className="text-xs text-muted-foreground">{t("fundDetail.remainingCapacity", "Remaining capacity")}</div>
                                        <div className="font-medium">฿{Number(selectedDrawdownAllocationState?.remainingCapacity ?? 0).toLocaleString(i18n.language)}</div>
                                    </div>
                                    <div>
                                        <div className="text-xs text-muted-foreground">{t("dashboardPage.cards.borrowerRevenue", "Revenue collected")}</div>
                                        <div className="font-medium">฿{Number(selectedDrawdownProfitability?.borrowerRevenueCollected ?? 0).toLocaleString(i18n.language)}</div>
                                    </div>
                                    <div>
                                        <div className="text-xs text-muted-foreground">{t("dashboardPage.cards.fundCostPaid", "Fund cost paid")}</div>
                                        <div className="font-medium">฿{Number(selectedDrawdownProfitability?.fundCostPaid ?? 0).toLocaleString(i18n.language)}</div>
                                    </div>
                                    <div>
                                        <div className="text-xs text-muted-foreground">{t("funds.metrics.realizedSpread", "Realized spread")}</div>
                                        <div className={`font-medium ${Number(selectedDrawdownProfitability?.realizedSpread ?? 0) >= 0 ? "text-emerald-600" : "text-destructive"}`}>
                                            ฿{Number(selectedDrawdownProfitability?.realizedSpread ?? 0).toLocaleString(i18n.language)}
                                        </div>
                                    </div>
                                    <div>
                                        <div className="text-xs text-muted-foreground">{t("loans.unrealizedSpread", "Unrealized spread")}</div>
                                        <div className={`font-medium ${Number(selectedDrawdownProfitability?.unrealizedSpread ?? 0) >= 0 ? "text-emerald-600" : "text-destructive"}`}>
                                            ฿{Number(selectedDrawdownProfitability?.unrealizedSpread ?? 0).toLocaleString(i18n.language)}
                                        </div>
                                    </div>
                                    <div>
                                        <div className="text-xs text-muted-foreground">{t("loanDetail.outstandingFundingCost", "Outstanding funding cost")}</div>
                                        <div className="font-medium">฿{Number(selectedDrawdownProfitability?.outstandingCost ?? 0).toLocaleString(i18n.language)}</div>
                                    </div>
                                    <div>
                                        <div className="text-xs text-muted-foreground">{t("funds.metrics.netCash", "Net cash position")}</div>
                                        <div className={`font-medium ${Number(selectedDrawdownProfitability?.netCashPosition ?? 0) >= 0 ? "text-emerald-600" : "text-destructive"}`}>
                                            ฿{Number(selectedDrawdownProfitability?.netCashPosition ?? 0).toLocaleString(i18n.language)}
                                        </div>
                                    </div>
                                    <div>
                                        <div className="text-xs text-muted-foreground">{t("fundDetail.carryForward", "Carry-forward")}</div>
                                        <div className="font-medium">฿{Number(selectedDrawdownProfitability?.carryForwardAvailable ?? 0).toLocaleString(i18n.language)}</div>
                                    </div>
                                    <div>
                                        <div className="text-xs text-muted-foreground">{t("fundDetail.realizedRoi", "Realized ROI")}</div>
                                        <div className="font-medium">{Number(selectedDrawdownProfitability?.realizedRoiPercent ?? 0).toLocaleString()}%</div>
                                    </div>
                                </CardContent>
                            </Card>

                            <Card className="xl:col-span-2">
                                <CardHeader>
                                    <CardTitle>{t("loanDetail.repaymentSchedule", "Repayment Schedule")}</CardTitle>
                                </CardHeader>
                                <CardContent>
                                    {scheduleLoading ? (
                                        <div className="text-sm text-muted-foreground">{t("fundDetail.loadingSchedule", "Loading schedule...")}</div>
                                    ) : selectedSchedule.length === 0 ? (
                                        <div className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
                                            {t("fundDetail.noRepaymentSchedule", "This drawdown does not have a generated repayment schedule yet.")}
                                        </div>
                                    ) : (
                                        <div className="overflow-x-auto">
                                            <table className="w-full text-sm">
                                                <thead>
                                                    <tr className="border-b text-left">
                                                        <th className="py-2 pr-3">#</th>
                                                        <th className="py-2 pr-3">{t("loanWizard.nextDue", "Due Date")}</th>
                                                        <th className="py-2 pr-3">{t("fundDetail.total", "Total")}</th>
                                                        <th className="py-2 pr-3">{t("fundDetail.remaining", "Remaining")}</th>
                                                        <th className="py-2 pr-3">{t("common.status", "Status")}</th>
                                                        <th className="py-2">{t("fundDetail.action", "Action")}</th>
                                                    </tr>
                                                </thead>
                                                <tbody>
                                                    {selectedSchedule.map((item) => (
                                                        <tr key={item.id} className="border-b last:border-0">
                                                            <td className="py-2 pr-3">{item.installmentNo}</td>
                                                            <td className="py-2 pr-3">{item.dueDate}</td>
                                                            <td className="py-2 pr-3">฿{Number(item.scheduledTotal).toLocaleString()}</td>
                                                            <td className="py-2 pr-3">฿{Number(item.totalDueNow ?? item.remainingDue).toLocaleString()}</td>
                                                            <td className="py-2 pr-3 capitalize">{item.status}</td>
                                                            <td className="py-2">
                                                                <Button type="button" size="sm" variant={selectedScheduleId === item.id ? "default" : "outline"} onClick={() => handleSelectScheduleForRepayment(item)}>
                                                                    {t("fundDetail.select", "Select")}
                                                                </Button>
                                                            </td>
                                                        </tr>
                                                    ))}
                                                </tbody>
                                            </table>
                                        </div>
                                    )}
                                </CardContent>
                            </Card>

                            <Card>
                                <CardHeader>
                                    <CardTitle>{t("dashboardPage.actions.recordFundRepayment", "Record Fund Repayment")}</CardTitle>
                                </CardHeader>
                                <CardContent>
                                    <form className="space-y-3" onSubmit={handleRecordRepayment}>
                                        <div className="grid gap-1.5">
                                            <label className="text-sm font-medium">{t("transactionsForm.amount", "Amount")}</label>
                                            <Input type="number" value={repaymentAmount} onChange={(e) => setRepaymentAmount(e.target.value)} />
                                        </div>
                                        <div className="grid gap-1.5">
                                            <label className="text-sm font-medium">{t("transactionsForm.date", "Date")}</label>
                                            <Input type="date" value={repaymentDate} onChange={(e) => setRepaymentDate(e.target.value)} />
                                        </div>
                                        <div className="grid gap-1.5">
                                            <label className="text-sm font-medium">{t("transactionsForm.paymentMethod", "Payment Method")}</label>
                                            <Input value={repaymentMethod} onChange={(e) => setRepaymentMethod(e.target.value)} />
                                        </div>
                                        <div className="grid gap-1.5">
                                            <label className="text-sm font-medium">{t("transactionsForm.reference", "Reference")}</label>
                                            <Input value={repaymentReference} onChange={(e) => setRepaymentReference(e.target.value)} />
                                        </div>
                                        <div className="grid gap-1.5">
                                            <label className="text-sm font-medium">{t("transactionsForm.note", "Note")}</label>
                                            <Input value={repaymentNote} onChange={(e) => setRepaymentNote(e.target.value)} />
                                        </div>
                                        <Button type="submit" className="w-full" disabled={repaymentSubmitting || !selectedScheduleId}>
                                            {repaymentSubmitting ? t("common.saving", "Saving...") : t("fundDetail.saveRepayment", "Save Repayment")}
                                        </Button>
                                    </form>
                                </CardContent>
                            </Card>
                        </div>
                    )}

                    {selectedBankLoanId && (
                        <div className="grid gap-4 xl:grid-cols-2">
                            <Card>
                                <CardHeader>
                                    <CardTitle>{t("fundDetail.linkedBorrowerLoans", "Linked Borrower Loans")}</CardTitle>
                                </CardHeader>
                                <CardContent>
                                    {selectedAllocations.length === 0 ? (
                                        <div className="rounded border border-dashed p-4 text-sm text-muted-foreground">
                                            {t("fundDetail.noLinkedBorrowerLoans", "No borrower loans have been allocated to this drawdown yet.")}
                                        </div>
                                    ) : (
                                        <div className="space-y-2">
                                            {selectedAllocations.map((item) => (
                                                <div key={item.id} className="rounded border p-3 text-sm">
                                                    <div className="flex items-center justify-between gap-3">
                                                        <span className="font-medium">{item.borrowerName || `Loan #${item.loanId}`}</span>
                                                        <span>฿{Number(item.allocatedAmount).toLocaleString(i18n.language)}</span>
                                                    </div>
                                                    <div className="text-xs text-muted-foreground">
                                                        {item.allocationType} • {item.allocationDate}
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </CardContent>
                            </Card>

                            <Card>
                                <CardHeader>
                                    <CardTitle>{t("fundDetail.repaymentHistory", "Repayment History")}</CardTitle>
                                </CardHeader>
                                <CardContent>
                                    {selectedRepayments.length === 0 ? (
                                        <div className="rounded border border-dashed p-4 text-sm text-muted-foreground">
                                            {t("fundDetail.noRepayments", "No repayments recorded yet for this drawdown.")}
                                        </div>
                                    ) : (
                                        <div className="space-y-2">
                                            {selectedRepayments.map((item) => (
                                                <div key={item.id} className="rounded border p-3 text-sm">
                                                    <div className="flex items-center justify-between gap-3">
                                                        <span className="font-medium">{new Date(item.paymentDate).toLocaleDateString(i18n.language)}</span>
                                                        <span>฿{Number(item.amount).toLocaleString(i18n.language)}</span>
                                                    </div>
                                                    <div className="mt-1 text-xs text-muted-foreground">
                                                        {t("loanWizard.columns.principal", "Principal")} ฿{Number(item.principalComponent).toLocaleString(i18n.language)} • {t("loanDetail.outstandingInterest", "Interest")} ฿{Number(item.interestComponent).toLocaleString(i18n.language)} • {t("fundDetail.feeVatPenalty", "Fee/VAT/Penalty")} ฿{(Number(item.feeComponent) + Number(item.vatComponent) + Number(item.penaltyComponent)).toLocaleString(i18n.language)}
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </CardContent>
                            </Card>
                        </div>
                    )}
                </>
            )}
        </div>
    );
}
