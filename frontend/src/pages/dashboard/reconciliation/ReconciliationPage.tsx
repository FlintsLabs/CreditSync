import { useEffect, useState } from "react";
import { api } from "../../../lib/api";
import { Button } from "../../../components/ui/Button";
import { Card, CardContent, CardHeader, CardTitle } from "../../../components/ui/Card";
import { Input } from "../../../components/ui/Input";

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
            setErrorMessage("Unable to load reconciliation workspace right now.");
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
            setErrorMessage(error?.response?.data?.error || "Unable to reconcile borrower transaction.");
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
            setErrorMessage(error?.response?.data?.error || "Unable to reconcile bank repayment.");
        }
    };

    const handleIgnoreUpload = async (uploadId: number) => {
        try {
            await api.post(`/reconciliation/uploads/${uploadId}/ignore`, {
                note: noteDrafts[`upload-${uploadId}`] || undefined,
            });
            await loadData();
        } catch (error: any) {
            setErrorMessage(error?.response?.data?.error || "Unable to ignore upload.");
        }
    };

    return (
        <div className="space-y-6">
            <div className="flex items-center justify-between gap-4">
                <div>
                    <h2 className="text-3xl font-bold tracking-tight">Reconciliation</h2>
                    <p className="text-muted-foreground">Match uploads to borrower payments and fund repayments, or mark items reviewed manually.</p>
                </div>
                <Button variant="outline" onClick={loadData} disabled={loading}>Refresh</Button>
            </div>

            {errorMessage && (
                <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                    {errorMessage}
                </div>
            )}

            <div className="grid gap-4 xl:grid-cols-3">
                <Card>
                    <CardHeader>
                        <CardTitle>Pending Uploads</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                        {loading ? <div className="text-sm text-muted-foreground">Loading...</div> : pendingUploads.length === 0 ? (
                            <div className="rounded border border-dashed p-4 text-sm text-muted-foreground">No pending uploads right now.</div>
                        ) : pendingUploads.map((item) => (
                            <div key={item.id} className="rounded border p-3 text-sm space-y-2">
                                <div className="flex items-center justify-between gap-3">
                                    <div>
                                        <div className="font-medium">Upload #{item.id}</div>
                                        <div className="text-xs text-muted-foreground">{item.source} • {item.senderId || "unknown sender"}</div>
                                    </div>
                                    {item.fileUrl && <a href={item.fileUrl} target="_blank" rel="noreferrer" className="text-primary text-xs hover:underline">Open file</a>}
                                </div>
                                <Input
                                    placeholder="Ignore note"
                                    value={noteDrafts[`upload-${item.id}`] ?? ""}
                                    onChange={(event) => setNoteDrafts((prev) => ({ ...prev, [`upload-${item.id}`]: event.target.value }))}
                                />
                                <Button variant="outline" size="sm" onClick={() => handleIgnoreUpload(item.id)}>Ignore Upload</Button>
                            </div>
                        ))}
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader>
                        <CardTitle>Borrower Transactions</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                        {loading ? <div className="text-sm text-muted-foreground">Loading...</div> : borrowerTransactions.length === 0 ? (
                            <div className="rounded border border-dashed p-4 text-sm text-muted-foreground">All borrower transactions are reconciled.</div>
                        ) : borrowerTransactions.map((item) => (
                            <div key={item.id} className="rounded border p-3 text-sm space-y-2">
                                <div className="flex items-center justify-between gap-3">
                                    <div>
                                        <div className="font-medium">{item.borrowerName || `Loan #${item.loanId}`}</div>
                                        <div className="text-xs text-muted-foreground">{new Date(item.transactionDate).toLocaleDateString()}</div>
                                    </div>
                                    <div className="font-medium">฿{Number(item.amount).toLocaleString()}</div>
                                </div>
                                <select
                                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                                    value={borrowerUploadSelection[item.id] ?? ""}
                                    onChange={(event) => setBorrowerUploadSelection((prev) => ({ ...prev, [item.id]: event.target.value }))}
                                >
                                    <option value="">Manual match without upload</option>
                                    {pendingUploads.map((upload) => (
                                        <option key={upload.id} value={upload.id}>Upload #{upload.id}</option>
                                    ))}
                                </select>
                                <Input
                                    placeholder="Match note"
                                    value={noteDrafts[`borrower-${item.id}`] ?? ""}
                                    onChange={(event) => setNoteDrafts((prev) => ({ ...prev, [`borrower-${item.id}`]: event.target.value }))}
                                />
                                <Button size="sm" onClick={() => handleBorrowerMatch(item.id)}>Mark Reconciled</Button>
                            </div>
                        ))}
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader>
                        <CardTitle>Fund Repayments</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                        {loading ? <div className="text-sm text-muted-foreground">Loading...</div> : bankRepayments.length === 0 ? (
                            <div className="rounded border border-dashed p-4 text-sm text-muted-foreground">All fund repayments are reconciled.</div>
                        ) : bankRepayments.map((item) => (
                            <div key={item.id} className="rounded border p-3 text-sm space-y-2">
                                <div className="flex items-center justify-between gap-3">
                                    <div>
                                        <div className="font-medium">Drawdown #{item.bankLoanId}</div>
                                        <div className="text-xs text-muted-foreground">{new Date(item.paymentDate).toLocaleDateString()}</div>
                                    </div>
                                    <div className="font-medium">฿{Number(item.amount).toLocaleString()}</div>
                                </div>
                                <select
                                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                                    value={bankUploadSelection[item.id] ?? ""}
                                    onChange={(event) => setBankUploadSelection((prev) => ({ ...prev, [item.id]: event.target.value }))}
                                >
                                    <option value="">Manual match without upload</option>
                                    {pendingUploads.map((upload) => (
                                        <option key={upload.id} value={upload.id}>Upload #{upload.id}</option>
                                    ))}
                                </select>
                                <Input
                                    placeholder="Match note"
                                    value={noteDrafts[`bank-${item.id}`] ?? ""}
                                    onChange={(event) => setNoteDrafts((prev) => ({ ...prev, [`bank-${item.id}`]: event.target.value }))}
                                />
                                <Button size="sm" onClick={() => handleBankMatch(item.id)}>Mark Reconciled</Button>
                            </div>
                        ))}
                    </CardContent>
                </Card>
            </div>
        </div>
    );
}
