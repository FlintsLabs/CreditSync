import { useEffect, useState } from "react";
import { api } from "../../../lib/api";
import { Button } from "../../../components/ui/Button";
import { Card, CardHeader, CardTitle, CardContent } from "../../../components/ui/Card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../../../components/ui/dropdown-menu";
import { Plus, FileText, Calendar, MoreHorizontal, DollarSign } from "lucide-react";
import { Link } from "react-router-dom";
import { cn } from "../../../lib/utils";
import { LoanClosingModal } from "./LoanClosingModal";

export default function LoanList() {
    const [loans, setLoans] = useState<any[]>([]);
    const [closingLoanId, setClosingLoanId] = useState<string | null>(null);

    useEffect(() => {
        const fetchLoans = async () => {
            try {
                const res = await api.get("/loans");
                setLoans(res.data);
            } catch (error) {
                console.error("Failed to load loans");
            }
        };
        fetchLoans();
    }, []);

    return (
        <div className="space-y-6">
            <div className="flex items-center justify-between">
                <div>
                    <h2 className="text-3xl font-bold tracking-tight">Loan Agreements</h2>
                    <p className="text-muted-foreground">Manage active contracts and track repayments.</p>
                </div>
                <Link to="/dashboard/loans/new">
                    <Button>
                        <Plus className="mr-2 h-4 w-4" /> New Loan
                    </Button>
                </Link>
            </div>

            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {loans.map((loan) => (
                    <Card key={loan.id} className="hover:shadow-md transition-shadow flex flex-col">
                        <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-2">
                            <div className="space-y-1">
                                <CardTitle className="text-sm font-medium">{loan.borrowerName}</CardTitle>
                                <div className="text-xs text-muted-foreground">Loan #{loan.id}</div>
                            </div>
                           <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                    <Button variant="ghost" className="h-8 w-8 p-0">
                                        <span className="sr-only">Open menu</span>
                                        <MoreHorizontal className="h-4 w-4" />
                                    </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                    <DropdownMenuItem onClick={() => setClosingLoanId(String(loan.id))}>
                                        <DollarSign className="mr-2 h-4 w-4" />
                                        <span>Calculate Closing Balance</span>
                                    </DropdownMenuItem>
                                </DropdownMenuContent>
                            </DropdownMenu>
                        </CardHeader>
                        <CardContent className="flex-grow flex flex-col justify-between">
                            <div>
                                <div className="text-2xl font-bold mb-2">฿{Number(loan.principal).toLocaleString()}</div>
                                <p className={cn(
                                    "text-xs font-semibold uppercase",
                                    loan.status === "active" ? "text-green-600" : "text-gray-500"
                                )}>{loan.status}</p>
                            </div>

                            <div className="flex items-center text-sm text-muted-foreground mt-4">
                                <Calendar className="mr-2 h-4 w-4 flex-shrink-0" />
                                <span>{new Date(loan.createdAt).toLocaleDateString()}</span>
                            </div>
                        </CardContent>
                    </Card>
                ))}
            </div>

            {loans.length === 0 && (
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
