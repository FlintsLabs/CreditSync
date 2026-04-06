import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ArrowLeft, ArrowRightLeft, Building2, CalendarDays, Wallet } from "lucide-react";
import { Link } from "react-router-dom";
import { Button } from "../../../components/ui/Button";
import { Card, CardContent, CardHeader, CardTitle } from "../../../components/ui/Card";
import { useTranslation } from "react-i18next";
import { api } from "../../../lib/api";
import { Input } from "../../../components/ui/Input";

interface BankProfile {
    id: number;
    name: string;
    type: string;
    creditLimit: string | null;
    accountingMode?: string;
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
    realizedSpread: number;
    unrealizedSpread: number;
    surplusBalance: number;
    deficitBalance: number;
    carryForwardAvailable: number;
    ownerSupportTotal?: number;
    poolCurrentBalance?: number;
}

interface SourceProfitability {
    borrowerRevenueCollected: number;
    fundCostPaid: number;
    realizedSpread: number;
    unrealizedSpread: number;
    deployedPrincipal: number;
    netCashPosition: number;
    realizedRoiPercent: number;
    carryForwardAvailable: number;
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

export default function FundDetail() {
    const { t } = useTranslation();
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
    const targetBankLoanId = searchParams.get("bankLoanId");
    const targetScheduleId = searchParams.get("scheduleId");

    const loadFund = async (fundId: string) => {
        const [fundRes, loansRes, profilesRes, settlementRes, profitabilityRes, rolloversRes] = await Promise.all([
            api.get(`/bank-profiles/${fundId}`),
            api.get("/bank-loans", { params: { bankProfileId: fundId } }),
            api.get("/bank-profiles"),
            api.get(`/bank-profiles/${fundId}/settlement-summary`),
            api.get(`/bank-profiles/${fundId}/profitability`),
            api.get("/fund-rollovers", { params: { bankProfileId: fundId } }),
        ]);

        setFund(fundRes.data ?? null);
        setBankLoans(loansRes.data ?? []);
        setAllFunds(profilesRes.data ?? []);
        setSettlementSummary(settlementRes.data ?? null);
        setSourceProfitability(profitabilityRes.data ?? null);
        setRollovers(rolloversRes.data ?? []);
    };

    useEffect(() => {
        const run = async () => {
            if (!id) {
                setErrorMessage("Funding source not found.");
                setLoading(false);
                return;
            }

            try {
                await loadFund(id);
                setErrorMessage("");
            } catch (error) {
                console.error("Failed to load fund details", error);
                setErrorMessage("Unable to load the funding source right now.");
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
            setErrorMessage("Unable to load the drawdown schedule right now.");
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
            setErrorMessage("Please complete amount, interest rate, and start date before saving the drawdown.");
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

            await loadFund(String(fund.id));
            resetDrawdownForm();
        } catch (error) {
            console.error("Failed to create drawdown", error);
            setErrorMessage("Unable to create the drawdown right now.");
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
            setErrorMessage("Please select a schedule row before recording a repayment.");
            return;
        }

        if (!repaymentAmount || Number(repaymentAmount) <= 0) {
            setErrorMessage("Please enter a repayment amount greater than zero.");
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
            setErrorMessage("Unable to record the repayment right now.");
        } finally {
            setRepaymentSubmitting(false);
        }
    };

    const handleCreateRollover = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (!fund) return;
        if (!rolloverAmount || Number(rolloverAmount) <= 0) {
            setErrorMessage("Please enter a rollover amount greater than zero.");
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

            await loadFund(String(fund.id));
            setRolloverTargetProfileId("");
            setRolloverAmount("");
            setRolloverType("surplus_transfer");
            setRolloverNote("");
        } catch (error: any) {
            console.error("Failed to create rollover", error);
            setErrorMessage(error?.response?.data?.error || "Unable to save the rollover entry right now.");
        } finally {
            setRolloverSubmitting(false);
        }
    };

    const fundLimit = Number(fund?.creditLimit ?? 0);
    const utilizedAmount = bankLoans.reduce((sum, loan) => sum + Number(loan.amount ?? 0), 0);
    const availableAmount = Math.max(0, fundLimit - utilizedAmount);
    const utilizationRate = fundLimit > 0 ? (utilizedAmount / fundLimit) * 100 : 0;
    const rolloverTargets = useMemo(
        () => allFunds.filter((item) => item.id !== fund?.id),
        [allFunds, fund?.id]
    );

    return (
        <div className="space-y-6">
            <div className="flex items-center gap-4">
                <Button variant="ghost" size="icon" onClick={() => navigate("/dashboard/funds")}>
                    <ArrowLeft className="h-4 w-4" />
                </Button>
                <div>
                    <h2 className="text-2xl font-bold tracking-tight">
                        {loading ? "Loading..." : fund?.name ?? "Funding Source"}
                    </h2>
                    <p className="text-muted-foreground">
                        {fund?.type === "bank" ? t("fund_detail.revolving_credit") : t("funds.capital")}
                    </p>
                </div>
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
                        This funding source does not exist anymore.
                    </CardContent>
                </Card>
            ) : (
                <>
                    <div className="grid gap-4 md:grid-cols-3">
                        <Card>
                            <CardHeader className="pb-2">
                                <CardTitle className="text-sm font-medium text-muted-foreground">Available Credit</CardTitle>
                            </CardHeader>
                            <CardContent>
                                <div className="flex items-center gap-3">
                                    <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary">
                                        {fund.type === "bank" ? <Building2 className="h-5 w-5" /> : <Wallet className="h-5 w-5" />}
                                    </div>
                                    <div className="text-3xl font-bold">฿{availableAmount.toLocaleString()}</div>
                                </div>
                                <div className="mt-3 text-xs text-muted-foreground">
                                    {t("funds.limit")}: ฿{fundLimit.toLocaleString()}
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
                                <CardTitle className="text-sm font-medium text-muted-foreground">Settlement Position</CardTitle>
                            </CardHeader>
                            <CardContent className="space-y-2 text-sm">
                                <div className="flex justify-between">
                                    <span>Realized spread</span>
                                    <span className="font-medium">฿{Number(settlementSummary?.realizedSpread ?? 0).toLocaleString()}</span>
                                </div>
                                <div className="flex justify-between">
                                    <span>Unrealized spread</span>
                                    <span className="font-medium">฿{Number(settlementSummary?.unrealizedSpread ?? 0).toLocaleString()}</span>
                                </div>
                                <div className="flex justify-between">
                                    <span>Surplus balance</span>
                                    <span className="font-medium text-emerald-600">฿{Number(settlementSummary?.surplusBalance ?? 0).toLocaleString()}</span>
                                </div>
                                <div className="flex justify-between">
                                    <span>Deficit balance</span>
                                    <span className="font-medium text-destructive">฿{Number(settlementSummary?.deficitBalance ?? 0).toLocaleString()}</span>
                                </div>
                            </CardContent>
                        </Card>

                        <Card>
                            <CardHeader className="pb-2">
                                <CardTitle className="text-sm font-medium text-muted-foreground">Source Profitability</CardTitle>
                            </CardHeader>
                            <CardContent className="space-y-2 text-sm">
                                <div className="flex justify-between">
                                    <span>Revenue collected</span>
                                    <span className="font-medium">฿{Number(sourceProfitability?.borrowerRevenueCollected ?? 0).toLocaleString()}</span>
                                </div>
                                <div className="flex justify-between">
                                    <span>Fund cost paid</span>
                                    <span className="font-medium">฿{Number(sourceProfitability?.fundCostPaid ?? 0).toLocaleString()}</span>
                                </div>
                                <div className="flex justify-between">
                                    <span>Deployed principal</span>
                                    <span className="font-medium">฿{Number(sourceProfitability?.deployedPrincipal ?? 0).toLocaleString()}</span>
                                </div>
                                <div className="flex justify-between">
                                    <span>Net cash position</span>
                                    <span className={`font-medium ${Number(sourceProfitability?.netCashPosition ?? 0) >= 0 ? "text-emerald-600" : "text-destructive"}`}>
                                        ฿{Number(sourceProfitability?.netCashPosition ?? 0).toLocaleString()}
                                    </span>
                                </div>
                                <div className="flex justify-between">
                                    <span>Realized ROI</span>
                                    <span className="font-medium">{Number(sourceProfitability?.realizedRoiPercent ?? 0).toLocaleString()}%</span>
                                </div>
                            </CardContent>
                        </Card>
                    </div>

                    <div className="grid gap-4 xl:grid-cols-[1.5fr_1fr]">
                        <Card>
                            <CardHeader className="pb-2">
                                <div className="flex items-center justify-between gap-4">
                                    <CardTitle className="text-sm font-medium">{t("fund_detail.active_withdrawals")}</CardTitle>
                                    <div className="flex items-center gap-2">
                                        <Link to="/dashboard/matching">
                                            <Button type="button" size="sm" variant="outline">Open Matching</Button>
                                        </Link>
                                        <Button
                                            type="button"
                                            size="sm"
                                            onClick={() => {
                                                setIsAddingDrawdown((value) => !value);
                                                setErrorMessage("");
                                            }}
                                        >
                                            Add Drawdown
                                        </Button>
                                    </div>
                                </div>
                            </CardHeader>
                            <CardContent>
                                {isAddingDrawdown && (
                                    <form className="mb-6 grid gap-4 rounded-lg border border-dashed p-4 md:grid-cols-2" onSubmit={handleCreateDrawdown}>
                                        <div className="grid gap-1.5">
                                            <label className="text-sm font-medium">Amount</label>
                                            <Input type="number" value={drawdownAmount} onChange={(e) => setDrawdownAmount(e.target.value)} />
                                        </div>
                                        <div className="grid gap-1.5">
                                            <label className="text-sm font-medium">Interest Rate (%)</label>
                                            <Input type="number" value={drawdownInterestRate} onChange={(e) => setDrawdownInterestRate(e.target.value)} />
                                        </div>
                                        <div className="grid gap-1.5">
                                            <label className="text-sm font-medium">Start Date</label>
                                            <Input type="date" value={drawdownStartDate} onChange={(e) => setDrawdownStartDate(e.target.value)} />
                                        </div>
                                        <div className="grid gap-1.5">
                                            <label className="text-sm font-medium">Term (Months)</label>
                                            <Input type="number" value={drawdownTermMonths} onChange={(e) => setDrawdownTermMonths(e.target.value)} />
                                        </div>
                                        <div className="grid gap-1.5">
                                            <label className="text-sm font-medium">Repayment Cycle</label>
                                            <select className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={drawdownRepaymentCycle} onChange={(e) => setDrawdownRepaymentCycle(e.target.value)}>
                                                <option value="monthly">Monthly</option>
                                                <option value="weekly">Weekly</option>
                                                <option value="daily">Daily</option>
                                            </select>
                                        </div>
                                        <div className="grid gap-1.5">
                                            <label className="text-sm font-medium">Fixed Installment Override</label>
                                            <Input type="number" placeholder="Optional" value={drawdownInstallmentAmount} onChange={(e) => setDrawdownInstallmentAmount(e.target.value)} />
                                        </div>
                                        <div className="flex items-end gap-2 md:col-span-2">
                                            <Button type="submit" disabled={createSubmitting}>{createSubmitting ? "Saving..." : "Save Drawdown"}</Button>
                                            <Button type="button" variant="outline" onClick={resetDrawdownForm} disabled={createSubmitting}>Cancel</Button>
                                        </div>
                                    </form>
                                )}

                                {bankLoans.length === 0 ? (
                                    <div className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
                                        No bank loan withdrawals have been recorded for this funding source yet.
                                    </div>
                                ) : (
                                    <div className="space-y-4">
                                        {bankLoans.map((loan) => (
                                            <button key={loan.id} type="button" className="flex w-full items-center justify-between border-b pb-2 text-left last:border-0 last:pb-0" onClick={() => loadSchedule(loan.id)}>
                                                <div className="space-y-1">
                                                    <div className="font-semibold">Withdrawal #{loan.id}</div>
                                                    <div className="text-xs text-muted-foreground">
                                                        {loan.startDate || "No start date"} • {loan.repaymentCycle || "monthly"} • Term: {loan.termMonths ?? 0} Months
                                                    </div>
                                                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                                        <CalendarDays className="h-3.5 w-3.5" />
                                                        Next due: {loan.nextDueDate || "Not scheduled"}
                                                    </div>
                                                </div>
                                                <div className="text-right">
                                                    <div className="font-bold">฿{Number(loan.amount).toLocaleString()}</div>
                                                    <div className="text-xs text-muted-foreground">
                                                        Installment: ฿{Number(loan.installmentAmount ?? 0).toLocaleString()}
                                                    </div>
                                                    <div className="text-xs text-muted-foreground">
                                                        Outstanding principal: ฿{Number(loan.outstandingPrincipal ?? 0).toLocaleString()}
                                                    </div>
                                                </div>
                                            </button>
                                        ))}
                                    </div>
                                )}
                            </CardContent>
                        </Card>

                        <Card>
                            <CardHeader className="pb-2">
                                <CardTitle className="text-sm font-medium flex items-center gap-2">
                                    <ArrowRightLeft className="h-4 w-4" />
                                    Rollover / Carry-forward
                                </CardTitle>
                            </CardHeader>
                            <CardContent className="space-y-4">
                                <form className="space-y-3" onSubmit={handleCreateRollover}>
                                    <div className="grid gap-1.5">
                                        <label className="text-sm font-medium">Entry Type</label>
                                        <select className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={rolloverType} onChange={(e) => setRolloverType(e.target.value)}>
                                            <option value="surplus_transfer">Surplus transfer</option>
                                            <option value="deficit_support">Deficit support</option>
                                            <option value="capitalization">Capitalization</option>
                                            <option value="manual_adjustment">Manual adjustment</option>
                                        </select>
                                    </div>
                                    <div className="grid gap-1.5">
                                        <label className="text-sm font-medium">Target Fund</label>
                                        <select className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={rolloverTargetProfileId} onChange={(e) => setRolloverTargetProfileId(e.target.value)}>
                                            <option value="">No destination / same source</option>
                                            {rolloverTargets.map((item) => (
                                                <option key={item.id} value={item.id}>{item.name}</option>
                                            ))}
                                        </select>
                                    </div>
                                    <div className="grid gap-1.5">
                                        <label className="text-sm font-medium">Amount</label>
                                        <Input type="number" value={rolloverAmount} onChange={(e) => setRolloverAmount(e.target.value)} />
                                    </div>
                                    <div className="grid gap-1.5">
                                        <label className="text-sm font-medium">Effective Date</label>
                                        <Input type="date" value={rolloverDate} onChange={(e) => setRolloverDate(e.target.value)} />
                                    </div>
                                    <div className="grid gap-1.5">
                                        <label className="text-sm font-medium">Note</label>
                                        <Input value={rolloverNote} onChange={(e) => setRolloverNote(e.target.value)} />
                                    </div>
                                    <Button type="submit" className="w-full" disabled={rolloverSubmitting}>
                                        {rolloverSubmitting ? "Saving..." : "Save Rollover"}
                                    </Button>
                                </form>

                                <div className="space-y-2">
                                    <div className="text-sm font-medium">History</div>
                                    {rollovers.length === 0 ? (
                                        <div className="rounded border border-dashed p-3 text-sm text-muted-foreground">
                                            No carry-forward entries yet.
                                        </div>
                                    ) : (
                                        <div className="space-y-2">
                                            {rollovers.slice(0, 5).map((item) => (
                                                <div key={item.id} className="rounded border p-3 text-sm">
                                                    <div className="flex items-center justify-between gap-3">
                                                        <span className="font-medium">{item.entryType}</span>
                                                        <span>฿{Number(item.amount).toLocaleString()}</span>
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
                                    <CardTitle>Selected Drawdown Position</CardTitle>
                                </CardHeader>
                                <CardContent className="grid gap-4 md:grid-cols-4 xl:grid-cols-6">
                                    <div>
                                        <div className="text-xs text-muted-foreground">Allocation state</div>
                                        <div className="font-medium capitalize">{selectedDrawdownAllocationState?.state?.replaceAll("_", " ") || "-"}</div>
                                    </div>
                                    <div>
                                        <div className="text-xs text-muted-foreground">Allocated principal</div>
                                        <div className="font-medium">฿{Number(selectedDrawdownAllocationState?.netAllocatedPrincipal ?? 0).toLocaleString()}</div>
                                    </div>
                                    <div>
                                        <div className="text-xs text-muted-foreground">Remaining capacity</div>
                                        <div className="font-medium">฿{Number(selectedDrawdownAllocationState?.remainingCapacity ?? 0).toLocaleString()}</div>
                                    </div>
                                    <div>
                                        <div className="text-xs text-muted-foreground">Revenue collected</div>
                                        <div className="font-medium">฿{Number(selectedDrawdownProfitability?.borrowerRevenueCollected ?? 0).toLocaleString()}</div>
                                    </div>
                                    <div>
                                        <div className="text-xs text-muted-foreground">Fund cost paid</div>
                                        <div className="font-medium">฿{Number(selectedDrawdownProfitability?.fundCostPaid ?? 0).toLocaleString()}</div>
                                    </div>
                                    <div>
                                        <div className="text-xs text-muted-foreground">Realized spread</div>
                                        <div className={`font-medium ${Number(selectedDrawdownProfitability?.realizedSpread ?? 0) >= 0 ? "text-emerald-600" : "text-destructive"}`}>
                                            ฿{Number(selectedDrawdownProfitability?.realizedSpread ?? 0).toLocaleString()}
                                        </div>
                                    </div>
                                    <div>
                                        <div className="text-xs text-muted-foreground">Unrealized spread</div>
                                        <div className={`font-medium ${Number(selectedDrawdownProfitability?.unrealizedSpread ?? 0) >= 0 ? "text-emerald-600" : "text-destructive"}`}>
                                            ฿{Number(selectedDrawdownProfitability?.unrealizedSpread ?? 0).toLocaleString()}
                                        </div>
                                    </div>
                                    <div>
                                        <div className="text-xs text-muted-foreground">Outstanding cost</div>
                                        <div className="font-medium">฿{Number(selectedDrawdownProfitability?.outstandingCost ?? 0).toLocaleString()}</div>
                                    </div>
                                    <div>
                                        <div className="text-xs text-muted-foreground">Net cash position</div>
                                        <div className={`font-medium ${Number(selectedDrawdownProfitability?.netCashPosition ?? 0) >= 0 ? "text-emerald-600" : "text-destructive"}`}>
                                            ฿{Number(selectedDrawdownProfitability?.netCashPosition ?? 0).toLocaleString()}
                                        </div>
                                    </div>
                                    <div>
                                        <div className="text-xs text-muted-foreground">Carry-forward</div>
                                        <div className="font-medium">฿{Number(selectedDrawdownProfitability?.carryForwardAvailable ?? 0).toLocaleString()}</div>
                                    </div>
                                    <div>
                                        <div className="text-xs text-muted-foreground">Realized ROI</div>
                                        <div className="font-medium">{Number(selectedDrawdownProfitability?.realizedRoiPercent ?? 0).toLocaleString()}%</div>
                                    </div>
                                </CardContent>
                            </Card>

                            <Card className="xl:col-span-2">
                                <CardHeader>
                                    <CardTitle>Repayment Schedule</CardTitle>
                                </CardHeader>
                                <CardContent>
                                    {scheduleLoading ? (
                                        <div className="text-sm text-muted-foreground">Loading schedule...</div>
                                    ) : selectedSchedule.length === 0 ? (
                                        <div className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
                                            This drawdown does not have a generated repayment schedule yet.
                                        </div>
                                    ) : (
                                        <div className="overflow-x-auto">
                                            <table className="w-full text-sm">
                                                <thead>
                                                    <tr className="border-b text-left">
                                                        <th className="py-2 pr-3">#</th>
                                                        <th className="py-2 pr-3">Due Date</th>
                                                        <th className="py-2 pr-3">Total</th>
                                                        <th className="py-2 pr-3">Remaining</th>
                                                        <th className="py-2 pr-3">Status</th>
                                                        <th className="py-2">Action</th>
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
                                                                    Select
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
                                    <CardTitle>Record Fund Repayment</CardTitle>
                                </CardHeader>
                                <CardContent>
                                    <form className="space-y-3" onSubmit={handleRecordRepayment}>
                                        <div className="grid gap-1.5">
                                            <label className="text-sm font-medium">Amount</label>
                                            <Input type="number" value={repaymentAmount} onChange={(e) => setRepaymentAmount(e.target.value)} />
                                        </div>
                                        <div className="grid gap-1.5">
                                            <label className="text-sm font-medium">Date</label>
                                            <Input type="date" value={repaymentDate} onChange={(e) => setRepaymentDate(e.target.value)} />
                                        </div>
                                        <div className="grid gap-1.5">
                                            <label className="text-sm font-medium">Payment Method</label>
                                            <Input value={repaymentMethod} onChange={(e) => setRepaymentMethod(e.target.value)} />
                                        </div>
                                        <div className="grid gap-1.5">
                                            <label className="text-sm font-medium">Reference</label>
                                            <Input value={repaymentReference} onChange={(e) => setRepaymentReference(e.target.value)} />
                                        </div>
                                        <div className="grid gap-1.5">
                                            <label className="text-sm font-medium">Note</label>
                                            <Input value={repaymentNote} onChange={(e) => setRepaymentNote(e.target.value)} />
                                        </div>
                                        <Button type="submit" className="w-full" disabled={repaymentSubmitting || !selectedScheduleId}>
                                            {repaymentSubmitting ? "Saving..." : "Save Repayment"}
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
                                    <CardTitle>Linked Borrower Loans</CardTitle>
                                </CardHeader>
                                <CardContent>
                                    {selectedAllocations.length === 0 ? (
                                        <div className="rounded border border-dashed p-4 text-sm text-muted-foreground">
                                            No borrower loans have been allocated to this drawdown yet.
                                        </div>
                                    ) : (
                                        <div className="space-y-2">
                                            {selectedAllocations.map((item) => (
                                                <div key={item.id} className="rounded border p-3 text-sm">
                                                    <div className="flex items-center justify-between gap-3">
                                                        <span className="font-medium">{item.borrowerName || `Loan #${item.loanId}`}</span>
                                                        <span>฿{Number(item.allocatedAmount).toLocaleString()}</span>
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
                                    <CardTitle>Repayment History</CardTitle>
                                </CardHeader>
                                <CardContent>
                                    {selectedRepayments.length === 0 ? (
                                        <div className="rounded border border-dashed p-4 text-sm text-muted-foreground">
                                            No repayments recorded yet for this drawdown.
                                        </div>
                                    ) : (
                                        <div className="space-y-2">
                                            {selectedRepayments.map((item) => (
                                                <div key={item.id} className="rounded border p-3 text-sm">
                                                    <div className="flex items-center justify-between gap-3">
                                                        <span className="font-medium">{new Date(item.paymentDate).toLocaleDateString()}</span>
                                                        <span>฿{Number(item.amount).toLocaleString()}</span>
                                                    </div>
                                                    <div className="mt-1 text-xs text-muted-foreground">
                                                        Principal ฿{Number(item.principalComponent).toLocaleString()} • Interest ฿{Number(item.interestComponent).toLocaleString()} • Fee/VAT/Penalty ฿{(Number(item.feeComponent) + Number(item.vatComponent) + Number(item.penaltyComponent)).toLocaleString()}
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
