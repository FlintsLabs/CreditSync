import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "../../../components/ui/Button";
import { Card, CardHeader, CardTitle, CardContent } from "../../../components/ui/Card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../../../components/ui/dropdown-menu";
import { Plus, FileText, Calendar, CalendarDays, MoreHorizontal, DollarSign, ArrowRightLeft, AlertCircle, User, UserCheck, ChevronRight, RotateCw, Wallet, Clock, Receipt, Copy, Check } from "lucide-react";
import { Link } from "react-router-dom";
import { LoanClosingModal } from "./LoanClosingModal";
import { useTranslation } from "react-i18next";
import { formatMoneyExact } from "../../../lib/workflow-model";
import { LoanPaymentHealthBadge, type LoanPaymentHealth } from "./LoanPaymentHealthBadge";
import { Badge } from "../../../components/ui/badge";
import { getUniqueBorrowerTags, getVisibleBorrowerLabels, isDoneLoanStatus, loanMatchesSearch, type BorrowerLabelLoan } from "./loan-list-model";
import { loanListHeaderActionsClassName, loanListHeaderClassName } from "./loan-list-layout";
import { LoanCardFinancialSummary } from "./LoanCardFinancialSummary";
import { fetchLoanList, loanListQueryKey, useLoanQueryRevision } from "../../../lib/loan-query-invalidation";

const currentPaymentHealth: LoanPaymentHealth = {
    status: "current",
    dueTodayAmount: "0.00",
    overdueAmount: "0.00",
    overdueItemCount: 0,
    maxOverdueDays: 0,
};

interface LoanRow {
    id: string;
    publicId: string;
    borrowerPublicId?: string | null;
    borrowerName: string;
    borrowerAliases?: string[] | null;
    borrowerTags?: string[] | null;
    principal: string;
    outstandingPrincipal: string;
    interestReceived: string;
    paidToDate: string;
    status: string;
    createdAt: string;
    repaymentType: string;
    installmentAmount: string | null;
    totalInstallments: number | null;
    startDate: string | null;
    paymentHealth?: LoanPaymentHealth;
    currentAgent?: { name?: string | null; aliases?: string[] | null } | null;
    currentAgentName?: string | null;
    currentAgentAliases?: string[] | null;
}

type LoanTab = "active" | "done" | "all";

export default function LoanList() {
    const { t, i18n } = useTranslation();
    const [loans, setLoans] = useState<LoanRow[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [loadError, setLoadError] = useState(false);
    const [closingLoanId, setClosingLoanId] = useState<string | null>(null);
    const [search, setSearch] = useState("");
    const [loanTab, setLoanTab] = useState<LoanTab>("active");
    const [statusFilter, setStatusFilter] = useState("all");
    const [fundingFilter, setFundingFilter] = useState("all");
    const [sortBy, setSortBy] = useState("newest");
    const [copiedLoanId, setCopiedLoanId] = useState<string | null>(null);
    const [activeBorrowerGroup, setActiveBorrowerGroup] = useState<number | null>(null);
    const loanListRevision = useLoanQueryRevision(loanListQueryKey);

    const retryLoans = useCallback(async () => {
        setIsLoading(true);
        setLoadError(false);
        try {
            setLoans(await fetchLoanList<LoanRow>());
        } catch {
            setLoadError(true);
        } finally {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => {
        let active = true;
        void fetchLoanList<LoanRow>()
            .then((rows) => {
                if (!active) return;
                setLoans(rows);
                setLoadError(false);
            })
            .catch(() => {
                if (active) setLoadError(true);
            })
            .finally(() => {
                if (active) setIsLoading(false);
            });
        return () => { active = false; };
    }, [loanListRevision]);

    const visibleLoans = useMemo(() => {
        const filtered = loans.filter((loan) => {
            const isDone = isDoneLoanStatus(loan.status);
            const matchesTab = loanTab === "all" || (loanTab === "done" ? isDone : !isDone);
            const matchesSearch = loanMatchesSearch(loan as BorrowerLabelLoan, search);
            const matchesStatus = statusFilter === "all" || loan.status === statusFilter;
            const matchesFunding = fundingFilter === "all";
            return matchesTab && matchesSearch && matchesStatus && matchesFunding;
        });

        return filtered.sort((a, b) => {
            if (sortBy === "newest") return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
            if (sortBy === "oldest") return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
            return 0;
        });
    }, [fundingFilter, loanTab, loans, search, sortBy, statusFilter]);

    const groupedVisibleLoans = useMemo(() => {
        const groups = new Map<string, { borrowerName: string; loans: LoanRow[] }>();
        for (const loan of visibleLoans) {
            // Missing identifiers stay isolated so different borrowers are never merged by name.
            const groupKey = loan.borrowerPublicId ?? `loan:${loan.id}`;
            const group = groups.get(groupKey);
            if (group) {
                group.loans.push(loan);
            } else {
                groups.set(groupKey, { borrowerName: loan.borrowerName, loans: [loan] });
            }
        }
        return [...groups.values()];
    }, [visibleLoans]);

    useEffect(() => {
        if (typeof IntersectionObserver === "undefined") return;
        const sections = groupedVisibleLoans
            .map((_, groupIndex) => document.getElementById(`borrower-group-${groupIndex}`))
            .filter((section): section is HTMLElement => section !== null);
        if (sections.length === 0) return;

        const observer = new IntersectionObserver(
            (entries) => {
                const visibleEntry = entries
                    .filter((entry) => entry.isIntersecting)
                    .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
                if (!visibleEntry) return;
                const groupIndex = sections.indexOf(visibleEntry.target as HTMLElement);
                if (groupIndex >= 0) setActiveBorrowerGroup(groupIndex);
            },
            { rootMargin: "-96px 0px -65% 0px", threshold: 0 },
        );

        sections.forEach((section) => observer.observe(section));
        return () => observer.disconnect();
    }, [groupedVisibleLoans]);

    return (
        <div className="space-y-6">
            <div className={loanListHeaderClassName}>
                <div className="min-w-0">
                    <h2 className="text-3xl font-bold tracking-tight">{t("loans.title", "Loan Agreements")}</h2>
                    <p className="text-muted-foreground">{t("loans.description", "Manage active contracts and track repayments.")}</p>
                </div>
                <div className={loanListHeaderActionsClassName}>
                    <Link to="/loans/new">
                        <Button>
                            <Plus className="mr-2 h-4 w-4" /> {t("loans.new", "New Loan")}
                        </Button>
                    </Link>
                    <Link to="/matching">
                        <Button variant="outline">
                            <ArrowRightLeft className="mr-2 h-4 w-4" /> {t("matching.title", "Matching Workspace")}
                        </Button>
                    </Link>
                </div>
            </div>

            <div className="inline-flex rounded-lg border bg-muted/30 p-1" role="tablist" aria-label={t("loans.tabs.label", "Loan status tabs")}>
                {(["active", "done", "all"] as const).map((tab) => (
                    <button
                        key={tab}
                        type="button"
                        role="tab"
                        aria-selected={loanTab === tab}
                        className={`rounded-md px-4 py-2 text-sm font-medium transition-colors ${loanTab === tab ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
                        onClick={() => {
                            setLoanTab(tab);
                            setStatusFilter("all");
                        }}
                    >
                        {t(`loans.tabs.${tab}`, tab === "active" ? "Active" : tab === "done" ? "Done" : "All")}
                    </button>
                ))}
            </div>

            <Card>
                <CardContent className="grid gap-3 pt-6 md:grid-cols-2 xl:grid-cols-4">
                    <div className="grid gap-1.5">
                        <label className="text-sm font-medium">{t("common.search", "Search")}</label>
                        <input
                            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                            placeholder={t("loans.search", "Borrower or loan #")}
                            value={search}
                            onChange={(event) => setSearch(event.target.value)}
                        />
                    </div>
                    <div className="grid gap-1.5">
                        <label className="text-sm font-medium">{t("common.status", "Status")}</label>
                        <select className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
                            <option value="all">{t("loans.filters.allStatuses", "All statuses")}</option>
                            {(loanTab === "all" ? ["active", "draft", "paid", "closed", "replaced", "restructured", "defaulted", "pending", "problem"] : loanTab === "done" ? ["paid", "closed", "replaced", "restructured"] : ["active", "draft", "defaulted"]).map((status) => (
                                <option key={status} value={status}>{t(`loans.status.${status}`, status)}</option>
                            ))}
                        </select>
                    </div>
                    <div className="grid gap-1.5">
                        <label className="text-sm font-medium">{t("loans.fundingState", "Funding State")}</label>
                        <select className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={fundingFilter} onChange={(event) => setFundingFilter(event.target.value)}>
                            <option value="all">{t("loans.filters.allFundingStates", "All funding states")}</option>
                            <option value="unfunded">{t("loans.funding.unfunded", "Unfunded")}</option>
                            <option value="partially_funded">{t("loans.funding.partiallyFunded", "Partially funded")}</option>
                            <option value="fully_funded">{t("loans.funding.fullyFunded", "Fully funded")}</option>
                            <option value="overfunded">{t("loans.funding.overfunded", "Overfunded")}</option>
                        </select>
                    </div>
                    <div className="grid gap-1.5">
                        <label className="text-sm font-medium">{t("common.sort", "Sort")}</label>
                        <select className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={sortBy} onChange={(event) => setSortBy(event.target.value)}>
                            <option value="newest">{t("loans.sort.newest", "Newest first")}</option>
                            <option value="oldest">{t("loans.sort.oldest", "Oldest first")}</option>
                            <option value="largest_gap">{t("loans.sort.largestGap", "Largest gap")}</option>
                            <option value="best_spread">{t("loans.sort.bestSpread", "Best realized spread")}</option>
                            <option value="worst_spread">{t("loans.sort.worstSpread", "Worst realized spread")}</option>
                        </select>
                    </div>
                </CardContent>
            </Card>

            <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_18rem]">
                <div className="order-2 min-w-0 xl:order-1">
                    <div className="space-y-8">
                {groupedVisibleLoans.map((group, groupIndex) => (
                    <section
                        key={group.loans[0]?.borrowerPublicId ?? `group-${groupIndex}`}
                        id={`borrower-group-${groupIndex}`}
                        aria-labelledby={group.loans.length > 1 ? `borrower-group-heading-${groupIndex}` : undefined}
                        aria-label={group.loans.length === 1 ? group.borrowerName : undefined}
                        className="scroll-mt-6 space-y-3"
                    >
                        <div className="flex items-baseline gap-2 border-b border-border/60 pb-2">
                            {group.loans.length > 1 && (
                                <h3 id={`borrower-group-heading-${groupIndex}`} className="text-lg font-semibold tracking-tight text-foreground">
                                    {group.borrowerName}
                                </h3>
                            )}
                            <span className="text-sm text-muted-foreground">
                                {t("loans.borrowerGroup.loanCount", { count: group.loans.length })}
                            </span>
                        </div>
                        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3" data-testid="loan-card-grid">
                            {group.loans.map((loan) => {
                    const labelState = getVisibleBorrowerLabels(loan);
                    const agentName = loan.currentAgent?.name ?? loan.currentAgentName;
                    const isUnassigned = !agentName;
                    const formattedStartDate = loan.startDate
                        ? new Intl.DateTimeFormat(i18n.language, {
                              day: "numeric",
                              month: "short",
                              year: "numeric",
                              timeZone: "Asia/Bangkok",
                          }).format(new Date(`${loan.startDate}T00:00:00+07:00`))
                        : t("loans.notSet", "Not set");
                    const formattedCreatedAt = new Intl.DateTimeFormat(i18n.language, {
                        day: "numeric",
                        month: "short",
                        year: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                        hour12: false,
                        timeZone: "Asia/Bangkok",
                    }).format(new Date(loan.createdAt));
                    const loanPublicId = loan.publicId ?? loan.id;
                    const shortenedLoanId = loanPublicId.length > 12
                        ? `${loanPublicId.slice(0, 8)}…${loanPublicId.slice(-3)}`
                        : loanPublicId;

                    return (
                        <Link key={loan.id} to={`/loans/${loan.publicId ?? loan.id}`} className="block group">
                            <Card className="hover:shadow-md transition-all flex flex-col h-full border-border/80 hover:border-primary/30 rounded-2xl">
                                <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-3 gap-2">
                                    <div className="flex items-start gap-3 min-w-0 flex-1 pr-1">
                                        <div className="w-10 h-10 rounded-full bg-blue-100 dark:bg-blue-950/60 text-blue-600 dark:text-blue-400 flex items-center justify-center shrink-0 mt-0.5 shadow-xs">
                                            <User className="h-5 w-5" />
                                        </div>
                                        <div className="space-y-1 min-w-0 flex-1">
                                            <CardTitle className="text-base font-bold leading-tight tracking-tight text-foreground truncate group-hover:text-primary transition-colors">
                                                {loan.borrowerName}
                                            </CardTitle>
                                            {labelState.visible.length > 0 && (
                                                <div className="flex flex-wrap items-center gap-1 pt-0.5">
                                                    {labelState.visible.map((label) => (
                                                        <Badge key={label} variant="outline" className="h-5 px-2 text-[11px] font-normal text-muted-foreground rounded-full bg-muted/30">
                                                            {label}
                                                        </Badge>
                                                    ))}
                                                    {labelState.overflow > 0 && (
                                                        <span
                                                            aria-label={t("loans.borrowerLabels.more", { count: labelState.overflow })}
                                                            className="inline-flex items-center rounded-full border border-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground"
                                                        >
                                                            +{labelState.overflow}
                                                        </span>
                                                    )}
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                    <DropdownMenu>
                                        <DropdownMenuTrigger asChild>
                                            <Button variant="ghost" className="h-8 w-8 p-0 shrink-0 text-muted-foreground hover:text-foreground" onClick={(event) => event.preventDefault()}>
                                                <span className="sr-only">{t("common.openMenu", "Open menu")}</span>
                                                <MoreHorizontal className="h-4 w-4" />
                                            </Button>
                                        </DropdownMenuTrigger>
                                        <DropdownMenuContent align="end">
                                            <DropdownMenuItem onClick={(event) => {
                                                event.preventDefault();
                                                setClosingLoanId(loan.id);
                                            }}>
                                                <DollarSign className="mr-2 h-4 w-4" />
                                                <span>{t("loans.calculateClosingBalance", "Calculate Closing Balance")}</span>
                                            </DropdownMenuItem>
                                        </DropdownMenuContent>
                                    </DropdownMenu>
                                </CardHeader>
                                <CardContent className="flex-grow flex flex-col justify-between pt-0 gap-3">
                                    <div className="space-y-3">
                                        {/* Collection-critical problem / health indicator */}
                                        <LoanPaymentHealthBadge
                                            health={loan.paymentHealth ?? currentPaymentHealth}
                                            repaymentType={loan.repaymentType}
                                        />

                                        {/* Principal & balance summary */}
                                        <LoanCardFinancialSummary
                                            status={loan.status}
                                            outstandingPrincipal={loan.outstandingPrincipal}
                                            originalPrincipal={loan.principal}
                                            interestReceived={loan.interestReceived}
                                            paidToDate={loan.paidToDate}
                                        />

                                        {/* Contract details 2-column grid with circular icon badges */}
                                        <div className="rounded-xl border border-border/50 bg-muted/15 p-2.5 sm:p-3 grid grid-cols-2 gap-2.5 text-xs">
                                            <div className="flex items-start gap-2 min-w-0">
                                                <div className="w-7 h-7 sm:w-8 sm:h-8 rounded-lg bg-blue-50 dark:bg-blue-950/50 text-blue-600 dark:text-blue-400 flex items-center justify-center shrink-0 mt-0.5">
                                                    <RotateCw className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                                                </div>
                                                <div className="min-w-0 flex-1">
                                                    <div className="text-muted-foreground text-[11px] font-medium">{t("loans.repaymentType", "Repayment type")}</div>
                                                    <div className="font-semibold text-foreground truncate">{t(`loanWizard.repaymentOptions.${loan.repaymentType}`)}</div>
                                                </div>
                                            </div>
                                            <div className="flex items-start gap-2 min-w-0">
                                                <div className="w-7 h-7 sm:w-8 sm:h-8 rounded-lg bg-blue-50 dark:bg-blue-950/50 text-blue-600 dark:text-blue-400 flex items-center justify-center shrink-0 mt-0.5">
                                                    <Wallet className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                                                </div>
                                                <div className="min-w-0 flex-1">
                                                    <div className="text-muted-foreground text-[11px] font-medium">{t("loans.installment", "Installment")}</div>
                                                    <div className="font-semibold text-foreground tabular-nums truncate">
                                                        {loan.repaymentType === "floating"
                                                            ? t("loans.noSchedule", "No fixed schedule")
                                                            : formatMoneyExact(loan.installmentAmount ?? "0.00", i18n.language)}
                                                    </div>
                                                </div>
                                            </div>
                                            <div className="flex items-start gap-2 min-w-0">
                                                <div className="w-7 h-7 sm:w-8 sm:h-8 rounded-lg bg-blue-50 dark:bg-blue-950/50 text-blue-600 dark:text-blue-400 flex items-center justify-center shrink-0 mt-0.5">
                                                    <CalendarDays className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                                                </div>
                                                <div className="min-w-0 flex-1">
                                                    <div className="text-muted-foreground text-[11px] font-medium">{t("loans.installmentsCountLabel", "Count")}</div>
                                                    <div className="font-medium text-foreground truncate">
                                                        {loan.repaymentType === "floating"
                                                            ? <span className="text-muted-foreground">{t("loans.noFixedSchedule", "Floating repayment has no fixed schedule")}</span>
                                                            : t("loans.installmentsCount", { count: loan.totalInstallments ?? 0 })}
                                                    </div>
                                                </div>
                                            </div>
                                            <div className="flex items-start gap-2 min-w-0">
                                                <div className="w-7 h-7 sm:w-8 sm:h-8 rounded-lg bg-blue-50 dark:bg-blue-950/50 text-blue-600 dark:text-blue-400 flex items-center justify-center shrink-0 mt-0.5">
                                                    <Calendar className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                                                </div>
                                                <div className="min-w-0 flex-1">
                                                    <div className="text-muted-foreground text-[11px] font-medium">{t("loans.startDate", "Start date")}</div>
                                                    <div className="font-medium text-foreground truncate">{formattedStartDate}</div>
                                                </div>
                                            </div>
                                        </div>

                                        {/* Agent / Collector Assignment */}
                                        {isUnassigned ? (
                                            <div className="flex items-center justify-between rounded-xl border border-rose-200/80 bg-rose-50/40 p-2.5 sm:p-3 text-xs gap-2 dark:border-rose-900/40 dark:bg-rose-950/20">
                                                <div className="flex items-center gap-2.5 min-w-0">
                                                    <div className="w-7 h-7 sm:w-8 sm:h-8 rounded-lg bg-rose-100 text-rose-600 flex items-center justify-center shrink-0 dark:bg-rose-950/60 dark:text-rose-400">
                                                        <User className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                                                    </div>
                                                    <div className="min-w-0">
                                                        <div className="font-semibold text-rose-700 dark:text-rose-400 truncate">
                                                            {t("loans.agent.unassigned", "Unassigned")}
                                                        </div>
                                                        <div className="text-[11px] text-muted-foreground truncate">
                                                            {t("loans.agent.unassignedSubtext", "Assign an agent to manage this borrower")}
                                                        </div>
                                                    </div>
                                                </div>
                                                <span className="inline-flex items-center gap-1 rounded-lg border border-rose-300 bg-background px-2.5 py-1 text-xs font-semibold text-rose-700 shadow-xs hover:bg-rose-50 transition-colors shrink-0 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300 dark:hover:bg-rose-900/30">
                                                    {t("loans.agent.assignAction", "Assign")}
                                                    <ChevronRight className="h-3.5 w-3.5" />
                                                </span>
                                            </div>
                                        ) : (
                                            <div className="flex items-center justify-between rounded-xl border border-border/60 bg-muted/20 p-2.5 sm:p-3 text-xs gap-2">
                                                <div className="flex items-center gap-2.5 min-w-0">
                                                    <div className="w-7 h-7 sm:w-8 sm:h-8 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
                                                        <UserCheck className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                                                    </div>
                                                    <div className="min-w-0">
                                                        <div className="text-[11px] text-muted-foreground font-medium">{t("loans.agent.label", "Agent")}</div>
                                                        <div className="font-semibold text-foreground truncate">{agentName}</div>
                                                    </div>
                                                </div>
                                                {(loan.currentAgent?.aliases ?? loan.currentAgentAliases ?? []).length > 0 && (
                                                    <div className="flex gap-1 shrink-0">
                                                        {(loan.currentAgent?.aliases ?? loan.currentAgentAliases ?? [])
                                                            .filter(Boolean)
                                                            .map((alias) => (
                                                                <Badge key={alias} variant="secondary" className="text-[10px] px-1.5 py-0 h-4 font-normal">
                                                                    {alias}
                                                                </Badge>
                                                            ))}
                                                    </div>
                                                )}
                                            </div>
                                        )}
                                    </div>

                                    {/* Footer metadata: Created at and Loan ID */}
                                    <div className="flex items-center justify-between text-[11px] text-muted-foreground pt-2.5 border-t border-border/40">
                                        <div className="flex items-center gap-1.5 truncate">
                                            <Clock className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
                                            <span>{t("loans.createdAt", "Created at")}: {formattedCreatedAt}</span>
                                        </div>
                                        <div className="flex items-center gap-1.5 shrink-0 pl-2 min-w-0">
                                            <Receipt className="h-3.5 w-3.5 text-muted-foreground/70" />
                                            <span title={loanPublicId} className="truncate">{t("loans.loanLabel", { id: shortenedLoanId })}</span>
                                            <button
                                                type="button"
                                                className="shrink-0 rounded p-1 hover:bg-muted"
                                                aria-label={t("loans.copyLoanId", "Copy loan ID")}
                                                title={t("loans.copyLoanId", "Copy loan ID")}
                                                onClick={(event) => {
                                                    event.preventDefault();
                                                    event.stopPropagation();
                                                    void navigator.clipboard.writeText(loanPublicId).then(() => {
                                                        setCopiedLoanId(loanPublicId);
                                                        window.setTimeout(() => setCopiedLoanId(null), 2000);
                                                    });
                                                }}
                                            >
                                                {copiedLoanId === loanPublicId ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
                                            </button>
                                            {copiedLoanId === loanPublicId && <span className="sr-only">{t("loans.copied", "Copied")}</span>}
                                        </div>
                                    </div>
                                </CardContent>
                            </Card>
                        </Link>
                    );
                            })}
                        </div>
                    </section>
                ))}
                    </div>

            {isLoading && (
                <div className="py-16 text-center text-muted-foreground" role="status">
                    {t("loans.loading", "Loading loans...")}
                </div>
            )}

            {loadError && !isLoading && (
                <div className="flex flex-col items-center justify-center py-16 text-center border-2 border-dashed rounded-xl bg-muted/20" role="alert">
                    <div className="bg-background p-4 rounded-full shadow-sm mb-4">
                        <AlertCircle className="h-12 w-12 text-destructive" />
                    </div>
                    <h3 className="text-xl font-semibold">{t("loans.loadErrorTitle", "Unable to load loans")}</h3>
                    <p className="text-muted-foreground mt-2 max-w-sm mx-auto">
                        {t("loans.loadErrorDescription", "Check your connection and try again.")}
                    </p>
                    <Button className="mt-6" variant="outline" onClick={() => void retryLoans()}>
                        {t("loans.retry", "Try again")}
                    </Button>
                </div>
            )}

            {!isLoading && !loadError && visibleLoans.length === 0 && (
                <div className="flex flex-col items-center justify-center py-16 text-center border-2 border-dashed rounded-xl bg-muted/20">
                    <div className="bg-background p-4 rounded-full shadow-sm mb-4">
                        <FileText className="h-12 w-12 text-muted-foreground/50" />
                    </div>
                    <h3 className="text-xl font-semibold">{loanTab === "done" ? t("loans.emptyDoneTitle", "No Done Loans") : t("loans.emptyTitle", "No Active Loans")}</h3>
                    <p className="text-muted-foreground mt-2 max-w-sm mx-auto">
                        {t("loans.emptyDescription", "Create your first loan agreement to start tracking principal, interest, and repayments.")}
                    </p>
                    <Link to="/loans/new">
                        <Button className="mt-6 rounded-full shadow-lg">
                            <Plus className="mr-2 h-4 w-4" /> {t("loans.create", "Create Loan")}
                        </Button>
                    </Link>
                </div>
            )}
                </div>

                {!isLoading && !loadError && groupedVisibleLoans.length > 0 && (
                    <aside className="order-1 xl:order-2 xl:fixed xl:right-8 xl:top-24 xl:z-20 xl:w-72" aria-label={t("loans.borrowerNavigation.ariaLabel", "Borrower navigation")}>
                        <Card>
                            <CardHeader className="pb-3">
                                <CardTitle className="text-base">{t("loans.borrowerNavigation.title", "Borrowers")}</CardTitle>
                            </CardHeader>
                            <CardContent className="pt-0">
                                <nav aria-label={t("loans.borrowerNavigation.ariaLabel", "Borrower navigation")} className="max-h-[min(70vh,44rem)] space-y-1 overflow-y-auto pr-1">
                                    {groupedVisibleLoans.map((group, groupIndex) => {
                                        const tags = getUniqueBorrowerTags(group.loans);
                                        const hasOverdueLoan = group.loans.some((loan) => loan.paymentHealth?.status === "overdue" || (loan.paymentHealth?.overdueItemCount ?? 0) > 0);
                                        const isActive = activeBorrowerGroup === groupIndex || (activeBorrowerGroup === null && groupIndex === 0);
                                        return (
                                            <button
                                                key={group.loans[0]?.borrowerPublicId ?? `group-${groupIndex}`}
                                                type="button"
                                                aria-current={isActive ? "true" : undefined}
                                                className={`w-full rounded-lg border px-3 py-2 text-left transition-colors ${isActive ? "border-primary/40 bg-primary/5" : "border-transparent hover:border-border hover:bg-muted/50"}`}
                                                onClick={() => {
                                                    setActiveBorrowerGroup(groupIndex);
                                                    document.getElementById(`borrower-group-${groupIndex}`)?.scrollIntoView?.({ behavior: "smooth", block: "start" });
                                                }}
                                            >
                                                <span className="flex min-w-0 items-center gap-1.5 text-sm font-semibold text-foreground">
                                                    <span className="truncate">{group.borrowerName}</span>
                                                    {hasOverdueLoan && (
                                                        <span role="img" aria-label={t("loans.borrowerNavigation.overdue", "Has overdue payments")} className="shrink-0 text-destructive">
                                                            <AlertCircle className="h-4 w-4" />
                                                        </span>
                                                    )}
                                                </span>
                                                <span className="mt-0.5 block text-xs text-muted-foreground">{t("loans.borrowerGroup.loanCount", { count: group.loans.length })}</span>
                                                {tags.length > 0 ? (
                                                    <span className="mt-1.5 flex flex-wrap gap-1">
                                                        {tags.map((tag) => <Badge key={tag} variant="secondary" className="px-1.5 py-0 text-[10px] font-normal">{tag}</Badge>)}
                                                    </span>
                                                ) : (
                                                    <span className="mt-1.5 block text-[11px] text-muted-foreground">{t("loans.borrowerNavigation.noTags", "No tags")}</span>
                                                )}
                                            </button>
                                        );
                                    })}
                                </nav>
                            </CardContent>
                        </Card>
                    </aside>
                )}
            </div>

            {closingLoanId && (
                <LoanClosingModal
                    loanId={closingLoanId}
                    open={closingLoanId !== null}
                    onOpenChange={() => setClosingLoanId(null)}
                />
            )}
        </div>
    );
}
