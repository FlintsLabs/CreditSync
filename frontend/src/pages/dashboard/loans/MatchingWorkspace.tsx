import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRightLeft, ChevronLeft, Loader2 } from "lucide-react";
import { api } from "../../../lib/api";
import { Button } from "../../../components/ui/Button";
import { Card, CardContent, CardHeader, CardTitle } from "../../../components/ui/Card";
import { Input } from "../../../components/ui/Input";
import { Badge } from "../../../components/ui/badge";
import { useTranslation } from "react-i18next";
import { normalizeMoney } from "../../../lib/workflow-api";
import {
    absoluteMoney,
    formatMoneyExact,
    isNegativeMoney,
    isPositiveMoney,
    remainingMoney,
    sumMoney,
} from "../../../lib/workflow-model";

interface LoanRow {
    id: string;
    borrowerId: string;
    borrowerName: string;
    principal: string;
    status: string;
    repaymentType: string;
    createdAt: string;
    interestRate: string;
    fundedAmount?: string;
    allocationState?: string;
    remainingGap?: string;
}

interface AllocationRow {
    id: string;
    allocatedAmount: string;
    bankLoanPublicId?: string | null;
    bankProfilePublicId?: string | null;
    bankProfileName?: string | null;
    allocationDate?: string;
    allocationType?: string;
    note?: string | null;
}

interface DrawdownRow {
    id: string;
    publicId?: string;
    bankProfileId: number | null;
    amount: string;
    outstandingPrincipal: string | null;
    nextDueDate: string | null;
    status: string | null;
    allocatedAmount?: string;
    allocationState?: string;
    remainingCapacity?: string;
}

interface LoanAllocationState {
    loanId: string;
    principalAmount: string;
    netAllocatedPrincipal: string;
    remainingGap: string;
    overfundedAmount: string;
    state: string;
}

interface DrawdownAllocationState {
    bankLoanId: string;
    drawdownAmount: string;
    netAllocatedPrincipal: string;
    remainingCapacity: string;
    overallocatedAmount: string;
    state: string;
}

interface LoanProfitability {
    borrowerRevenueCollected: string;
    fundCostPaid: string;
    realizedSpread: string;
    unrealizedSpread: string;
    fundedPrincipal: string;
    unallocatedPrincipalGap: string;
}

interface BankProfile {
    id: number;
    name: string;
}

function formatCurrency(value: string, locale: string) {
    return formatMoneyExact(value, locale);
}

export default function MatchingWorkspace() {
    const { t, i18n } = useTranslation();
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [errorMessage, setErrorMessage] = useState("");
    const [loans, setLoans] = useState<LoanRow[]>([]);
    const [drawdowns, setDrawdowns] = useState<DrawdownRow[]>([]);
    const [bankProfiles, setBankProfiles] = useState<BankProfile[]>([]);
    const [selectedLoanId, setSelectedLoanId] = useState<string | null>(null);
    const [selectedLoanProfitability, setSelectedLoanProfitability] = useState<LoanProfitability | null>(null);
    const [draftAllocations, setDraftAllocations] = useState<Record<string, string>>({});
    const [allocationHistory, setAllocationHistory] = useState<AllocationRow[]>([]);
    const [reallocationForm, setReallocationForm] = useState({
        fromBankLoanId: "",
        toBankLoanId: "",
        amount: "",
        note: "",
    });

    const bankProfileNameById = useMemo(
        () => new Map(bankProfiles.map((item) => [item.id, item.name])),
        [bankProfiles]
    );

    const loadWorkspace = async () => {
        try {
            setLoading(true);
            const [loansRes, drawdownsRes, profilesRes] = await Promise.all([
                api.get("/loans"),
                api.get("/bank-loans"),
                api.get("/bank-profiles"),
            ]);

            const rawLoans = loansRes.data ?? [];
            const rawDrawdowns = (drawdownsRes.data ?? [])
                .filter((item: DrawdownRow) => item.status !== "closed")
                .map((item: DrawdownRow) => ({ ...item, id: item.publicId ?? String(item.id) }));

            const [loanStates, drawdownStates] = await Promise.all([
                Promise.all(rawLoans.map((loan: LoanRow) => api.get(`/loans/${loan.id}/allocation-state`).then((res) => ({ loanId: loan.id, state: res.data as LoanAllocationState })))),
                Promise.all(rawDrawdowns.map((drawdown: DrawdownRow) => api.get(`/bank-loans/${drawdown.id}/allocation-state`).then((res) => ({ bankLoanId: drawdown.id, state: res.data as DrawdownAllocationState })))),
            ]);

            const fundedByLoan = new Map<string, string>(
                loanStates.map(({ loanId, state }) => [
                    loanId,
                    state?.netAllocatedPrincipal ?? "0.00",
                ])
            );
            const allocatedByDrawdown = new Map<string, string>(
                drawdownStates.map(({ bankLoanId, state }) => [
                    bankLoanId,
                    state?.netAllocatedPrincipal ?? "0.00",
                ])
            );
            const loanStateById = new Map<string, LoanAllocationState>(loanStates.map(({ loanId, state }) => [loanId, state]));
            const drawdownStateById = new Map<string, DrawdownAllocationState>(drawdownStates.map(({ bankLoanId, state }) => [bankLoanId, state]));

            const normalizedLoans: LoanRow[] = rawLoans.map((loan: LoanRow) => ({
                ...loan,
                fundedAmount: fundedByLoan.get(loan.id) ?? "0.00",
                allocationState: loanStateById.get(loan.id)?.state,
                remainingGap: loanStateById.get(loan.id)?.remainingGap ?? "0.00",
            }));
            const normalizedDrawdowns = rawDrawdowns.map((drawdown: DrawdownRow) => ({
                ...drawdown,
                allocatedAmount: allocatedByDrawdown.get(drawdown.id) ?? "0.00",
                allocationState: drawdownStateById.get(drawdown.id)?.state,
                remainingCapacity: drawdownStateById.get(drawdown.id)?.remainingCapacity ?? "0.00",
            }));

            setLoans(normalizedLoans);
            setDrawdowns(normalizedDrawdowns);
            setBankProfiles(profilesRes.data ?? []);

            if (!selectedLoanId && normalizedLoans.length > 0) {
                const firstNeedsFunding = normalizedLoans.find((loan) => loan.allocationState !== "fully_funded");
                setSelectedLoanId(firstNeedsFunding?.id ?? normalizedLoans[0].id);
            }
        } catch (error) {
            console.error("Failed to load matching workspace", error);
            setErrorMessage(t("matching.errors.loadWorkspace", "Unable to load matching workspace right now."));
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        loadWorkspace();
    }, []);

    const selectedLoan = loans.find((loan) => loan.id === selectedLoanId) ?? null;
    const selectedLoanPrincipal = selectedLoan?.principal ?? "0.00";
    const selectedLoanFundedAmount = selectedLoan?.fundedAmount ?? "0.00";
    const pendingAllocationTotal = sumMoney(Object.values(draftAllocations).map((value) => value || "0"));
    const selectedLoanGap = selectedLoan?.remainingGap ?? remainingMoney(selectedLoanPrincipal, [selectedLoanFundedAmount]);
    const remainingFundingGap = remainingMoney(selectedLoanGap, [pendingAllocationTotal]);

    const needsFundingLoans = useMemo(
        () => loans.filter((loan) => loan.allocationState !== "fully_funded"),
        [loans]
    );

    const handleDraftChange = (drawdownId: string, value: string) => {
        setDraftAllocations((prev) => ({
            ...prev,
            [drawdownId]: value,
        }));
    };

    const handleSelectLoan = (loanId: string) => {
        setSelectedLoanId(loanId);
        setDraftAllocations({});
        setAllocationHistory([]);
        setReallocationForm({
            fromBankLoanId: "",
            toBankLoanId: "",
            amount: "",
            note: "",
        });
        setSelectedLoanProfitability(null);
        setErrorMessage("");
    };

    useEffect(() => {
        const loadLoanHistory = async () => {
            if (!selectedLoanId) {
                setAllocationHistory([]);
                setSelectedLoanProfitability(null);
                return;
            }

            try {
                const [historyRes, profitabilityRes] = await Promise.all([
                    api.get(`/loans/${selectedLoanId}/funding-allocations`),
                    api.get(`/loans/${selectedLoanId}/profitability`),
                ]);
                setAllocationHistory(historyRes.data ?? []);
                setSelectedLoanProfitability(profitabilityRes.data ?? null);
            } catch (error) {
                console.error("Failed to load allocation history", error);
                setErrorMessage(t("matching.errors.loadHistory", "Unable to load allocation history right now."));
            }
        };

        loadLoanHistory();
    }, [selectedLoanId]);

    const handleSaveAllocations = async () => {
        if (!selectedLoan) {
            setErrorMessage(t("matching.errors.selectLoanFirst", "Please select a borrower loan first."));
            return;
        }

        const entries = Object.entries(draftAllocations)
            .filter(([, value]) => value.trim() && isPositiveMoney(value))
            .map(([bankLoanPublicId, value]) => ({ bankLoanPublicId, amount: normalizeMoney(value) }));

        if (entries.length === 0) {
            setErrorMessage(t("matching.errors.enterAllocation", "Enter at least one allocation amount."));
            return;
        }

        try {
            setSaving(true);
            setErrorMessage("");

            for (const entry of entries) {
                await api.post(`/loans/${selectedLoan.id}/funding-allocations`, {
                    bankLoanPublicId: entry.bankLoanPublicId,
                    allocatedAmount: entry.amount,
                    allocationDate: new Date().toISOString().slice(0, 10),
                    allocationType: "initial",
                });
            }

            setDraftAllocations({});
            await loadWorkspace();
        } catch (error: any) {
            console.error("Failed to save allocations", error);
            setErrorMessage(error?.response?.data?.error || t("matching.errors.saveAllocations", "Unable to save allocations right now."));
        } finally {
            setSaving(false);
        }
    };

    const currentAllocationByDrawdown = useMemo(() => {
        const grouped = new Map<string, { bankLoanPublicId: string; bankProfileName: string; amount: string }>();
        for (const row of allocationHistory) {
            if (!row.bankLoanPublicId) continue;
            const current = grouped.get(row.bankLoanPublicId) ?? {
                bankLoanPublicId: row.bankLoanPublicId,
                bankProfileName: row.bankProfileName ?? t("matching.unknownSource", "Unknown source"),
                amount: "0.00",
            };
            current.amount = sumMoney([current.amount, row.allocatedAmount]);
            grouped.set(row.bankLoanPublicId, current);
        }
        return Array.from(grouped.values()).filter((row) => isPositiveMoney(absoluteMoney(row.amount)));
    }, [allocationHistory, bankProfileNameById]);

    const handleReallocate = async () => {
        if (!selectedLoanId) {
            setErrorMessage(t("matching.errors.selectLoanFirst", "Please select a borrower loan first."));
            return;
        }

        if (!reallocationForm.fromBankLoanId || !reallocationForm.toBankLoanId || !reallocationForm.amount) {
            setErrorMessage(t("matching.errors.completeReallocation", "Please complete source, target, and amount for reallocation."));
            return;
        }

        try {
            setSaving(true);
            setErrorMessage("");

            await api.post(`/loans/${selectedLoanId}/funding-reallocations`, {
                fromBankLoanPublicId: reallocationForm.fromBankLoanId,
                toBankLoanPublicId: reallocationForm.toBankLoanId,
                amount: normalizeMoney(reallocationForm.amount),
                allocationDate: new Date().toISOString().slice(0, 10),
                note: reallocationForm.note || undefined,
            });

            setReallocationForm({
                fromBankLoanId: "",
                toBankLoanId: "",
                amount: "",
                note: "",
            });
            await loadWorkspace();
            const historyRes = await api.get(`/loans/${selectedLoanId}/funding-allocations`);
            setAllocationHistory(historyRes.data ?? []);
        } catch (error: any) {
            console.error("Failed to reallocate", error);
            setErrorMessage(error?.response?.data?.error || t("matching.errors.reallocate", "Unable to reallocate funding right now."));
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="space-y-6">
            <div className="flex items-center justify-between gap-4">
                <div>
                    <div className="flex items-center gap-3">
                        <Link to="/loans" className="inline-flex h-10 w-10 items-center justify-center rounded-md border border-input bg-background hover:bg-accent">
                            <ChevronLeft className="h-4 w-4" />
                        </Link>
                        <div>
                            <h2 className="text-3xl font-bold tracking-tight">{t("matching.title", "Matching Workspace")}</h2>
                            <p className="text-muted-foreground">{t("matching.description", "Match borrower loans to one or more funding drawdowns with live funding gap checks.")}</p>
                        </div>
                    </div>
                </div>
                <Button onClick={() => loadWorkspace()} variant="outline" disabled={loading || saving}>{t("common.refresh", "Refresh")}</Button>
            </div>

            {errorMessage && (
                <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                    {errorMessage}
                </div>
            )}

            <div className="grid gap-4 xl:grid-cols-[0.95fr_1.35fr]">
                <Card>
                    <CardHeader>
                        <CardTitle>{t("matching.needsFunding", "Needs Funding")}</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                        {loading ? (
                            <div className="text-sm text-muted-foreground">{t("matching.loadingLoans", "Loading loans...")}</div>
                        ) : needsFundingLoans.length === 0 ? (
                            <div className="rounded border border-dashed p-4 text-sm text-muted-foreground">
                                {t("matching.allFunded", "All current borrower loans are fully funded.")}
                            </div>
                        ) : (
                            needsFundingLoans.map((loan) => {
                                const principal = loan.principal;
                                const fundedAmount = loan.fundedAmount ?? "0.00";
                                const gap = loan.remainingGap ?? remainingMoney(principal, [fundedAmount]);
                                const state = loan.allocationState?.replaceAll("_", " ") ?? "unfunded";
                                return (
                                    <button
                                        key={loan.id}
                                        type="button"
                                        onClick={() => handleSelectLoan(loan.id)}
                                        className={`w-full rounded-lg border p-4 text-left transition-colors ${selectedLoanId === loan.id ? "border-primary bg-primary/5" : "hover:bg-muted/40"}`}
                                    >
                                        <div className="flex items-center justify-between gap-3">
                                            <div>
                                                <div className="font-medium">{loan.borrowerName}</div>
                                                <div className="text-xs text-muted-foreground">{t("loans.loanLabel", { defaultValue: "Loan #{{id}}", id: loan.id })}</div>
                                            </div>
                                            <Badge variant={loan.allocationState === "unfunded" ? "destructive" : "secondary"}>{state}</Badge>
                                        </div>
                                        <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
                                            <div>
                                                <div className="text-muted-foreground">{t("loanWizard.columns.principal", "Principal")}</div>
                                                <div className="font-medium">{formatCurrency(principal, i18n.language)}</div>
                                            </div>
                                            <div>
                                                <div className="text-muted-foreground">{t("matching.funded", "Funded")}</div>
                                                <div className="font-medium">{formatCurrency(fundedAmount, i18n.language)}</div>
                                            </div>
                                            <div>
                                                <div className="text-muted-foreground">{t("loans.remainingGap", "Gap")}</div>
                                                <div className="font-medium text-destructive">{formatCurrency(gap, i18n.language)}</div>
                                            </div>
                                        </div>
                                    </button>
                                );
                            })
                        )}
                    </CardContent>
                </Card>

                <div className="space-y-4">
                    <Card>
                        <CardHeader>
                            <CardTitle>{t("matching.selectedLoan", "Selected Loan")}</CardTitle>
                        </CardHeader>
                        <CardContent>
                            {!selectedLoan ? (
                                <div className="rounded border border-dashed p-4 text-sm text-muted-foreground">
                                    {t("matching.selectLoanPrompt", "Select a borrower loan from the left to start matching.")}
                                </div>
                            ) : (
                                <div className="grid gap-4 md:grid-cols-4">
                                    <div>
                                        <div className="text-xs text-muted-foreground">{t("loanWizard.borrower", "Borrower")}</div>
                                        <div className="font-medium">{selectedLoan.borrowerName}</div>
                                    </div>
                                    <div>
                                        <div className="text-xs text-muted-foreground">{t("loanWizard.columns.principal", "Principal")}</div>
                                        <div className="font-medium">{formatCurrency(selectedLoanPrincipal, i18n.language)}</div>
                                    </div>
                                    <div>
                                        <div className="text-xs text-muted-foreground">{t("matching.alreadyFunded", "Already funded")}</div>
                                        <div className="font-medium">{formatCurrency(selectedLoanFundedAmount, i18n.language)}</div>
                                    </div>
                                    <div>
                                        <div className="text-xs text-muted-foreground">{t("loans.remainingGap", "Remaining gap")}</div>
                                        <div className={`font-medium ${isPositiveMoney(remainingFundingGap) ? "text-destructive" : "text-emerald-600"}`}>{formatCurrency(remainingFundingGap, i18n.language)}</div>
                                    </div>
                                </div>
                            )}
                        </CardContent>
                    </Card>

                    {selectedLoan && (
                        <Card>
                            <CardHeader>
                                <CardTitle>{t("matching.loanProfitabilitySnapshot", "Loan Profitability Snapshot")}</CardTitle>
                            </CardHeader>
                            <CardContent className="grid gap-4 md:grid-cols-3 xl:grid-cols-6">
                                <div>
                                    <div className="text-xs text-muted-foreground">{t("dashboardPage.cards.borrowerRevenue", "Revenue collected")}</div>
                                    <div className="font-medium">{formatCurrency(selectedLoanProfitability?.borrowerRevenueCollected ?? "0.00", i18n.language)}</div>
                                </div>
                                <div>
                                    <div className="text-xs text-muted-foreground">{t("dashboardPage.cards.fundCostPaid", "Fund cost paid")}</div>
                                    <div className="font-medium">{formatCurrency(selectedLoanProfitability?.fundCostPaid ?? "0.00", i18n.language)}</div>
                                </div>
                                <div>
                                    <div className="text-xs text-muted-foreground">{t("funds.metrics.realizedSpread", "Realized spread")}</div>
                                    <div className={`font-medium ${!isNegativeMoney(selectedLoanProfitability?.realizedSpread ?? "0.00") ? "text-emerald-600" : "text-destructive"}`}>
                                        {formatCurrency(selectedLoanProfitability?.realizedSpread ?? "0.00", i18n.language)}
                                    </div>
                                </div>
                                <div>
                                    <div className="text-xs text-muted-foreground">{t("loans.unrealizedSpread", "Unrealized spread")}</div>
                                    <div className={`font-medium ${!isNegativeMoney(selectedLoanProfitability?.unrealizedSpread ?? "0.00") ? "text-emerald-600" : "text-destructive"}`}>
                                        {formatCurrency(selectedLoanProfitability?.unrealizedSpread ?? "0.00", i18n.language)}
                                    </div>
                                </div>
                                <div>
                                    <div className="text-xs text-muted-foreground">{t("loanDetail.fundedPrincipal", "Funded principal")}</div>
                                    <div className="font-medium">{formatCurrency(selectedLoanProfitability?.fundedPrincipal ?? "0.00", i18n.language)}</div>
                                </div>
                                <div>
                                    <div className="text-xs text-muted-foreground">{t("matching.gapAfterMatching", "Gap after matching")}</div>
                                    <div className="font-medium">{formatCurrency(selectedLoanProfitability?.unallocatedPrincipalGap ?? selectedLoan.remainingGap ?? "0.00", i18n.language)}</div>
                                </div>
                            </CardContent>
                        </Card>
                    )}

                    {selectedLoan && (
                        <div className="grid gap-4 xl:grid-cols-2">
                            <Card>
                                <CardHeader>
                                    <CardTitle>{t("matching.currentNetAllocations", "Current Net Allocations")}</CardTitle>
                                </CardHeader>
                                <CardContent className="space-y-3">
                                    {currentAllocationByDrawdown.length === 0 ? (
                                        <div className="rounded border border-dashed p-4 text-sm text-muted-foreground">
                                            {t("matching.noActiveAllocations", "This loan has no active allocations yet.")}
                                        </div>
                                    ) : (
                                        currentAllocationByDrawdown.map((item) => (
                                            <div key={item.bankLoanPublicId} className="rounded border p-3 text-sm">
                                                <div className="flex items-center justify-between gap-3">
                                                    <div>
                                                        <div className="font-medium">{t("dashboardPage.drawdownLabel", { defaultValue: "Drawdown #{{id}}", id: item.bankLoanPublicId })}</div>
                                                        <div className="text-xs text-muted-foreground">{item.bankProfileName}</div>
                                                    </div>
                                                    <div className="font-medium">{formatCurrency(item.amount, i18n.language)}</div>
                                                </div>
                                            </div>
                                        ))
                                    )}
                                </CardContent>
                            </Card>

                            <Card>
                                <CardHeader>
                                    <CardTitle>{t("matching.reallocateFunding", "Reallocate Funding")}</CardTitle>
                                </CardHeader>
                                <CardContent className="space-y-3">
                                    <div className="grid gap-1.5">
                                        <label className="text-sm font-medium">{t("matching.fromDrawdown", "From drawdown")}</label>
                                        <select
                                            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                                            value={reallocationForm.fromBankLoanId}
                                            onChange={(e) => setReallocationForm((prev) => ({ ...prev, fromBankLoanId: e.target.value }))}
                                        >
                                            <option value="">{t("matching.selectSource", "Select source...")}</option>
                                            {currentAllocationByDrawdown.map((item) => (
                                                <option key={item.bankLoanPublicId} value={item.bankLoanPublicId}>
                                                    #{item.bankLoanPublicId} • {item.bankProfileName} • {formatCurrency(item.amount, i18n.language)}
                                                </option>
                                            ))}
                                        </select>
                                    </div>
                                    <div className="grid gap-1.5">
                                        <label className="text-sm font-medium">{t("matching.toDrawdown", "To drawdown")}</label>
                                        <select
                                            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                                            value={reallocationForm.toBankLoanId}
                                            onChange={(e) => setReallocationForm((prev) => ({ ...prev, toBankLoanId: e.target.value }))}
                                        >
                                            <option value="">{t("matching.selectTarget", "Select target...")}</option>
                                            {drawdowns.map((item) => (
                                                <option key={item.id} value={item.id}>
                                                    #{item.id} • {item.bankProfileId ? bankProfileNameById.get(item.bankProfileId) ?? t("matching.unknownSource", "Unknown source") : t("matching.unknownSource", "Unknown source")}
                                                </option>
                                            ))}
                                        </select>
                                    </div>
                                    <div className="grid gap-1.5">
                                        <label className="text-sm font-medium">{t("transactionsForm.amount", "Amount")}</label>
                                        <Input
                                            type="number"
                                            min="0"
                                            step="0.01"
                                            value={reallocationForm.amount}
                                            onChange={(e) => setReallocationForm((prev) => ({ ...prev, amount: e.target.value }))}
                                        />
                                    </div>
                                    <div className="grid gap-1.5">
                                        <label className="text-sm font-medium">{t("transactionsForm.note", "Note")}</label>
                                        <Input
                                            value={reallocationForm.note}
                                            onChange={(e) => setReallocationForm((prev) => ({ ...prev, note: e.target.value }))}
                                        />
                                    </div>
                                    <Button onClick={handleReallocate} disabled={saving}>
                                        {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                                        {t("matching.reallocate", "Reallocate")}
                                    </Button>
                                </CardContent>
                            </Card>
                        </div>
                    )}

                    <Card>
                        <CardHeader>
                            <div className="flex items-center justify-between gap-3">
                                <CardTitle className="flex items-center gap-2">
                                    <ArrowRightLeft className="h-4 w-4" />
                                    {t("matching.availableDrawdowns", "Available Drawdowns")}
                                </CardTitle>
                                <Button onClick={handleSaveAllocations} disabled={!selectedLoan || saving}>
                                    {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                                    {t("matching.saveAllocations", "Save Allocations")}
                                </Button>
                            </div>
                        </CardHeader>
                        <CardContent className="space-y-3">
                            {loading ? (
                                <div className="text-sm text-muted-foreground">{t("matching.loadingDrawdowns", "Loading drawdowns...")}</div>
                            ) : drawdowns.length === 0 ? (
                                <div className="rounded border border-dashed p-4 text-sm text-muted-foreground">
                                    {t("matching.noActiveDrawdowns", "No active drawdowns available for matching.")}
                                </div>
                            ) : (
                                drawdowns.map((drawdown) => {
                                    const amount = drawdown.amount;
                                    const allocatedAmount = drawdown.allocatedAmount ?? "0.00";
                                    const draftAmount = draftAllocations[drawdown.id] || "0";
                                    const available = drawdown.remainingCapacity ?? remainingMoney(amount, [allocatedAmount]);
                                    const availableAfterDraft = remainingMoney(available, [draftAmount]);
                                    return (
                                        <div key={drawdown.id} className="rounded-lg border p-4">
                                            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                                                <div className="space-y-1">
                                                    <div className="font-medium">
                                                        {t("dashboardPage.drawdownLabel", { defaultValue: "Drawdown #{{id}}", id: drawdown.id })} {drawdown.bankProfileId ? `• ${bankProfileNameById.get(drawdown.bankProfileId) ?? t("matching.unknownSource", "Unknown source")}` : ""}
                                                    </div>
                                                    <div className="text-xs text-muted-foreground">
                                                        {t("loanWizard.outstandingPrincipal", "Outstanding principal")}: {formatCurrency(drawdown.outstandingPrincipal ?? "0.00", i18n.language)} • {t("loanWizard.nextDue", "Next due")}: {drawdown.nextDueDate || t("matching.notScheduled", "Not scheduled")}
                                                    </div>
                                                    <div className="text-xs text-muted-foreground capitalize">
                                                        {t("matching.allocationState", "Allocation state")}: {(drawdown.allocationState ?? "unallocated").replaceAll("_", " ")}
                                                    </div>
                                                </div>
                                                <div className="grid grid-cols-2 gap-3 text-xs md:min-w-[280px]">
                                                    <div>
                                                        <div className="text-muted-foreground">{t("matching.drawdownTotal", "Drawdown total")}</div>
                                                        <div className="font-medium">{formatCurrency(amount, i18n.language)}</div>
                                                    </div>
                                                    <div>
                                                        <div className="text-muted-foreground">{t("matching.alreadyAllocated", "Already allocated")}</div>
                                                        <div className="font-medium">{formatCurrency(allocatedAmount, i18n.language)}</div>
                                                    </div>
                                                    <div>
                                                        <div className="text-muted-foreground">{t("matching.availableNow", "Available now")}</div>
                                                        <div className="font-medium">{formatCurrency(available, i18n.language)}</div>
                                                    </div>
                                                    <div>
                                                        <div className="text-muted-foreground">{t("matching.afterDraft", "After draft")}</div>
                                                        <div className={`font-medium ${!isPositiveMoney(availableAfterDraft) && isPositiveMoney(draftAmount) ? "text-destructive" : ""}`}>{formatCurrency(availableAfterDraft, i18n.language)}</div>
                                                    </div>
                                                </div>
                                            </div>
                                            <div className="mt-4 grid gap-2 md:grid-cols-[1fr_180px] md:items-end">
                                                <div className="text-xs text-muted-foreground">
                                                    {t("matching.allocateHelp", "Enter how much of this drawdown should fund the selected borrower loan. One loan can take multiple drawdowns.")}
                                                </div>
                                                <div className="grid gap-1.5">
                                                    <label className="text-sm font-medium">{t("matching.allocateAmount", "Allocate Amount")}</label>
                                                    <Input
                                                        type="number"
                                                        min="0"
                                                        step="0.01"
                                                        value={draftAllocations[drawdown.id] ?? ""}
                                                        onChange={(e) => handleDraftChange(drawdown.id, e.target.value)}
                                                        disabled={!selectedLoan}
                                                    />
                                                </div>
                                            </div>
                                        </div>
                                    );
                                })
                            )}
                        </CardContent>
                    </Card>

                    {selectedLoan && (
                        <Card>
                            <CardHeader>
                                <CardTitle>{t("loanDetail.allocationHistory", "Allocation History")}</CardTitle>
                            </CardHeader>
                            <CardContent>
                                {allocationHistory.length === 0 ? (
                                    <div className="rounded border border-dashed p-4 text-sm text-muted-foreground">
                                        {t("matching.noAllocationHistory", "No allocation history yet for this loan.")}
                                    </div>
                                ) : (
                                    <div className="space-y-2">
                                        {allocationHistory.map((row) => (
                                            <div key={row.id} className="rounded border p-3 text-sm">
                                                <div className="flex items-center justify-between gap-3">
                                                    <div>
                                                        <div className="font-medium">
                                                            {row.allocationType} {row.bankLoanPublicId ? `• ${t("dashboardPage.drawdownLabel", { defaultValue: "Drawdown #{{id}}", id: row.bankLoanPublicId })}` : ""}
                                                        </div>
                                                        <div className="text-xs text-muted-foreground">
                                                            {row.bankProfileName ?? t("matching.noSource", "No source")} • {row.allocationDate || "-"}
                                                        </div>
                                                    </div>
                                                    <div className={`font-medium ${isNegativeMoney(row.allocatedAmount) ? "text-destructive" : "text-emerald-600"}`}>
                                                        {isNegativeMoney(row.allocatedAmount) ? "-" : "+"}{formatCurrency(absoluteMoney(row.allocatedAmount), i18n.language)}
                                                    </div>
                                                </div>
                                                {row.note && <div className="mt-1 text-xs text-muted-foreground">{row.note}</div>}
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </CardContent>
                        </Card>
                    )}
                </div>
            </div>
        </div>
    );
}
