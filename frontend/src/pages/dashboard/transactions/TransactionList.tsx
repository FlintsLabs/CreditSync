import { useEffect, useState } from "react";
import { api } from "../../../lib/api";
import { Button } from "../../../components/ui/Button";
import { Card, CardHeader, CardTitle, CardContent } from "../../../components/ui/Card";
import { Plus, ArrowUpRight, FileText } from "lucide-react";
import { Link } from "react-router-dom";
import { cn } from "../../../lib/utils";

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
            <div className="flex items-center justify-between">
                <div>
                    <h2 className="text-3xl font-bold tracking-tight">Transactions</h2>
                    <p className="text-muted-foreground">Monitor repayment history and flow.</p>
                </div>
                <Link to="/dashboard/transactions/new">
                    <Button>
                        <Plus className="mr-2 h-4 w-4" /> Record Repayment
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
                <div className="rounded-md border bg-card">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="border-b bg-muted/50 text-left">
                                <th className="p-4 font-medium">Date</th>
                                <th className="p-4 font-medium">Type</th>
                                <th className="p-4 font-medium">Borrower</th>
                                <th className="p-4 font-medium">Amount</th>
                                <th className="p-4 font-medium">Slip</th>
                            </tr>
                        </thead>
                        <tbody>
                            {transactions.map((tx) => (
                                <tr key={tx.id} className="border-b last:border-0 hover:bg-muted/50">
                                    <td className="p-4">{new Date(tx.date).toLocaleDateString()}</td>
                                    <td className="p-4 capitalize">
                                        <span className="flex items-center">
                                            <ArrowUpRight className="mr-2 h-4 w-4 text-green-500" />
                                            {tx.type}
                                        </span>
                                    </td>
                                    <td className="p-4">{tx.borrowerName || "Unknown"}</td>
                                    <td className="p-4 font-semibold text-green-600">
                                        +฿{Number(tx.amount).toLocaleString()}
                                    </td>
                                    <td className="p-4">
                                        {tx.slipUrl ? (
                                            <a href={tx.slipUrl} target="_blank" rel="noreferrer" className="text-primary hover:underline flex items-center">
                                                <FileText className="h-4 w-4 mr-1" /> View
                                            </a>
                                        ) : (
                                            <span className="text-muted-foreground">-</span>
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}
