import { useEffect, useMemo, useState } from "react";
import { api } from "../../../lib/api";
import { Button } from "../../../components/ui/Button";
import { Input } from "../../../components/ui/Input";
import { Card, CardHeader, CardTitle, CardContent } from "../../../components/ui/Card";
import { Loader2 } from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { createPaymentWorkflow, type HttpClient } from "../../../lib/workflow-api";

interface LoanOption {
    id: string;
    publicId: string;
    borrowerPublicId: string;
    borrowerName: string;
    principal: string | number;
    nextDueDate?: string | null;
    outstandingPrincipal?: string | null;
    status?: string;
}

interface LoanScheduleItem {
    id: string;
    publicId: string;
    installmentNo: number;
    dueDate: string;
    remainingDue: string;
    penaltyDue?: string;
    totalDueNow?: string;
    overdueDays?: number;
    status: string;
}

export default function TransactionForm() {
    const { t, i18n } = useTranslation();
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
        notes: ""
    });

    useEffect(() => {
        api.get("/loans")
            .then((res) => setLoans(res.data ?? []))
            .catch(() => setErrorMessage(t("transactionsForm.errors.loadLoans", "Unable to load loans.")));
    }, [t]);

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
                    ? items.find((item: LoanScheduleItem) => String(item.publicId ?? item.id) === requestedScheduleId)
                    : null;

                if (requestedItem) {
                    setFormData((prev) => ({
                        ...prev,
                        scheduleId: String(requestedItem.publicId ?? requestedItem.id),
                        amount: requestedItem.totalDueNow ?? requestedItem.remainingDue,
                    }));
                } else if (items.length > 0) {
                    setFormData((prev) => ({
                        ...prev,
                        scheduleId: String(items[0].publicId ?? items[0].id),
                        amount: items[0].totalDueNow ?? items[0].remainingDue,
                    }));
                } else {
                    setFormData((prev) => ({ ...prev, scheduleId: "", amount: "" }));
                }
            } catch (error) {
                console.error("Failed to load loan schedule", error);
                setErrorMessage(t("transactionsForm.errors.loadSchedule", "Unable to load borrower schedule."));
            } finally {
                setLoadingSchedule(false);
            }
        };

        loadSchedule();
    }, [formData.loanId, searchParams, t]);

    const selectedSchedule = useMemo(
        () => scheduleItems.find((item) => String(item.publicId ?? item.id) === formData.scheduleId),
        [scheduleItems, formData.scheduleId]
    );

    const handleSubmit = async () => {
        setUploading(true);
        setErrorMessage("");

        try {
            const selectedLoan = loans.find((loan) => loan.publicId === formData.loanId);
            if (!selectedLoan) throw new Error(t("transactionsForm.errors.selectLoan"));
            const result = await createPaymentWorkflow(api as unknown as HttpClient, {
                amount: formData.amount,
                receivedAt: new Date(`${formData.date}T12:00:00`).toISOString(),
                payerName: selectedLoan.borrowerName,
                notes: formData.notes,
                allocation: {
                    borrowerPublicId: selectedLoan.borrowerPublicId,
                    loanPublicId: selectedLoan.publicId,
                    ...(formData.scheduleId ? { schedulePublicId: formData.scheduleId } : {}),
                    amount: formData.amount,
                },
            });
            if (result.duplicate) {
                setErrorMessage(t("transactionsForm.errors.duplicate"));
                return;
            }
            if (result.status !== "posted") {
                setErrorMessage(t("transactionsForm.errors.needsReview"));
                navigate("/payments");
                return;
            }
            navigate("/payments");
        } catch (error: unknown) {
            console.error("Record failed", error);
            const apiError = error as { response?: { data?: { error?: string } } };
            setErrorMessage(apiError.response?.data?.error || (error instanceof Error ? error.message : t("transactionsForm.errors.recordFailed", "Record failed")));
        } finally {
            setUploading(false);
        }
    };

    return (
        <div className="max-w-md mx-auto space-y-6">
            <h2 className="text-3xl font-bold tracking-tight">{t("transactionsForm.title", "Record Repayment")}</h2>

            {errorMessage && (
                <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                    {errorMessage}
                </div>
            )}

            <Card>
                <CardHeader>
                    <CardTitle>{t("transactionsForm.details", "Transaction Details")}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="grid gap-2">
                        <label>{t("transactionsForm.loan", "Select Loan Agreement")}</label>
                        <select
                            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                            value={formData.loanId}
                            onChange={(e) => setFormData({ ...formData, loanId: e.target.value })}
                        >
                            <option value="">{t("transactionsForm.selectLoan", "Select Loan...")}</option>
                            {loans.map((l) => (
                                <option key={l.id} value={l.publicId ?? l.id}>
                                    {t("transactionsForm.loanOption", { defaultValue: "Loan #{{id}} - {{name}} (Principal: {{amount}})", id: l.id, name: l.borrowerName, amount: Number(l.principal).toLocaleString(i18n.language) })}
                                </option>
                            ))}
                        </select>
                    </div>

                    <div className="grid gap-2">
                        <label>{t("transactionsForm.installment", "Installment")}</label>
                        <select
                            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                            value={formData.scheduleId}
                            onChange={(e) => {
                                const next = scheduleItems.find((item) => String(item.publicId ?? item.id) === e.target.value);
                                setFormData((prev) => ({
                                    ...prev,
                                    scheduleId: e.target.value,
                                    amount: next ? (next.totalDueNow ?? next.remainingDue) : prev.amount,
                                }));
                            }}
                            disabled={!formData.loanId || loadingSchedule || scheduleItems.length === 0}
                        >
                            <option value="">{loadingSchedule ? t("common.loading", "Loading...") : t("transactionsForm.noSchedule", "No schedule selected")}</option>
                            {scheduleItems.map((item) => (
                                <option key={item.id} value={item.publicId ?? item.id}>
                                    #{item.installmentNo} • {item.dueDate} • {t("transactionsForm.dueNow", "Due now")} ฿{Number(item.totalDueNow ?? item.remainingDue).toLocaleString(i18n.language)}
                                </option>
                            ))}
                        </select>
                    </div>

                    {selectedSchedule && (
                        <div className="rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">
                            {t("transactionsForm.scheduleSummary", {
                                defaultValue: "Due date: {{dueDate}} • Due now: ฿{{dueNow}} • Penalty: ฿{{penalty}}",
                                dueDate: selectedSchedule.dueDate,
                                dueNow: Number(selectedSchedule.totalDueNow ?? selectedSchedule.remainingDue).toLocaleString(i18n.language),
                                penalty: Number(selectedSchedule.penaltyDue ?? 0).toLocaleString(i18n.language),
                            })}
                        </div>
                    )}

                    <div className="grid gap-2">
                        <label>{t("transactionsForm.amount", "Amount (฿)")}</label>
                        <Input type="number" value={formData.amount} onChange={(e) => setFormData({ ...formData, amount: e.target.value })} />
                    </div>

                    <div className="grid gap-2">
                        <label>{t("transactionsForm.date", "Transaction Date")}</label>
                        <Input type="date" value={formData.date} onChange={(e) => setFormData({ ...formData, date: e.target.value })} />
                    </div>

                    <div className="grid gap-2">
                        <label>{t("transactionsForm.notes", "Notes")}</label>
                        <Input value={formData.notes} onChange={(e) => setFormData({ ...formData, notes: e.target.value })} />
                    </div>

                    <p className="text-xs text-muted-foreground">{t("transactionsForm.intakeNotice")}</p>

                    <Button className="w-full" onClick={handleSubmit} disabled={!formData.loanId || !formData.amount || uploading}>
                        {uploading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                        {t("transactionsForm.submit", "Confirm Repayment")}
                    </Button>
                </CardContent>
            </Card>
        </div>
    );
}
