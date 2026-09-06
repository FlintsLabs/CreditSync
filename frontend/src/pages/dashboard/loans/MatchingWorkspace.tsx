import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, Check, ChevronDown, ChevronLeft, Loader2, Search } from "lucide-react";
import { api } from "../../../lib/api";
import { Button } from "../../../components/ui/Button";
import { Input } from "../../../components/ui/Input";
import { useTranslation } from "react-i18next";
import { normalizeMoney } from "../../../lib/workflow-api";
import {
    absoluteMoney,
    formatMoneyExact,
    isNegativeMoney,
    isPositiveMoney,
    moneyDifference,
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
    netAllocatedPrincipal: string;
    remainingGap: string;
    state: string;
}

interface DrawdownAllocationState {
    netAllocatedPrincipal: string;
    remainingCapacity: string;
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

interface BankProfile { id: number; name: string }
interface ReviewEntry { bankLoanPublicId: string; amount: string }

function moneyInputOrZero(value: string | undefined) {
    if (!value?.trim()) return "0.00";
    try { return normalizeMoney(value); } catch { return "0.00"; }
}

function shortId(value: string) {
    return value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value;
}

export default function MatchingWorkspace() {
    const { t, i18n } = useTranslation();
    const money = (value: string) => formatMoneyExact(value, i18n.language);
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
    const [searchQuery, setSearchQuery] = useState("");
    const [loanFilter, setLoanFilter] = useState<"needs" | "funded">("needs");
    const [reviewEntries, setReviewEntries] = useState<ReviewEntry[] | null>(null);
    const [showReallocation, setShowReallocation] = useState(false);
    const [reallocationForm, setReallocationForm] = useState({ fromBankLoanId: "", toBankLoanId: "", amount: "", note: "" });

    const bankProfileNameById = useMemo(
        () => new Map(bankProfiles.map((item) => [item.id, item.name])),
        [bankProfiles],
    );

    const loadWorkspace = async () => {
        try {
            setLoading(true);
            const [loansRes, drawdownsRes, profilesRes] = await Promise.all([
                api.get("/loans"), api.get("/bank-loans"), api.get("/bank-profiles"),
            ]);
            const rawLoans: LoanRow[] = loansRes.data ?? [];
            const rawDrawdowns: DrawdownRow[] = (drawdownsRes.data ?? [])
                .filter((item: DrawdownRow) => item.status !== "closed")
                .map((item: DrawdownRow) => ({ ...item, id: item.publicId ?? String(item.id) }));
            const [loanStates, drawdownStates] = await Promise.all([
                Promise.all(rawLoans.map((loan) => api.get(`/loans/${loan.id}/allocation-state`).then((res) => ({ id: loan.id, state: res.data as LoanAllocationState })))),
                Promise.all(rawDrawdowns.map((drawdown) => api.get(`/bank-loans/${drawdown.id}/allocation-state`).then((res) => ({ id: drawdown.id, state: res.data as DrawdownAllocationState })))),
            ]);
            const loanStateById = new Map(loanStates.map((row) => [row.id, row.state]));
            const drawdownStateById = new Map(drawdownStates.map((row) => [row.id, row.state]));
            const normalizedLoans = rawLoans.map((loan) => ({
                ...loan,
                fundedAmount: loanStateById.get(loan.id)?.netAllocatedPrincipal ?? "0.00",
                remainingGap: loanStateById.get(loan.id)?.remainingGap ?? loan.principal,
                allocationState: loanStateById.get(loan.id)?.state ?? "unfunded",
            }));
            setLoans(normalizedLoans);
            setDrawdowns(rawDrawdowns.map((drawdown) => ({
                ...drawdown,
                allocatedAmount: drawdownStateById.get(drawdown.id)?.netAllocatedPrincipal ?? "0.00",
                remainingCapacity: drawdownStateById.get(drawdown.id)?.remainingCapacity ?? drawdown.amount,
                allocationState: drawdownStateById.get(drawdown.id)?.state ?? "unallocated",
            })));
            setBankProfiles(profilesRes.data ?? []);
            if (!selectedLoanId && normalizedLoans.length > 0) {
                setSelectedLoanId(normalizedLoans.find((loan) => loan.allocationState !== "fully_funded")?.id ?? normalizedLoans[0]!.id);
            }
        } catch (error) {
            console.error("Failed to load matching workspace", error);
            setErrorMessage(t("matching.errors.loadWorkspace"));
        } finally { setLoading(false); }
    };

    useEffect(() => { void loadWorkspace(); }, []);

    const selectedLoan = loans.find((loan) => loan.id === selectedLoanId) ?? null;
    const selectedLoanPrincipal = selectedLoan?.principal ?? "0.00";
    const selectedLoanFundedAmount = selectedLoan?.fundedAmount ?? "0.00";
    const selectedLoanGap = selectedLoan?.remainingGap ?? remainingMoney(selectedLoanPrincipal, [selectedLoanFundedAmount]);
    const pendingAllocationTotal = reviewEntries
        ? sumMoney(reviewEntries.map((entry) => entry.amount))
        : sumMoney(Object.values(draftAllocations).map(moneyInputOrZero));
    const remainingFundingGap = remainingMoney(selectedLoanGap, [pendingAllocationTotal]);

    const filteredLoans = useMemo(() => {
        const query = searchQuery.trim().toLocaleLowerCase(i18n.language);
        return loans.filter((loan) => {
            const isFunded = loan.allocationState === "fully_funded";
            const matchesFilter = loanFilter === "funded" ? isFunded : !isFunded;
            const matchesQuery = !query || loan.borrowerName.toLocaleLowerCase(i18n.language).includes(query) || loan.id.toLowerCase().includes(query);
            return matchesFilter && matchesQuery;
        });
    }, [i18n.language, loanFilter, loans, searchQuery]);

    const currentAllocationByDrawdown = useMemo(() => {
        const grouped = new Map<string, { bankLoanPublicId: string; bankProfileName: string; amount: string }>();
        for (const row of allocationHistory) {
            if (!row.bankLoanPublicId) continue;
            const current = grouped.get(row.bankLoanPublicId) ?? {
                bankLoanPublicId: row.bankLoanPublicId,
                bankProfileName: row.bankProfileName ?? t("matching.unknownSource"),
                amount: "0.00",
            };
            current.amount = sumMoney([current.amount, row.allocatedAmount]);
            grouped.set(row.bankLoanPublicId, current);
        }
        return [...grouped.values()].filter((row) => isPositiveMoney(absoluteMoney(row.amount)));
    }, [allocationHistory, t]);

    const selectLoan = (loanId: string) => {
        setSelectedLoanId(loanId);
        setDraftAllocations({});
        setReviewEntries(null);
        setAllocationHistory([]);
        setSelectedLoanProfitability(null);
        setShowReallocation(false);
        setErrorMessage("");
    };

    useEffect(() => {
        if (!selectedLoanId) return;
        Promise.all([
            api.get(`/loans/${selectedLoanId}/funding-allocations`),
            api.get(`/loans/${selectedLoanId}/profitability`),
        ]).then(([history, profitability]) => {
            setAllocationHistory(history.data ?? []);
            setSelectedLoanProfitability(profitability.data ?? null);
        }).catch((error) => {
            console.error("Failed to load allocation history", error);
            setErrorMessage(t("matching.errors.loadHistory"));
        });
    }, [selectedLoanId, t]);

    const prepareReview = () => {
        if (!selectedLoan) return setErrorMessage(t("matching.errors.selectLoanFirst"));
        try {
            const entries = Object.entries(draftAllocations)
                .filter(([, value]) => value.trim())
                .map(([bankLoanPublicId, value]) => ({ bankLoanPublicId, amount: normalizeMoney(value) }));
            if (entries.length === 0 || entries.some((entry) => !isPositiveMoney(entry.amount))) throw new Error("invalid");
            const exceedsGap = isNegativeMoney(moneyDifference(selectedLoanGap, sumMoney(entries.map((entry) => entry.amount))));
            const exceedsCapacity = entries.some((entry) => {
                const capacity = drawdowns.find((drawdown) => drawdown.id === entry.bankLoanPublicId)?.remainingCapacity;
                return !capacity || isNegativeMoney(moneyDifference(capacity, entry.amount));
            });
            if (exceedsGap || exceedsCapacity) {
                setErrorMessage(t("matching.errors.exceedsAvailable"));
                return;
            }
            setReviewEntries(entries);
            setErrorMessage("");
        } catch { setErrorMessage(t("matching.errors.invalidAllocation")); }
    };

    const confirmAllocations = async () => {
        if (!selectedLoan || !reviewEntries) return;
        try {
            setSaving(true);
            setErrorMessage("");
            for (const entry of reviewEntries) {
                await api.post(`/loans/${selectedLoan.id}/funding-allocations`, {
                    bankLoanPublicId: entry.bankLoanPublicId,
                    allocatedAmount: entry.amount,
                    allocationDate: new Date().toISOString().slice(0, 10),
                    allocationType: "initial",
                });
            }
            setDraftAllocations({});
            setReviewEntries(null);
            await loadWorkspace();
        } catch (error: any) {
            console.error("Failed to save allocations", error);
            setErrorMessage(error?.response?.data?.error || t("matching.errors.saveAllocations"));
        } finally { setSaving(false); }
    };

    const handleReallocate = async () => {
        if (!selectedLoanId) return setErrorMessage(t("matching.errors.selectLoanFirst"));
        if (!reallocationForm.fromBankLoanId || !reallocationForm.toBankLoanId || !reallocationForm.amount) {
            return setErrorMessage(t("matching.errors.completeReallocation"));
        }
        try {
            setSaving(true);
            await api.post(`/loans/${selectedLoanId}/funding-reallocations`, {
                fromBankLoanPublicId: reallocationForm.fromBankLoanId,
                toBankLoanPublicId: reallocationForm.toBankLoanId,
                amount: normalizeMoney(reallocationForm.amount),
                allocationDate: new Date().toISOString().slice(0, 10),
                note: reallocationForm.note || undefined,
            });
            setReallocationForm({ fromBankLoanId: "", toBankLoanId: "", amount: "", note: "" });
            setShowReallocation(false);
            await loadWorkspace();
        } catch (error: any) {
            setErrorMessage(error?.response?.data?.error || t("matching.errors.reallocate"));
        } finally { setSaving(false); }
    };

    const step = reviewEntries ? 3 : 2;

    return (
        <div className="space-y-5 pb-28">
            <header className="flex flex-wrap items-start justify-between gap-4">
                <div className="flex items-center gap-3">
                    <Link aria-label={t("common.back")} to="/loans" className="inline-flex h-10 w-10 items-center justify-center rounded-md border border-input hover:bg-accent"><ChevronLeft className="h-4 w-4" /></Link>
                    <div><h2 className="text-3xl font-bold tracking-tight">{t("matching.title")}</h2><p className="text-muted-foreground">{t("matching.description")}</p></div>
                </div>
                {currentAllocationByDrawdown.length > 0 && <button type="button" onClick={() => setShowReallocation((value) => !value)} className="text-sm font-medium underline underline-offset-4">{t("matching.wantToReallocate")}</button>}
            </header>

            {errorMessage && <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">{errorMessage}</div>}

            <div className="grid overflow-hidden rounded-lg border bg-card xl:grid-cols-[360px_minmax(0,1fr)]">
                <aside className="border-b xl:border-b-0 xl:border-r">
                    <div className="space-y-3 border-b p-4">
                        <div className="relative"><Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" /><Input type="search" aria-label={t("matching.searchLabel")} placeholder={t("matching.searchPlaceholder")} value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} className="pl-9" /></div>
                        <div className="grid grid-cols-2 rounded-md bg-muted p-1 text-sm">
                            {(["needs", "funded"] as const).map((filter) => <button key={filter} type="button" aria-pressed={loanFilter === filter} onClick={() => setLoanFilter(filter)} className={`rounded px-3 py-2 font-medium ${loanFilter === filter ? "bg-background shadow-sm" : "text-muted-foreground"}`}>{t(`matching.filters.${filter}`)}</button>)}
                        </div>
                    </div>
                    <div className="max-h-[720px] overflow-y-auto">
                        {loading ? <p className="p-5 text-sm text-muted-foreground">{t("matching.loadingLoans")}</p> : filteredLoans.length === 0 ? <p className="p-5 text-sm text-muted-foreground">{searchQuery ? t("matching.noSearchResults") : t("matching.allFunded")}</p> : filteredLoans.map((loan) => {
                            const selected = loan.id === selectedLoanId;
                            return <button key={loan.id} type="button" onClick={() => selectLoan(loan.id)} className={`w-full border-b px-4 py-4 text-left transition-colors ${selected ? "bg-muted/70" : "hover:bg-muted/40"}`}>
                                <div className="flex items-start gap-3"><span className={`mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${selected ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/40"}`}>{selected && <Check className="h-3 w-3" />}</span><span className="min-w-0 flex-1"><span className="block truncate font-medium">{loan.borrowerName}</span><span className="block font-mono text-xs text-muted-foreground">{shortId(loan.id)}</span></span></div>
                                <div className="mt-3 grid grid-cols-2 gap-2 pl-8 text-xs"><span><span className="block text-muted-foreground">{t("loanWizard.columns.principal")}</span>{money(loan.principal)}</span><span><span className="block text-muted-foreground">{t("matching.remainingGap")}</span><strong className={isPositiveMoney(loan.remainingGap ?? "0.00") ? "text-destructive" : "text-emerald-600"}>{money(loan.remainingGap ?? "0.00")}</strong></span></div>
                            </button>;
                        })}
                    </div>
                </aside>

                <main className="min-w-0">
                    <div className="border-b px-5 py-5 lg:px-7">
                        <ol aria-label={t("matching.progressLabel")} className="mx-auto grid max-w-3xl grid-cols-3 text-center text-xs sm:text-sm">
                            {[1, 2, 3].map((number) => <li key={number} className="relative flex flex-col items-center gap-2"><span className={`z-10 inline-flex h-8 w-8 items-center justify-center rounded-full border font-semibold ${number <= step ? "border-primary bg-primary text-primary-foreground" : "bg-background text-muted-foreground"}`}>{number}</span><span className={number === step ? "font-semibold" : "text-muted-foreground"}>{t(`matching.steps.${number}`)}</span>{number < 3 && <span className={`absolute left-[55%] right-[-45%] top-4 h-px ${number < step ? "bg-primary" : "bg-border"}`} />}</li>)}
                        </ol>
                    </div>

                    {!selectedLoan ? <p className="p-8 text-muted-foreground">{t("matching.selectLoanPrompt")}</p> : <>
                        <section className="grid gap-4 border-b px-5 py-5 sm:grid-cols-2 lg:grid-cols-5 lg:px-7">
                            <div className="sm:col-span-2"><span className="text-xs text-muted-foreground">{t("matching.selectedLoan")}</span><div className="font-semibold">{selectedLoan.borrowerName}</div><div className="font-mono text-xs text-muted-foreground">{selectedLoan.id}</div></div>
                            <div><span className="text-xs text-muted-foreground">{t("loanWizard.columns.principal")}</span><div className="font-semibold">{money(selectedLoanPrincipal)}</div></div>
                            <div><span className="text-xs text-muted-foreground">{t("matching.alreadyFunded")}</span><div className="font-semibold text-emerald-600">{money(selectedLoanFundedAmount)}</div></div>
                            <div><span className="text-xs text-muted-foreground">{t("matching.remainingGap")}</span><div className="font-semibold text-destructive">{money(selectedLoanGap)}</div></div>
                        </section>

                        {reviewEntries ? <section className="space-y-5 p-5 lg:p-7">
                            <div><h3 className="text-xl font-semibold">{t("matching.review.title")}</h3><p className="text-sm text-muted-foreground">{t("matching.review.description")}</p></div>
                            <div className="overflow-x-auto rounded-md border"><table className="w-full min-w-[620px] text-sm"><thead className="bg-muted/50 text-left text-xs text-muted-foreground"><tr><th className="px-4 py-3">{t("matching.fundingSource")}</th><th className="px-4 py-3 text-right">{t("matching.allocateAmount")}</th></tr></thead><tbody>{reviewEntries.map((entry) => <tr className="border-t" key={entry.bankLoanPublicId}><td className="px-4 py-4"><div className="font-medium">{bankProfileNameById.get(drawdowns.find((row) => row.id === entry.bankLoanPublicId)?.bankProfileId ?? -1) ?? t("matching.unknownSource")}</div><div className="font-mono text-xs text-muted-foreground">{entry.bankLoanPublicId}</div></td><td className="px-4 py-4 text-right font-semibold">{money(entry.amount)}</td></tr>)}</tbody></table></div>
                            <div className="rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">{t("matching.review.immutableNotice")}</div>
                        </section> : <section className="space-y-4 p-5 lg:p-7">
                            <div><h3 className="text-xl font-semibold">{t("matching.availableDrawdowns")}</h3><p className="text-sm text-muted-foreground">{t("matching.allocateHelp")}</p></div>
                            {drawdowns.length === 0 ? <div className="rounded border border-dashed p-5 text-sm text-muted-foreground">{t("matching.noActiveDrawdowns")}</div> : <div className="overflow-x-auto rounded-md border"><table className="w-full min-w-[720px] text-sm"><thead className="bg-muted/50 text-left text-xs text-muted-foreground"><tr><th className="px-4 py-3">{t("matching.fundingSource")}</th><th className="px-4 py-3 text-right">{t("matching.availableNow")}</th><th className="px-4 py-3">{t("matching.allocateAmount")}</th><th className="px-4 py-3 text-right">{t("matching.afterDraft")}</th></tr></thead><tbody>{drawdowns.map((drawdown) => {
                                const available = drawdown.remainingCapacity ?? "0.00";
                                const draft = moneyInputOrZero(draftAllocations[drawdown.id]);
                                return <tr className="border-t" key={drawdown.id}><td className="px-4 py-4"><div className="font-medium">{drawdown.bankProfileId ? bankProfileNameById.get(drawdown.bankProfileId) ?? t("matching.unknownSource") : t("matching.unknownSource")}</div><div className="font-mono text-xs text-muted-foreground">{shortId(drawdown.id)}</div></td><td className="px-4 py-4 text-right">{money(available)}</td><td className="px-4 py-3"><Input type="number" min="0" step="0.01" aria-label={`${t("matching.allocateAmount")} ${drawdown.id}`} inputMode="decimal" value={draftAllocations[drawdown.id] ?? ""} onChange={(event) => { setDraftAllocations((current) => ({ ...current, [drawdown.id]: event.target.value })); setReviewEntries(null); }} className="w-36" placeholder="0.00" /></td><td className="px-4 py-4 text-right font-medium text-emerald-600">{money(remainingMoney(available, [draft]))}</td></tr>;
                            })}</tbody></table></div>}
                        </section>}

                        {showReallocation && <section className="m-5 space-y-4 rounded-md border p-5 lg:m-7"><h3 className="font-semibold">{t("matching.reallocateFunding")}</h3><div className="grid gap-3 md:grid-cols-2"><select aria-label={t("matching.fromDrawdown")} className="h-10 rounded-md border bg-background px-3 text-sm" value={reallocationForm.fromBankLoanId} onChange={(event) => setReallocationForm((current) => ({ ...current, fromBankLoanId: event.target.value }))}><option value="">{t("matching.selectSource")}</option>{currentAllocationByDrawdown.map((item) => <option key={item.bankLoanPublicId} value={item.bankLoanPublicId}>{item.bankProfileName} · {money(item.amount)}</option>)}</select><select aria-label={t("matching.toDrawdown")} className="h-10 rounded-md border bg-background px-3 text-sm" value={reallocationForm.toBankLoanId} onChange={(event) => setReallocationForm((current) => ({ ...current, toBankLoanId: event.target.value }))}><option value="">{t("matching.selectTarget")}</option>{drawdowns.map((item) => <option key={item.id} value={item.id}>{shortId(item.id)}</option>)}</select><Input aria-label={t("transactionsForm.amount")} value={reallocationForm.amount} onChange={(event) => setReallocationForm((current) => ({ ...current, amount: event.target.value }))} placeholder="0.00" /><Input aria-label={t("transactionsForm.note")} value={reallocationForm.note} onChange={(event) => setReallocationForm((current) => ({ ...current, note: event.target.value }))} /></div><Button onClick={() => void handleReallocate()} disabled={saving}>{t("matching.reallocate")}</Button></section>}

                        <div className="border-t px-5 lg:px-7">
                            <details className="border-b py-4"><summary className="flex cursor-pointer list-none items-center justify-between font-semibold">{t("matching.loanProfitabilitySnapshot")}<ChevronDown className="h-4 w-4" /></summary>{selectedLoanProfitability && <div className="mt-4 grid gap-3 text-sm sm:grid-cols-3"><span>{t("dashboardPage.cards.borrowerRevenue")}<strong className="block">{money(selectedLoanProfitability.borrowerRevenueCollected)}</strong></span><span>{t("dashboardPage.cards.fundCostPaid")}<strong className="block">{money(selectedLoanProfitability.fundCostPaid)}</strong></span><span>{t("matching.gapAfterMatching")}<strong className="block">{money(selectedLoanProfitability.unallocatedPrincipalGap)}</strong></span></div>}</details>
                            <details className="py-4"><summary className="flex cursor-pointer list-none items-center justify-between font-semibold">{t("loanDetail.allocationHistory")}<ChevronDown className="h-4 w-4" /></summary><div className="mt-4 space-y-2">{allocationHistory.length === 0 ? <p className="text-sm text-muted-foreground">{t("matching.noAllocationHistory")}</p> : allocationHistory.map((row) => <div className="flex justify-between gap-3 border-b py-2 text-sm" key={row.id}><span>{row.bankProfileName ?? t("matching.noSource")}<span className="block text-xs text-muted-foreground">{row.allocationDate}</span></span><strong className={isNegativeMoney(row.allocatedAmount) ? "text-destructive" : "text-emerald-600"}>{money(row.allocatedAmount)}</strong></div>)}</div></details>
                        </div>
                    </>}
                </main>
            </div>

            {selectedLoan && <div className="fixed inset-x-0 bottom-0 z-30 border-t bg-background/95 px-4 py-4 shadow-[0_-8px_24px_rgba(0,0,0,0.06)] backdrop-blur md:left-64"><div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4"><div className="flex gap-8"><div><span className="text-xs text-muted-foreground">{t("matching.allocatingNow")}</span><div className="text-xl font-semibold">{money(pendingAllocationTotal)}</div></div><div><span className="text-xs text-muted-foreground">{t("matching.gapAfterMatching")}</span><div className={`text-xl font-semibold ${isPositiveMoney(remainingFundingGap) ? "text-destructive" : "text-emerald-600"}`}>{money(remainingFundingGap)}</div></div></div><div className="flex gap-3">{reviewEntries ? <><Button variant="outline" onClick={() => setReviewEntries(null)} disabled={saving}>{t("common.back")}</Button><Button onClick={() => void confirmAllocations()} disabled={saving}>{saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{t("matching.review.confirm")}</Button></> : <Button onClick={prepareReview} disabled={saving}><span>{t("matching.review.next")}</span><ArrowRight className="ml-2 h-4 w-4" /></Button>}</div></div></div>}
        </div>
    );
}
