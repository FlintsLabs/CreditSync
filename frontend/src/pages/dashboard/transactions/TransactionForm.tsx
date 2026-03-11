import { useState, useEffect } from "react";
import { api } from "../../../lib/api";
import { Button } from "../../../components/ui/Button";
import { Input } from "../../../components/ui/Input";
import { Card, CardHeader, CardTitle, CardContent } from "../../../components/ui/Card";
import { Loader2 } from "lucide-react";
import { useNavigate } from "react-router-dom";

export default function TransactionForm() {
    const navigate = useNavigate();
    const [loans, setLoans] = useState<any[]>([]);
    const [pendingSlips, setPendingSlips] = useState<any[]>([]);
    const [uploading, setUploading] = useState(false);

    // Form State
    const [formData, setFormData] = useState({
        loanId: "",
        amount: "",
        date: new Date().toISOString().split('T')[0],
        notes: "",
        slip: null as File | null,
        botUploadId: ""
    });

    useEffect(() => {
        api.get("/loans").then(res => setLoans(res.data));
        api.get("/transactions/pending-slips").then(res => setPendingSlips(res.data));
    }, []);

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files?.[0]) {
            setFormData(prev => ({ ...prev, slip: e.target.files![0] }));
        }
    };

    const handleSubmit = async () => {
        setUploading(true);
        const data = new FormData();
        data.append("loanId", formData.loanId);
        data.append("amount", formData.amount);
        data.append("date", formData.date);
        data.append("notes", formData.notes);
        if (formData.slip) {
            data.append("slip", formData.slip);
        }
        if (formData.botUploadId) {
            data.append("botUploadId", formData.botUploadId);
        }

        try {
            await api.post("/transactions", data, {
                headers: { "Content-Type": "multipart/form-data" }
            });
            navigate("/dashboard/transactions");
        } catch (error) {
            alert("Record failed");
        } finally {
            setUploading(false);
        }
    };

    return (
        <div className="max-w-md mx-auto space-y-6">
            <h2 className="text-3xl font-bold tracking-tight">Record Repayment</h2>

            <Card>
                <CardHeader>
                    <CardTitle>Transaction Details</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="grid gap-2">
                        <label>Select Loan Agreement</label>
                        <select
                            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                            value={formData.loanId}
                            onChange={e => setFormData({ ...formData, loanId: e.target.value })}
                        >
                            <option value="">Select Loan...</option>
                            {loans.map(l => (
                                <option key={l.id} value={l.id}>
                                    Loop #{l.id} - {l.borrowerName} (Principal: {Number(l.principal).toLocaleString()})
                                </option>
                            ))}
                        </select>
                    </div>

                    <div className="grid gap-2">
                        <label>Amount (฿)</label>
                        <Input type="number" value={formData.amount} onChange={e => setFormData({ ...formData, amount: e.target.value })} />
                    </div>

                    <div className="grid gap-2">
                        <label>Transaction Date</label>
                        <Input type="date" value={formData.date} onChange={e => setFormData({ ...formData, date: e.target.value })} />
                    </div>

                    <div className="grid gap-2">
                        <label>Link Existing Slip (From Line Bot)</label>
                        <select
                            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                            value={formData.botUploadId}
                            onChange={e => setFormData({ ...formData, botUploadId: e.target.value })}
                            disabled={!!formData.slip}
                        >
                            <option value="">None (Upload manual slip below)</option>
                            {pendingSlips.map((slip: any) => (
                                <option key={slip.id} value={slip.id}>
                                    Slip #{slip.id} - {new Date(slip.createdAt).toLocaleString()} (Sender: {slip.senderId})
                                </option>
                            ))}
                        </select>
                    </div>

                    <div className="grid gap-2">
                        <label>Or Upload Slip Image (Optional)</label>
                        <div className="flex items-center gap-2">
                            <Input type="file" onChange={handleFileChange} disabled={!!formData.botUploadId} />
                        </div>
                    </div>

                    <div className="grid gap-2">
                        <label>Notes</label>
                        <Input value={formData.notes} onChange={e => setFormData({ ...formData, notes: e.target.value })} />
                    </div>

                    <Button className="w-full" onClick={handleSubmit} disabled={!formData.loanId || !formData.amount || uploading}>
                        {uploading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                        Confirm Repayment
                    </Button>
                </CardContent>
            </Card>
        </div>
    );
}
