import { useEffect, useMemo, useState } from "react";
import { api } from "../../../lib/api";
import { Button } from "../../../components/ui/Button";
import { Card, CardHeader, CardTitle, CardContent } from "../../../components/ui/Card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../../../components/ui/dropdown-menu";
import { Plus, FileText, Calendar, MoreHorizontal, DollarSign, ArrowRightLeft } from "lucide-react";
import { Link } from "react-router-dom";
import { cn } from "../../../lib/utils";
import { LoanClosingModal } from "./LoanClosingModal";

interface LoanRow {
    id: number;
    borrowerName: string;
    principal: string | number;
    status: string;
    createdAt: string;
    repaymentType: string;
    fundedAmount?: number;
    allocationState?: string;
    remainingGap?: number;
    realizedSpread?: number;
    unrealizedSpread?: number;
}

function formatCurrency(value: number) {
    return `฿${value.toLocaleString(undefined, {
        minimumFractionDigits: 0,
        maximumFractionDigits: 2,
    })}`;
}

export default function LoanList() {
    const [loans, setLoans] = useState<LoanRow[]>([]);
    const [closingLoanId, setClosingLoanId] = useState<number | null>(null);
    const [search, setSearch] = useState("");
    const [statusFilter, setStatusFilter] = useState("all");
    const [fundingFilter, setFundingFilter] = useState("all");
    const [sortBy, setSortBy] = useState("newest");

    useEffect(() => {
        const fetchLoans = async () => {
            try {
                const res = await api.get("/loans");
                const rawLoans: LoanRow[] = res.data ?? [];
                const enrichedLoans = await Promise.all(
                    rawLoans.map(async (loan) => {
                        const [allocationStateRes, profitabilityRes] = await Promise.all([
                            api.get(`/loans/${loan.id}/allocation-state`),
                            api.get(`/loans/${loan.id}/profitability`),
                        ]);
                        return {
                            ...loan,
                            fundedAmount: Number(allocationStateRes.data?.netAllocatedPrincipal ?? 0),
                            allocationState: allocationStateRes.data?.state,
                            remainingGap: Number(allocationStateRes.data?.remainingGap ?? 0),
                            realizedSpread: Number(profitabilityRes.data?.realizedSpread ?? 0),
                            unrealizedSpread: Number(profitabilityRes.data?.unrealizedSpread ?? 0),
                        };
                    })
                );
                setLoans(enrichedLoans);
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
            const matchesFunding = fundingFilter === "all" || (loan.allocationState ?? "unfunded") === fundingFilter;
            return matchesSearch && matchesStatus && matchesFunding;
        });

        return filtered.sort((a, b) => {
            if (sortBy === "newest") return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
            if (sortBy === "oldest") return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
            if (sortBy === "largest_gap") return Number(b.remainingGap ?? 0) - Number(a.remainingGap ?? 0);
            if (sortBy === "best_spread") return Number(b.realizedSpread ?? 0) - Number(a.realizedSpread ?? 0);
            if (sortBy === "worst_spread") return Number(a.realizedSpread ?? 0) - Number(b.realizedSpread ?? 0);
            return 0;
        });
    }, [fundingFilter, loans, search, sortBy, statusFilter]);

    return (
        <div className="space-y-6">
            <div className="flex items-center justify-between">
                <div>
                    <h2 className="text-3xl font-bold tracking-tight">Loan Agreements</h2>
                    <p className="text-muted-foreground">Manage active contracts and track repayments.</p>
                </div>
                <div className="flex items-center gap-2">
                    <Link to="/dashboard/loans/new">
                        <Button>
                            <Plus className="mr-2 h-4 w-4" /> New Loan
                        </Button>
                    </Link>
                    <Link to="/dashboard/matching">
                        <Button variant="outline">
                            <ArrowRightLeft className="mr-2 h-4 w-4" /> Matching Workspace
                        </Button>
                    </Link>
                </div>
            </div>

            <Card>
                <CardContent className="grid gap-3 pt-6 md:grid-cols-2 xl:grid-cols-4">
                    <div className="grid gap-1.5">
                        <label className="text-sm font-medium">Search</label>
                        <input
                            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                            placeholder="Borrower or loan #"
                            value={search}
                            onChange={(event) => setSearch(event.target.value)}
                        />
                    </div>
                    <div className="grid gap-1.5">
                        <label className="text-sm font-medium">Status</label>
                        <select className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
                            <option value="all">All statuses</option>
                            <option value="active">Active</option>
                            <option value="draft">Draft</option>
                            <option value="paid">Paid</option>
                            <option value="defaulted">Defaulted</option>
                        </select>
                    </div>
                    <div className="grid gap-1.5">
                        <label className="text-sm font-medium">Funding State</label>
                        <select className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={fundingFilter} onChange={(event) => setFundingFilter(event.target.value)}>
                            <option value="all">All funding states</option>
                            <option value="unfunded">Unfunded</option>
                            <option value="partially_funded">Partially funded</option>
                            <option value="fully_funded">Fully funded</option>
                            <option value="overfunded">Overfunded</option>
                        </select>
                    </div>
                    <div className="grid gap-1.5">
                        <label className="text-sm font-medium">Sort</label>
                        <select className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={sortBy} onChange={(event) => setSortBy(event.target.value)}>
                            <option value="newest">Newest first</option>
                            <option value="oldest">Oldest first</option>
                            <option value="largest_gap">Largest gap</option>
                            <option value="best_spread">Best realized spread</option>
                            <option value="worst_spread">Worst realized spread</option>
                        </select>
                    </div>
                </CardContent>
            </Card>

            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {visibleLoans.map((loan) => (
                    <Link key={loan.id} to={`/dashboard/loans/${loan.id}`} className="block">
                    <Card className="hover:shadow-md transition-shadow flex flex-col h-full">
                        <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-2">
                            <div className="space-y-1">
                                <CardTitle className="text-sm font-medium">{loan.borrowerName}</CardTitle>
                                <div className="text-xs text-muted-foreground">Loan #{loan.id}</div>
                            </div>
                           <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                    <Button variant="ghost" className="h-8 w-8 p-0" onClick={(event) => event.preventDefault()}>
                                        <span className="sr-only">Open menu</span>
                                        <MoreHorizontal className="h-4 w-4" />
                                    </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                    <DropdownMenuItem onClick={(event) => {
                                        event.preventDefault();
                                        setClosingLoanId(loan.id);
                                    }}>
                                        <DollarSign className="mr-2 h-4 w-4" />
                                        <span>Calculate Closing Balance</span>
                                    </DropdownMenuItem>
                                </DropdownMenuContent>
                            </DropdownMenu>
                        </CardHeader>
                        <CardContent className="flex-grow flex flex-col justify-between">
                            <div className="space-y-3">
                                <div>
                                    <div className="text-2xl font-bold mb-2">{formatCurrency(Number(loan.principal))}</div>
                                    <p className={cn(
                                        "text-xs font-semibold uppercase",
                                        loan.status === "active" ? "text-green-600" : "text-gray-500"
                                    )}>{loan.status}</p>
                                </div>

                                <div className="grid grid-cols-2 gap-3 text-xs">
                                    <div>
                                        <div className="text-muted-foreground">Funding state</div>
                                        <div className="font-medium capitalize">
                                            {(loan.allocationState ?? "unfunded").replaceAll("_", " ")}
                                        </div>
                                    </div>
                                    <div>
                                        <div className="text-muted-foreground">Remaining gap</div>
                                        <div className={cn(
                                            "font-medium",
                                            Number(loan.remainingGap ?? 0) > 0 ? "text-destructive" : "text-emerald-600"
                                        )}>
                                            {formatCurrency(Number(loan.remainingGap ?? 0))}
                                        </div>
                                    </div>
                                    <div>
                                        <div className="text-muted-foreground">Realized spread</div>
                                        <div className={cn(
                                            "font-medium",
                                            Number(loan.realizedSpread ?? 0) >= 0 ? "text-emerald-600" : "text-destructive"
                                        )}>
                                            {formatCurrency(Number(loan.realizedSpread ?? 0))}
                                        </div>
                                    </div>
                                    <div>
                                        <div className="text-muted-foreground">Unrealized spread</div>
                                        <div className={cn(
                                            "font-medium",
                                            Number(loan.unrealizedSpread ?? 0) >= 0 ? "text-emerald-600" : "text-destructive"
                                        )}>
                                            {formatCurrency(Number(loan.unrealizedSpread ?? 0))}
                                        </div>
                                    </div>
                                </div>
                            </div>

                            <div className="flex items-center text-sm text-muted-foreground mt-4">
                                <Calendar className="mr-2 h-4 w-4 flex-shrink-0" />
                                <span>{new Date(loan.createdAt).toLocaleDateString()}</span>
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
                    <h3 className="text-xl font-semibold">No Active Loans</h3>
                    <p className="text-muted-foreground mt-2 max-w-sm mx-auto">
                        Create your first loan agreement to start tracking principal, interest, and repayments.
                    </p>
                    <Link to="/dashboard/loans/new">
                        <Button className="mt-6 rounded-full shadow-lg">
                            <Plus className="mr-2 h-4 w-4" /> Create Loan
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
