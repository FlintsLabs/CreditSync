import { useEffect, useState } from "react";
import { api } from "../../../lib/api";
import { Button } from "../../../components/ui/button";
import { Plus, ArrowUpRight, FileText } from "lucide-react";
import { Link } from "react-router-dom";

export default function TransactionList() {
    const [transactions, setTransactions] = useState<any[]>([]);

    useEffect(() => {
        const fetch = async () => {
            try {
                const res = await api.get("/transactions");
                setTransactions(res.data);
            } catch (error) {
                console.error("Failed to load transactions");
            }
        };
        fetch();
    }, []);

    return (
        <div className="space-y-6">
            <div className="sticky top-0 z-10 -mx-4 flex h-20 items-center justify-between border-b bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/60 sm:-mx-6 sm:h-24 sm:px-6">
                <div>
                    <h2 className="text-xl font-bold tracking-tight sm:text-3xl">Transactions</h2>
                    <p className="hidden text-sm text-muted-foreground sm:block">Monitor repayment history and flow.</p>
                </div>
                <Link to="/dashboard/transactions/new">
                    <Button className="rounded-full shadow-lg sm:rounded-md sm:shadow-none" size="sm">
                        <Plus className="mr-2 h-4 w-4" />
                        <span className="hidden sm:inline">Record Repayment</span>
                        <span className="sm:hidden">Record</span>
                    </Button>
                </Link>
            </div>

            {transactions.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-center border-2 border-dashed rounded-xl bg-muted/20">
                    <div className="bg-background p-4 rounded-full shadow-sm mb-4">
                        <ArrowUpRight className="h-12 w-12 text-muted-foreground/50" />
                    </div>
                    <h3 className="text-xl font-semibold">No Transactions</h3>
                    <p className="text-muted-foreground mt-2 max-w-sm mx-auto">
                        Repayments and disbursements will appear here once you start processing loans.
                    </p>
                    <Link to="/dashboard/transactions/new">
                        <Button className="mt-6 rounded-full shadow-lg">
                            <Plus className="mr-2 h-4 w-4" /> Record Repayment
                        </Button>
                    </Link>
                </div>
            ) : (
                <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                    {transactions.map((tx) => (
                        <div key={tx.id} className="rounded-xl border bg-card text-card-foreground shadow-sm hover:shadow-md transition-shadow">
                            <div className="p-4 flex flex-row items-center justify-between space-y-0 pb-2">
                                <div className="space-y-1">
                                    <div className="text-sm font-medium">{tx.borrowerName || "Unknown"}</div>
                                    <div className="text-xs text-muted-foreground">{new Date(tx.date).toLocaleDateString()}</div>
                                </div>
                                <div className="flex flex-col items-end gap-1">
                                    <div className="font-semibold text-green-600">+฿{Number(tx.amount).toLocaleString()}</div>
                                    <div className="text-xs text-muted-foreground flex items-center capitalize">
                                        <ArrowUpRight className="mr-1 h-3 w-3 text-green-500" />
                                        {tx.type}
                                    </div>
                                </div>
                            </div>
                            <div className="p-4 pt-0">
                                {tx.slipUrl ? (
                                    <a href={tx.slipUrl} target="_blank" rel="noreferrer" className="text-primary hover:underline flex items-center text-xs mt-2">
                                        <FileText className="h-3 w-3 mr-1" /> View Slip
                                    </a>
                                ) : (
                                    <div className="text-muted-foreground text-xs mt-2">- No Slip -</div>
                                )}
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
