import { useEffect, useState } from "react";
import { api } from "../../../lib/api";
import { Card } from "../../../components/ui/card";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { Loader2, CheckCircle, XCircle } from "lucide-react";
import { useNavigate } from "react-router-dom";

export default function SlipVerificationQueue() {
    const navigate = useNavigate();
    const [uploads, setUploads] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);
    const [loans, setLoans] = useState<any[]>([]);
    const [verifying, setVerifying] = useState<number | null>(null);

    // Form states for each upload
    const [formStates, setFormStates] = useState<Record<number, { loanId: string, amount: string }>>({});

    useEffect(() => {
        fetchUploads();
        fetchLoans();
    }, []);

    const fetchUploads = async () => {
        try {
            const res = await api.get("/transactions/bot-uploads");
            setUploads(res.data);
        } catch (error) {
            console.error("Failed to fetch bot uploads", error);
        } finally {
            setLoading(false);
        }
    };

    const fetchLoans = async () => {
        try {
            const res = await api.get("/loans");
            // Only active loans for selection
            setLoans(res.data.filter((l: any) => l.status === "active"));
        } catch (error) {
            console.error("Failed to fetch loans", error);
        }
    };

    const handleVerify = async (id: number) => {
        const state = formStates[id];
        if (!state?.loanId || !state?.amount) {
            alert("Please select a loan and enter an amount");
            return;
        }

        setVerifying(id);
        try {
            await api.post(`/transactions/bot-uploads/${id}/verify`, {
                loanId: state.loanId,
                amount: state.amount
            });
            // Remove from list
            setUploads(prev => prev.filter(u => u.id !== id));
        } catch (error) {
            console.error("Failed to verify", error);
            alert("Verification failed");
        } finally {
            setVerifying(null);
        }
    };

    const handleReject = async (_id: number) => {
        // Implement rejection if needed. For now just hide from UI or call an endpoint.
        // Actually, we should probably just delete or mark as rejected.
        alert("Reject functionality to be implemented. (Could mark status as discarded)");
    };

    const updateForm = (id: number, field: string, value: string) => {
        setFormStates(prev => ({
            ...prev,
            [id]: {
                ...(prev[id] || { loanId: "", amount: "" }),
                [field]: value
            }
        }));
    };

    if (loading) {
        return <div className="flex justify-center p-8"><Loader2 className="h-8 w-8 animate-spin" /></div>;
    }

    return (
        <div className="space-y-6">
            <div className="flex items-center justify-between">
                <div>
                    <h2 className="text-3xl font-bold tracking-tight">Slip Verification Queue</h2>
                    <p className="text-muted-foreground">Match uploaded bot slips with loans.</p>
                </div>
                <Button variant="outline" onClick={() => navigate("/dashboard/transactions")}>
                    Back to Transactions
                </Button>
            </div>

            {uploads.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-center border-2 border-dashed rounded-xl bg-muted/20">
                    <CheckCircle className="h-12 w-12 text-green-500 mb-4" />
                    <h3 className="text-xl font-semibold">All Caught Up!</h3>
                    <p className="text-muted-foreground mt-2 max-w-sm mx-auto">
                        There are no pending slips to verify from your bots.
                    </p>
                </div>
            ) : (
                <div className="grid gap-6">
                    {uploads.map((upload) => (
                        <Card key={upload.id} className="overflow-hidden">
                            <div className="flex flex-col md:flex-row">
                                {/* Left Side: Slip Image */}
                                <div className="md:w-1/2 bg-muted/20 p-4 flex items-center justify-center border-b md:border-b-0 md:border-r">
                                    {upload.url ? (
                                        <img
                                            src={upload.url}
                                            alt="Slip Preview"
                                            className="max-h-[400px] object-contain rounded shadow-sm"
                                        />
                                    ) : (
                                        <div className="text-muted-foreground">No image available</div>
                                    )}
                                </div>

                                {/* Right Side: Verification Form */}
                                <div className="md:w-1/2 p-6 flex flex-col justify-between">
                                    <div className="space-y-4">
                                        <div>
                                            <h3 className="font-semibold text-lg">Verify Transaction</h3>
                                            <p className="text-sm text-muted-foreground">Source: {upload.source} | Sender: {upload.senderId}</p>
                                        </div>

                                        <div className="space-y-2">
                                            <label className="text-sm font-medium">Select Loan / Borrower</label>
                                            <select
                                                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                                                value={formStates[upload.id]?.loanId || ""}
                                                onChange={(e) => updateForm(upload.id, "loanId", e.target.value)}
                                            >
                                                <option value="">-- Select Loan --</option>
                                                {loans.map(loan => (
                                                    <option key={loan.id} value={loan.id}>
                                                        {loan.borrowerName} - Loan #{loan.id} (฿{Number(loan.principal).toLocaleString()})
                                                    </option>
                                                ))}
                                            </select>
                                        </div>

                                        <div className="space-y-2">
                                            <label className="text-sm font-medium">Verified Amount (฿)</label>
                                            <Input
                                                type="number"
                                                placeholder="e.g. 400"
                                                value={formStates[upload.id]?.amount || ""}
                                                onChange={(e) => updateForm(upload.id, "amount", e.target.value)}
                                            />
                                        </div>
                                    </div>

                                    <div className="flex gap-2 mt-6">
                                        <Button
                                            className="flex-1 bg-green-600 hover:bg-green-700 text-white"
                                            onClick={() => handleVerify(upload.id)}
                                            disabled={verifying === upload.id || !formStates[upload.id]?.loanId || !formStates[upload.id]?.amount}
                                        >
                                            {verifying === upload.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle className="h-4 w-4 mr-2" />}
                                            Confirm Match
                                        </Button>
                                        <Button
                                            variant="destructive"
                                            onClick={() => handleReject(upload.id)}
                                            disabled={verifying === upload.id}
                                        >
                                            <XCircle className="h-4 w-4 mr-2" />
                                            Reject
                                        </Button>
                                    </div>
                                </div>
                            </div>
                        </Card>
                    ))}
                </div>
            )}
        </div>
    );
}
