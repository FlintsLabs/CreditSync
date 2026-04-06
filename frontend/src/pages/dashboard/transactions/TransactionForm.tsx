import { useEffect, useMemo, useState } from "react";
import { api } from "../../../lib/api";
import { Button } from "../../../components/ui/Button";
import { Input } from "../../../components/ui/Input";
import { Card, CardHeader, CardTitle, CardContent } from "../../../components/ui/Card";
import { Loader2 } from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";

interface LoanOption {
    id: number;
    borrowerName: string;
    principal: string | number;
    nextDueDate?: string | null;
    outstandingPrincipal?: string | null;
    status?: string;
}

interface LoanScheduleItem {
    id: number;
    installmentNo: number;
    dueDate: string;
    remainingDue: string;
    penaltyDue?: string;
    totalDueNow?: string;
    overdueDays?: number;
    status: string;
}

export default function TransactionForm() {
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const [loans, setLoans] = useState<LoanOption[]>([]);
    const [scheduleItems, setScheduleItems] = useState<LoanScheduleItem[]>([]);
    const [uploading, setUploading] = useState(false);
    const [loadingSchedule, setLoadingSchedule] = useState(false);
    const [errorMessage, setErrorMessage] = useState("");

    const [formData, setFormData] = useState({
        loanId: searchParams.get("loanId") ?? "",
        scheduleId: searchParams.get("scheduleId") ?? "",
        amount: "",
        date: new Date().toISOString().split("T")[0],
        notes: "",
        slip: null as File | null
    });

    useEffect(() => {
        api.get("/loans")
            .then((res) => setLoans(res.data ?? []))
            .catch(() => setErrorMessage("Unable to load loans."));
    }, []);

    useEffect(() => {
        const loadSchedule = async () => {
            if (!formData.loanId) {
                setScheduleItems([]);
                return;
            }

            try {
                setLoadingSchedule(true);
                const res = await api.get(`/loans/${formData.loanId}/schedule`);
                const items = (res.data ?? []).filter((item: LoanScheduleItem) => Number(item.remainingDue) > 0);
                setScheduleItems(items);
                const requestedScheduleId = searchParams.get("scheduleId");
                const requestedItem = requestedScheduleId
                    ? items.find((item: LoanScheduleItem) => String(item.id) === requestedScheduleId)
                    : null;

                if (requestedItem) {
                    setFormData((prev) => ({
                        ...prev,
                        scheduleId: String(requestedItem.id),
                        amount: requestedItem.totalDueNow ?? requestedItem.remainingDue,
                    }));
                } else if (items.length > 0) {
                    setFormData((prev) => ({
                        ...prev,
                        scheduleId: String(items[0].id),
                        amount: items[0].totalDueNow ?? items[0].remainingDue,
                    }));
                } else {
                    setFormData((prev) => ({ ...prev, scheduleId: "", amount: "" }));
                }
            } catch (error) {
                console.error("Failed to load loan schedule", error);
                setErrorMessage("Unable to load borrower schedule.");
            } finally {
                setLoadingSchedule(false);
            }
        };

        loadSchedule();
    }, [formData.loanId, searchParams]);

    const selectedSchedule = useMemo(
        () => scheduleItems.find((item) => String(item.id) === formData.scheduleId),
        [scheduleItems, formData.scheduleId]
    );

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files?.[0]) {
            setFormData((prev) => ({ ...prev, slip: e.target.files![0] }));
        }
    };

    const handleSubmit = async () => {
        setUploading(true);
        setErrorMessage("");

        const data = new FormData();
        data.append("loanId", formData.loanId);
        data.append("amount", formData.amount);
        data.append("date", formData.date);
        data.append("notes", formData.notes);
        if (formData.scheduleId) {
            data.append("scheduleId", formData.scheduleId);
        }
        if (formData.slip) {
            data.append("slip", formData.slip);
        }

        try {
            await api.post("/transactions", data, {
                headers: { "Content-Type": "multipart/form-data" }
            });
            navigate("/dashboard/transactions");
        } catch (error: any) {
            console.error("Record failed", error);
            setErrorMessage(error?.response?.data?.error || "Record failed");
        } finally {
            setUploading(false);
        }
    };

    return (
        <div className="max-w-md mx-auto space-y-6">
            <h2 className="text-3xl font-bold tracking-tight">Record Repayment</h2>

            {errorMessage && (
                <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                    {errorMessage}
                </div>
            )}

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
                            onChange={(e) => setFormData({ ...formData, loanId: e.target.value })}
                        >
                            <option value="">Select Loan...</option>
                            {loans.map((l) => (
                                <option key={l.id} value={l.id}>
                                    Loan #{l.id} - {l.borrowerName} (Principal: {Number(l.principal).toLocaleString()})
                                </option>
                            ))}
                        </select>
                    </div>

                    <div className="grid gap-2">
                        <label>Installment</label>
                        <select
                            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                            value={formData.scheduleId}
                            onChange={(e) => {
                                const next = scheduleItems.find((item) => String(item.id) === e.target.value);
                                setFormData((prev) => ({
                                    ...prev,
                                    scheduleId: e.target.value,
                                    amount: next ? (next.totalDueNow ?? next.remainingDue) : prev.amount,
                                }));
                            }}
                            disabled={!formData.loanId || loadingSchedule || scheduleItems.length === 0}
                        >
                            <option value="">{loadingSchedule ? "Loading..." : "No schedule selected"}</option>
                            {scheduleItems.map((item) => (
                                <option key={item.id} value={item.id}>
                                    #{item.installmentNo} • {item.dueDate} • Due now ฿{Number(item.totalDueNow ?? item.remainingDue).toLocaleString()}
                                </option>
                            ))}
                        </select>
                    </div>

                    {selectedSchedule && (
                        <div className="rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">
                            Due date: {selectedSchedule.dueDate} • Due now: ฿{Number(selectedSchedule.totalDueNow ?? selectedSchedule.remainingDue).toLocaleString()} • Penalty: ฿{Number(selectedSchedule.penaltyDue ?? 0).toLocaleString()}
                        </div>
                    )}

                    <div className="grid gap-2">
                        <label>Amount (฿)</label>
                        <Input type="number" value={formData.amount} onChange={(e) => setFormData({ ...formData, amount: e.target.value })} />
                    </div>

                    <div className="grid gap-2">
                        <label>Transaction Date</label>
                        <Input type="date" value={formData.date} onChange={(e) => setFormData({ ...formData, date: e.target.value })} />
                    </div>

                    <div className="grid gap-2">
                        <label>Slip Image (Optional)</label>
                        <Input type="file" onChange={handleFileChange} />
                    </div>

                    <div className="grid gap-2">
                        <label>Notes</label>
                        <Input value={formData.notes} onChange={(e) => setFormData({ ...formData, notes: e.target.value })} />
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
