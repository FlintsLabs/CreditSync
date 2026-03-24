import { useParams, useNavigate } from "react-router-dom";
import { ArrowLeft, ArrowUpRight, ArrowDownRight, Download } from "lucide-react";
import { Button } from "../../../components/ui/Button";
import { Card, CardContent, CardHeader, CardTitle } from "../../../components/ui/Card";
import { FundPerformanceChart } from "./FundPerformanceChart";
import { useTranslation } from "react-i18next";
import { cn } from "../../../lib/utils";

// Mock Data for specific Bank Loan
const mockTransactions = [
    { id: 1, date: "2024-06-05", title: "Repayment (Jun)", type: "repayment", amount: -5400, balance: 145000, method: "K-Mobile Banking" },
    { id: 2, date: "2024-05-05", title: "Repayment (May)", type: "repayment", amount: -5400, balance: 150400, method: "K-Mobile Banking" },
    { id: 3, date: "2024-04-05", title: "Repayment (Apr)", type: "repayment", amount: -5400, balance: 155800, method: "K-Mobile Banking" },
    { id: 4, date: "2024-03-15", title: "Loan Disbursement", type: "income", amount: 200000, balance: 200000, method: "Bank Transfer" },
];

export default function FundDetail() {
    const { t } = useTranslation();
    const { id: _id } = useParams();
    const navigate = useNavigate();

    // Mock finding the fund based on ID (In real app, fetch from API)
    const fundName = "TTB Flash Card";
    const fundLimit = 250000;

    // Simulating 2 active loan withdrawals: 30,000 + 70,000
    const utilizedAmount = 30000 + 70000;
    const availableAmount = fundLimit - utilizedAmount;
    const utilizationRate = (utilizedAmount / fundLimit) * 100;

    return (
        <div className="space-y-6">
            <div className="flex items-center gap-4">
                <Button variant="ghost" size="icon" onClick={() => navigate(-1)}>
                    <ArrowLeft className="h-4 w-4" />
                </Button>
                <div>
                    <h2 className="text-2xl font-bold tracking-tight">{fundName}</h2>
                    <p className="text-muted-foreground">{t("fund_detail.revolving_credit")}</p>
                </div>
            </div>

            {/* Credit Limit Overview */}
            <div className="grid gap-4 md:grid-cols-3">
                <Card className="md:col-span-1 border-l-4 border-l-blue-600 bg-blue-50/50">
                    <CardHeader className="pb-2">
                        <CardTitle className="text-sm font-medium text-muted-foreground">{t("fund_detail.available_credit")}</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="text-3xl font-bold text-blue-700">฿{availableAmount.toLocaleString()}</div>
                        <div className="mt-2 text-xs text-muted-foreground">
                            {t("funds.limit")}: ฿{fundLimit.toLocaleString()}
                        </div>
                        {/* Utilization Bar */}
                        <div className="mt-3 h-2 w-full rounded-full bg-blue-200">
                            <div
                                className="h-2 rounded-full bg-blue-600"
                                style={{ width: `${utilizationRate}%` }}
                            />
                        </div>
                        <p className="mt-1 text-xs text-right text-blue-700 font-medium">{utilizationRate.toFixed(0)}% {t("fund_detail.utilization")}</p>
                    </CardContent>
                </Card>

                <Card className="md:col-span-2">
                    <CardHeader className="pb-2">
                        <CardTitle className="text-sm font-medium">{t("fund_detail.active_withdrawals")}</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="space-y-4">
                            {/* Loan 1 */}
                            <div className="flex items-center justify-between border-b pb-2 last:border-0 last:pb-0">
                                <div>
                                    <div className="font-semibold">Withdrawal #1</div>
                                    <div className="text-xs text-muted-foreground">Date: 15 Jan 2024 • Term: 10 Months</div>
                                </div>
                                <div className="text-right">
                                    <div className="font-bold text-rose-600">฿30,000</div>
                                    <div className="text-xs text-muted-foreground">Installment: ฿3,200/mo</div>
                                </div>
                            </div>

                            {/* Loan 2 */}
                            <div className="flex items-center justify-between border-b pb-2 last:border-0 last:pb-0">
                                <div>
                                    <div className="font-semibold">Withdrawal #2</div>
                                    <div className="text-xs text-muted-foreground">Date: 20 Feb 2024 • Term: 24 Months</div>
                                </div>
                                <div className="text-right">
                                    <div className="font-bold text-rose-600">฿70,000</div>
                                    <div className="text-xs text-muted-foreground">Installment: ฿3,500/mo</div>
                                </div>
                            </div>

                            <div className="pt-2 flex justify-end text-sm text-muted-foreground">
                                Total Utilized: <span className="ml-2 font-bold text-rose-600">฿{utilizedAmount.toLocaleString()}</span>
                            </div>
                        </div>
                    </CardContent>
                </Card>
            </div>

            {/* Performance Chart */}
            <FundPerformanceChart />

            {/* Transaction List */}
            <Card>
                <CardHeader className="flex flex-row items-center justify-between">
                    <CardTitle>Transactions</CardTitle>
                    <div className="flex gap-2">
                        <Button variant="outline" size="sm">
                            <Download className="h-4 w-4 mr-2" /> Export
                        </Button>
                    </div>
                </CardHeader>
                <CardContent>
                    <div className="space-y-4">
                        {mockTransactions.map((tx) => (
                            <div key={tx.id} className="flex flex-col sm:flex-row sm:items-center justify-between p-4 border rounded-lg hover:bg-muted/40 transition-colors">
                                <div className="flex items-start gap-4">
                                    <div className={cn(
                                        "p-2 rounded-full",
                                        tx.type === 'income' ? "bg-emerald-100 text-emerald-600" : "bg-rose-100 text-rose-600"
                                    )}>
                                        {tx.type === 'income' ? <ArrowDownRight className="h-5 w-5" /> : <ArrowUpRight className="h-5 w-5" />}
                                    </div>
                                    <div>
                                        <div className="font-semibold">{tx.title}</div>
                                        <div className="text-sm text-muted-foreground">{tx.date} • {tx.method}</div>
                                    </div>
                                </div>
                                <div className="mt-2 sm:mt-0 text-right">
                                    <div className={cn(
                                        "font-bold",
                                        tx.type === 'income' ? "text-emerald-600" : "text-rose-600"
                                    )}>
                                        {tx.type === 'income' ? '+' : ''}{tx.amount.toLocaleString()} ฿
                                    </div>
                                    <div className="text-xs text-muted-foreground">
                                        Balance: ฿{tx.balance.toLocaleString()}
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                </CardContent>
            </Card>
        </div>
    );
}
