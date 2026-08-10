import { useEffect, useMemo, useState } from "react";
import { api } from "../../../lib/api";
import { Button } from "../../../components/ui/Button";
import { Card, CardHeader, CardTitle, CardContent } from "../../../components/ui/Card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../../../components/ui/dropdown-menu";
import { Plus, FileText, Calendar, MoreHorizontal, DollarSign, ArrowRightLeft } from "lucide-react";
import { Link } from "react-router-dom";
import { cn } from "../../../lib/utils";
import { LoanClosingModal } from "./LoanClosingModal";
import { useTranslation } from "react-i18next";
import { formatMoneyExact } from "../../../lib/workflow-model";

interface LoanRow {
    id: string;
    publicId: string;
    borrowerName: string;
    principal: string;
    outstandingPrincipal: string;
    status: string;
    createdAt: string;
    repaymentType: string;
    installmentAmount: string | null;
    totalInstallments: number | null;
    startDate: string | null;
}

export default function LoanList() {
    const { t, i18n } = useTranslation();
    const [loans, setLoans] = useState<LoanRow[]>([]);
    const [closingLoanId, setClosingLoanId] = useState<string | null>(null);
    const [search, setSearch] = useState("");
    const [statusFilter, setStatusFilter] = useState("all");
    const [fundingFilter, setFundingFilter] = useState("all");
    const [sortBy, setSortBy] = useState("newest");

    useEffect(() => {
        const fetchLoans = async () => {
            try {
                const res = await api.get("/loans");
                setLoans(res.data ?? []);
            } catch (error) {
                console.error("Failed to load loans");
            }
        };
        fetchLoans();
    }, []);

    const visibleLoans = useMemo(() => {
        const searchText = search.trim().toLowerCase();
        const filtered = loans.filter((loan) => {
            const matchesSearch =
                !searchText ||
                loan.borrowerName?.toLowerCase().includes(searchText) ||
                String(loan.id).includes(searchText);
            const matchesStatus = statusFilter === "all" || loan.status === statusFilter;
            const matchesFunding = fundingFilter === "all";
            return matchesSearch && matchesStatus && matchesFunding;
        });

        return filtered.sort((a, b) => {
            if (sortBy === "newest") return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
            if (sortBy === "oldest") return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
            return 0;
        });
    }, [fundingFilter, loans, search, sortBy, statusFilter]);

    return (
        <div className="space-y-6">
            <div className="flex items-center justify-between">
                <div>
                    <h2 className="text-3xl font-bold tracking-tight">{t("loans.title", "Loan Agreements")}</h2>
                    <p className="text-muted-foreground">{t("loans.description", "Manage active contracts and track repayments.")}</p>
                </div>
                <div className="flex items-center gap-2">
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
                            <option value="active">{t("loans.status.active", "Active")}</option>
                            <option value="draft">{t("loans.status.draft", "Draft")}</option>
                            <option value="paid">{t("loans.status.paid", "Paid")}</option>
                            <option value="defaulted">{t("loans.status.defaulted", "Defaulted")}</option>
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

            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {visibleLoans.map((loan) => (
                    <Link key={loan.id} to={`/loans/${loan.publicId ?? loan.id}`} className="block">
                    <Card className="hover:shadow-md transition-shadow flex flex-col h-full">
                        <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-2">
                            <div className="space-y-1">
                                <CardTitle className="text-sm font-medium">{loan.borrowerName}</CardTitle>
                                <div className="text-xs text-muted-foreground">{t("loans.loanLabel", { defaultValue: "Loan #{{id}}", id: loan.id })}</div>
                            </div>
                           <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                    <Button variant="ghost" className="h-8 w-8 p-0" onClick={(event) => event.preventDefault()}>
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
                        <CardContent className="flex-grow flex flex-col justify-between">
                            <div className="space-y-3">
                                <div>
                                    <div className="text-2xl font-bold">{formatMoneyExact(loan.outstandingPrincipal, i18n.language)}</div>
                                    <p className="mt-1 mb-2 text-xs text-muted-foreground">
                                        / {t("loans.originalPrincipal", "Original principal")} {formatMoneyExact(loan.principal, i18n.language)}
                                    </p>
                                    <p className={cn(
                                        "text-xs font-semibold uppercase",
                                        loan.status === "active" ? "text-green-600" : "text-gray-500"
                                    )}>{loan.status}</p>
                                </div>

                                <div className="space-y-2 text-xs">
                                    <div><div className="text-muted-foreground">{t("loans.repaymentType", "Repayment type")}</div><div className="font-medium">{t(`loanWizard.repaymentOptions.${loan.repaymentType}`)}</div></div>
                                    {loan.repaymentType === "floating" ? <div className="text-muted-foreground">{t("loans.noFixedSchedule", "Floating repayment has no fixed schedule")}</div> : <div className="font-medium">{t("loans.installmentSummary", { amount: formatMoneyExact(loan.installmentAmount ?? "0.00", i18n.language), count: loan.totalInstallments ?? 0 })}</div>}
                                    <div><div className="text-muted-foreground">{t("loans.startDate", "Start date")}</div><div className="font-medium">{loan.startDate ? new Intl.DateTimeFormat(i18n.language, { timeZone: "Asia/Bangkok" }).format(new Date(`${loan.startDate}T00:00:00+07:00`)) : t("loans.notSet", "Not set")}</div></div>
                                </div>
                            </div>

                            <div className="flex items-center text-sm text-muted-foreground mt-4">
                                <Calendar className="mr-2 h-4 w-4 flex-shrink-0" />
                                <span>{t("loans.createdAt", "Created at")}: {new Intl.DateTimeFormat(i18n.language, { dateStyle: "short", timeStyle: "short", timeZone: "Asia/Bangkok" }).format(new Date(loan.createdAt))}</span>
                            </div>
                        </CardContent>
                    </Card>
                    </Link>
                ))}
            </div>

            {visibleLoans.length === 0 && (
                <div className="flex flex-col items-center justify-center py-16 text-center border-2 border-dashed rounded-xl bg-muted/20">
                    <div className="bg-background p-4 rounded-full shadow-sm mb-4">
                        <FileText className="h-12 w-12 text-muted-foreground/50" />
                    </div>
                    <h3 className="text-xl font-semibold">{t("loans.emptyTitle", "No Active Loans")}</h3>
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
