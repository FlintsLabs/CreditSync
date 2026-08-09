import { useEffect, useState } from "react";
import { api } from "../../../lib/api";
import { Button } from "../../../components/ui/Button";
import { Card, CardContent, CardHeader, CardTitle } from "../../../components/ui/Card";
import { Input } from "../../../components/ui/Input";
import { useTranslation } from "react-i18next";

interface UploadItem {
    id: number;
    source: string;
    senderId: string | null;
    status: string;
    createdAt: string;
    fileUrl: string | null;
}

interface BorrowerTxItem {
    id: number;
    loanId: number;
    borrowerName: string | null;
    amount: string;
    transactionDate: string;
    slipUrl: string | null;
}

interface BankRepaymentItem {
    id: number;
    bankLoanId: number;
    bankProfileId: number | null;
    amount: string;
    paymentDate: string;
    reference: string | null;
}

export default function ReconciliationPage() {
    const { t, i18n } = useTranslation();
    const [loading, setLoading] = useState(true);
    const [errorMessage, setErrorMessage] = useState("");
    const [pendingUploads, setPendingUploads] = useState<UploadItem[]>([]);
    const [borrowerTransactions, setBorrowerTransactions] = useState<BorrowerTxItem[]>([]);
    const [bankRepayments, setBankRepayments] = useState<BankRepaymentItem[]>([]);
    const [borrowerUploadSelection, setBorrowerUploadSelection] = useState<Record<number, string>>({});
    const [bankUploadSelection, setBankUploadSelection] = useState<Record<number, string>>({});
    const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({});

    const loadData = async () => {
        try {
            setLoading(true);
            const res = await api.get("/reconciliation/overview");
            setPendingUploads(res.data?.pendingUploads ?? []);
            setBorrowerTransactions(res.data?.unreconciledBorrowerTransactions ?? []);
            setBankRepayments(res.data?.unreconciledBankRepayments ?? []);
            setErrorMessage("");
        } catch (error) {
            console.error("Failed to load reconciliation overview", error);
            setErrorMessage(t("reconciliation.errors.load", "Unable to load reconciliation workspace right now."));
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        loadData();
    }, []);

    const handleBorrowerMatch = async (transactionId: number) => {
        try {
            await api.post(`/reconciliation/borrower-transactions/${transactionId}/match`, {
                uploadId: borrowerUploadSelection[transactionId] ? Number(borrowerUploadSelection[transactionId]) : undefined,
                note: noteDrafts[`borrower-${transactionId}`] || undefined,
            });
            await loadData();
        } catch (error: any) {
            setErrorMessage(error?.response?.data?.error || t("reconciliation.errors.borrowerMatch", "Unable to reconcile borrower transaction."));
        }
    };

    const handleBankMatch = async (repaymentId: number) => {
        try {
            await api.post(`/reconciliation/bank-repayments/${repaymentId}/match`, {
                uploadId: bankUploadSelection[repaymentId] ? Number(bankUploadSelection[repaymentId]) : undefined,
                note: noteDrafts[`bank-${repaymentId}`] || undefined,
            });
            await loadData();
        } catch (error: any) {
            setErrorMessage(error?.response?.data?.error || t("reconciliation.errors.bankMatch", "Unable to reconcile bank repayment."));
        }
    };

    const handleIgnoreUpload = async (uploadId: number) => {
        try {
            await api.post(`/reconciliation/uploads/${uploadId}/ignore`, {
                note: noteDrafts[`upload-${uploadId}`] || undefined,
            });
            await loadData();
        } catch (error: any) {
            setErrorMessage(error?.response?.data?.error || t("reconciliation.errors.ignoreUpload", "Unable to ignore upload."));
        }
    };

    return (
        <div className="space-y-6">
            <div className="flex items-center justify-between gap-4">
                <div>
                    <h2 className="text-3xl font-bold tracking-tight">{t("reconciliation.title", "Reconciliation")}</h2>
                    <p className="text-muted-foreground">{t("reconciliation.description", "Match uploads to borrower payments and fund repayments, or mark items reviewed manually.")}</p>
                </div>
                <Button variant="outline" onClick={loadData} disabled={loading}>{t("common.refresh", "Refresh")}</Button>
            </div>

            {errorMessage && (
                <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                    {errorMessage}
                </div>
            )}

            <div className="grid gap-4 xl:grid-cols-3">
                <Card>
                    <CardHeader>
                        <CardTitle>{t("reconciliation.pendingUploads", "Pending Uploads")}</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                        {loading ? <div className="text-sm text-muted-foreground">{t("common.loading", "Loading...")}</div> : pendingUploads.length === 0 ? (
                            <div className="rounded border border-dashed p-4 text-sm text-muted-foreground">{t("reconciliation.empty.pendingUploads", "No pending uploads right now.")}</div>
                        ) : pendingUploads.map((item) => (
                            <div key={item.id} className="rounded border p-3 text-sm space-y-2">
                                <div className="flex items-center justify-between gap-3">
                                    <div>
                                        <div className="font-medium">{t("reconciliation.uploadLabel", { defaultValue: "Upload #{{id}}", id: item.id })}</div>
                                        <div className="text-xs text-muted-foreground">{item.source} • {item.senderId || t("reconciliation.unknownSender", "unknown sender")}</div>
                                    </div>
                                    {item.fileUrl && <a href={item.fileUrl} target="_blank" rel="noreferrer" className="text-primary text-xs hover:underline">{t("reconciliation.openFile", "Open file")}</a>}
                                </div>
                                <Input
                                    placeholder={t("reconciliation.ignoreNote", "Ignore note")}
                                    value={noteDrafts[`upload-${item.id}`] ?? ""}
                                    onChange={(event) => setNoteDrafts((prev) => ({ ...prev, [`upload-${item.id}`]: event.target.value }))}
                                />
                                <Button variant="outline" size="sm" onClick={() => handleIgnoreUpload(item.id)}>{t("reconciliation.ignoreUpload", "Ignore Upload")}</Button>
                            </div>
                        ))}
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader>
                        <CardTitle>{t("reconciliation.borrowerTransactions", "Borrower Transactions")}</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                        {loading ? <div className="text-sm text-muted-foreground">{t("common.loading", "Loading...")}</div> : borrowerTransactions.length === 0 ? (
                            <div className="rounded border border-dashed p-4 text-sm text-muted-foreground">{t("reconciliation.empty.borrowerTransactions", "All borrower transactions are reconciled.")}</div>
                        ) : borrowerTransactions.map((item) => (
                            <div key={item.id} className="rounded border p-3 text-sm space-y-2">
                                <div className="flex items-center justify-between gap-3">
                                    <div>
                                        <div className="font-medium">{item.borrowerName || t("loans.loanLabel", { defaultValue: "Loan #{{id}}", id: item.loanId })}</div>
                                        <div className="text-xs text-muted-foreground">{new Date(item.transactionDate).toLocaleDateString(i18n.language)}</div>
                                    </div>
                                    <div className="font-medium">฿{Number(item.amount).toLocaleString(i18n.language)}</div>
                                </div>
                                <select
                                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                                    value={borrowerUploadSelection[item.id] ?? ""}
                                    onChange={(event) => setBorrowerUploadSelection((prev) => ({ ...prev, [item.id]: event.target.value }))}
                                >
                                    <option value="">{t("reconciliation.manualMatch", "Manual match without upload")}</option>
                                    {pendingUploads.map((upload) => (
                                        <option key={upload.id} value={upload.id}>{t("reconciliation.uploadLabel", { defaultValue: "Upload #{{id}}", id: upload.id })}</option>
                                    ))}
                                </select>
                                <Input
                                    placeholder={t("reconciliation.matchNote", "Match note")}
                                    value={noteDrafts[`borrower-${item.id}`] ?? ""}
                                    onChange={(event) => setNoteDrafts((prev) => ({ ...prev, [`borrower-${item.id}`]: event.target.value }))}
                                />
                                <Button size="sm" onClick={() => handleBorrowerMatch(item.id)}>{t("reconciliation.markReconciled", "Mark Reconciled")}</Button>
                            </div>
                        ))}
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader>
                        <CardTitle>{t("reconciliation.fundRepayments", "Fund Repayments")}</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                        {loading ? <div className="text-sm text-muted-foreground">{t("common.loading", "Loading...")}</div> : bankRepayments.length === 0 ? (
                            <div className="rounded border border-dashed p-4 text-sm text-muted-foreground">{t("reconciliation.empty.fundRepayments", "All fund repayments are reconciled.")}</div>
                        ) : bankRepayments.map((item) => (
                            <div key={item.id} className="rounded border p-3 text-sm space-y-2">
                                <div className="flex items-center justify-between gap-3">
                                    <div>
                                        <div className="font-medium">{t("dashboardPage.drawdownLabel", { defaultValue: "Drawdown #{{id}}", id: item.bankLoanId })}</div>
                                        <div className="text-xs text-muted-foreground">{new Date(item.paymentDate).toLocaleDateString(i18n.language)}</div>
                                    </div>
                                    <div className="font-medium">฿{Number(item.amount).toLocaleString(i18n.language)}</div>
                                </div>
                                <select
                                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                                    value={bankUploadSelection[item.id] ?? ""}
                                    onChange={(event) => setBankUploadSelection((prev) => ({ ...prev, [item.id]: event.target.value }))}
                                >
                                    <option value="">{t("reconciliation.manualMatch", "Manual match without upload")}</option>
                                    {pendingUploads.map((upload) => (
                                        <option key={upload.id} value={upload.id}>{t("reconciliation.uploadLabel", { defaultValue: "Upload #{{id}}", id: upload.id })}</option>
                                    ))}
                                </select>
                                <Input
                                    placeholder={t("reconciliation.matchNote", "Match note")}
                                    value={noteDrafts[`bank-${item.id}`] ?? ""}
                                    onChange={(event) => setNoteDrafts((prev) => ({ ...prev, [`bank-${item.id}`]: event.target.value }))}
                                />
                                <Button size="sm" onClick={() => handleBankMatch(item.id)}>{t("reconciliation.markReconciled", "Mark Reconciled")}</Button>
                            </div>
                        ))}
                    </CardContent>
                </Card>
            </div>
        </div>
    );
}
