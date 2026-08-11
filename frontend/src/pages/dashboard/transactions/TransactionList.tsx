import { useEffect, useState } from "react";
import { api } from "../../../lib/api";
import { Button } from "../../../components/ui/Button";
import { Plus, ArrowUpRight, FileText } from "lucide-react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import Decimal from "decimal.js";

function transactionAmountTone(amount: string): "text-green-600" | "text-red-600" | "" {
    const value = new Decimal(amount);
    if (value.isNegative() && !value.isZero()) return "text-red-600";
    if (value.isPositive() && !value.isZero()) return "text-green-600";
    return "";
}

export default function TransactionList() {
    const { t, i18n } = useTranslation();
    const [transactions, setTransactions] = useState<any[]>([]);

    useEffect(() => {
        const fetch = async () => {
            try {
                const res = await api.get("/transactions");
                setTransactions(res.data ?? []);
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
                    <h2 className="text-3xl font-bold tracking-tight">{t("transactions.title", "Transactions")}</h2>
                    <p className="text-muted-foreground">{t("transactions.description", "Monitor repayment history and component breakdown.")}</p>
                </div>
                <Link to="/transactions/new">
                    <Button>
                        <Plus className="mr-2 h-4 w-4" /> {t("transactions.recordRepayment", "Record Repayment")}
                    </Button>
                </Link>
            </div>

            {transactions.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-center border-2 border-dashed rounded-xl bg-muted/20">
                    <div className="bg-background p-4 rounded-full shadow-sm mb-4">
                        <ArrowUpRight className="h-12 w-12 text-muted-foreground/50" />
                    </div>
                    <h3 className="text-xl font-semibold">{t("transactions.emptyTitle", "No Transactions")}</h3>
                    <p className="text-muted-foreground mt-2 max-w-sm mx-auto">
                        {t("transactions.emptyDescription", "Repayments and disbursements will appear here once you start processing loans.")}
                    </p>
                    <Link to="/transactions/new">
                        <Button className="mt-6 rounded-full shadow-lg">
                            <Plus className="mr-2 h-4 w-4" /> {t("transactions.recordRepayment", "Record Repayment")}
                        </Button>
                    </Link>
                </div>
            ) : (
                <div className="rounded-md border bg-card overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="border-b bg-muted/50 text-left">
                                <th className="p-4 font-medium">{t("transactions.columns.date", "Date")}</th>
                                <th className="p-4 font-medium">{t("transactions.columns.borrower", "Borrower")}</th>
                                <th className="p-4 font-medium">{t("transactions.columns.total", "Total")}</th>
                                <th className="p-4 font-medium">{t("transactions.columns.principal", "Principal")}</th>
                                <th className="p-4 font-medium">{t("transactions.columns.interest", "Interest")}</th>
                                <th className="p-4 font-medium">{t("transactions.columns.fee", "Fee")}</th>
                                <th className="p-4 font-medium">{t("transactions.columns.penalty", "Penalty")}</th>
                                <th className="p-4 font-medium">{t("transactions.columns.slip", "Slip")}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {transactions.map((tx) => (
                                <tr key={tx.id} className="border-b last:border-0 hover:bg-muted/50">
                                    <td className="p-4">{new Date(tx.date).toLocaleDateString(i18n.language)}</td>
                                    <td className="p-4">{tx.borrowerName || t("common.unknown", "Unknown")}</td>
                                    <td
                                        data-testid={`transaction-total-${tx.id}`}
                                        className={`p-4 font-semibold ${transactionAmountTone(String(tx.amount))}`.trim()}
                                    >
                                        ฿{Number(tx.amount).toLocaleString(i18n.language)}
                                    </td>
                                    <td className="p-4">฿{Number(tx.principalComponent ?? 0).toLocaleString(i18n.language)}</td>
                                    <td className="p-4">฿{Number(tx.interestComponent ?? 0).toLocaleString(i18n.language)}</td>
                                    <td className="p-4">฿{Number(tx.feeComponent ?? 0).toLocaleString(i18n.language)}</td>
                                    <td className="p-4">฿{Number(tx.penaltyComponent ?? 0).toLocaleString(i18n.language)}</td>
                                    <td className="p-4">
                                        {tx.slipUrl ? (
                                            <a href={tx.slipUrl} target="_blank" rel="noreferrer" className="text-primary hover:underline flex items-center">
                                                <FileText className="h-4 w-4 mr-1" /> {t("common.view", "View")}
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
