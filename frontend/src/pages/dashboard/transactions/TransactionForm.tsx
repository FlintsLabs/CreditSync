import { useEffect, useMemo, useState } from "react";
import { api } from "../../../lib/api";
import { Button } from "../../../components/ui/Button";
import { Input } from "../../../components/ui/Input";
import { Card, CardHeader, CardTitle, CardContent } from "../../../components/ui/Card";
import { Loader2 } from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { createPaymentWorkflow, type HttpClient } from "../../../lib/workflow-api";
import { formatMoneyExact } from "../../../lib/workflow-model";

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

interface BorrowerOption {
    publicId: string;
    name: string;
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
    const [borrowers, setBorrowers] = useState<BorrowerOption[]>([]);
    const [scheduleItems, setScheduleItems] = useState<LoanScheduleItem[]>([]);
    const [uploading, setUploading] = useState(false);
    const [loadingSchedule, setLoadingSchedule] = useState(false);
    const [errorMessage, setErrorMessage] = useState("");

    const [formData, setFormData] = useState({
        borrowerId: searchParams.get("borrowerId") ?? "",
        loanId: searchParams.get("loanId") ?? "",
        scheduleId: searchParams.get("scheduleId") ?? "",
        amount: "",
        receivedAt: new Date().toISOString().slice(0, 16),
        bankReference: "",
        notes: "",
    });

    useEffect(() => {
        Promise.all([api.get("/borrowers"), api.get("/loans")])
            .then(([borrowerRes, loanRes]) => {
                const loadedLoans = (loanRes.data ?? []).filter((loan: LoanOption) => loan.status === "active");
                setBorrowers(borrowerRes.data ?? []);
                setLoans(loadedLoans);
                const requestedLoanId = searchParams.get("loanId");
                const requestedLoan = loadedLoans.find((loan: LoanOption) => loan.publicId === requestedLoanId);
                if (requestedLoan) {
                    setFormData((previous) => ({ ...previous, borrowerId: requestedLoan.borrowerPublicId, loanId: requestedLoan.publicId }));
                }
            })
            .catch(() => setErrorMessage(t("transactionsForm.errors.loadLoans", "Unable to load loans.")));
    }, [searchParams, t]);

    const borrowerLoans = useMemo(
        () => formData.borrowerId
            ? loans.filter((loan) => loan.borrowerPublicId === formData.borrowerId)
            : [],
        [formData.borrowerId, loans]
    );

    const selectBorrower = (borrowerId: string) => {
        const matchingLoans = loans.filter((loan) => loan.borrowerPublicId === borrowerId);
        setFormData((previous) => ({
            ...previous,
            borrowerId,
            loanId: matchingLoans.length === 1 ? matchingLoans[0]!.publicId : "",
            scheduleId: "",
            amount: "",
        }));
    };

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
                receivedAt: new Date(formData.receivedAt).toISOString(),
                payerName: selectedLoan.borrowerName,
                bankReference: formData.bankReference,
                notes: formData.notes,
                originLoanPublicId: selectedLoan.publicId,
            });
            if (result.duplicate) {
                setErrorMessage(t("transactionsForm.errors.duplicate"));
                return;
            }
            const reviewParams = new URLSearchParams({ intake: result.publicId, loanId: selectedLoan.publicId });
            if (formData.scheduleId) reviewParams.set("scheduleId", formData.scheduleId);
            navigate(`/payments?${reviewParams.toString()}`);
        } catch (error: unknown) {
            console.error("Record failed", error);
            const code = (error as { response?: { data?: { code?: string } } }).response?.data?.code;
            setErrorMessage(code
                ? t(`domainErrors.${code}`, { defaultValue: t("transactionsForm.errors.recordFailed", "Record failed") })
                : (error instanceof Error ? error.message : t("transactionsForm.errors.recordFailed", "Record failed")));
        } finally {
            setUploading(false);
        }
    };

    return (
        <div className="max-w-md mx-auto space-y-6">
            <h2 className="text-3xl font-bold tracking-tight">{t("transactionsForm.title", "Record Repayment")}</h2>

            {errorMessage && (
                <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                    {errorMessage}
                </div>
            )}

            <Card>
                <CardHeader>
                    <CardTitle>{t("transactionsForm.details", "Transaction Details")}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="grid gap-2">
                        <label htmlFor="borrower">{t("transactionsForm.borrower", "Borrower")}</label>
                        <select
                            id="borrower"
                            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                            value={formData.borrowerId}
                            onChange={(event) => selectBorrower(event.target.value)}
                        >
                            <option value="">{t("transactionsForm.selectBorrower", "Select borrower...")}</option>
                            {borrowers.map((borrower) => <option key={borrower.publicId} value={borrower.publicId}>{borrower.name}</option>)}
                        </select>
                    </div>

                    <div className="grid gap-2">
                        <label htmlFor="loan">{t("transactionsForm.loan", "Select Loan Agreement")}</label>
                        <select
                            id="loan"
                            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                            value={formData.loanId}
                            disabled={!formData.borrowerId}
                            onChange={(e) => setFormData({ ...formData, loanId: e.target.value, scheduleId: "", amount: "" })}
                        >
                            <option value="">{t("transactionsForm.selectLoan", "Select Loan...")}</option>
                            {borrowerLoans.map((l) => (
                                <option key={l.publicId ?? l.id} value={l.publicId ?? l.id}>
                                    {t("transactionsForm.loanOption", { defaultValue: "Loan #{{id}} - {{name}} (Principal: {{amount}})", id: l.id, name: l.borrowerName, amount: formatMoneyExact(String(l.principal), i18n.language) })}
                                </option>
                            ))}
                        </select>
                    </div>

                    <div className="grid gap-2">
                        <label htmlFor="installment">{t("transactionsForm.installment", "Installment")}</label>
                        <select
                            id="installment"
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
                                    #{item.installmentNo} • {new Intl.DateTimeFormat(i18n.language).format(new Date(`${item.dueDate}T00:00:00`))} • {t("transactionsForm.dueNow", "Due now")} {formatMoneyExact(item.totalDueNow ?? item.remainingDue, i18n.language)}
                                </option>
                            ))}
                        </select>
                    </div>

                    {selectedSchedule && (
                        <div className="rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">
                            {t("transactionsForm.scheduleSummary", {
                                defaultValue: "Due date: {{dueDate}} • Due now: ฿{{dueNow}} • Penalty: ฿{{penalty}}",
                                dueDate: new Intl.DateTimeFormat(i18n.language).format(new Date(`${selectedSchedule.dueDate}T00:00:00`)),
                                dueNow: formatMoneyExact(selectedSchedule.totalDueNow ?? selectedSchedule.remainingDue, i18n.language),
                                penalty: formatMoneyExact(selectedSchedule.penaltyDue ?? "0.00", i18n.language),
                            })}
                        </div>
                    )}

                    <div className="grid gap-2">
                        <label htmlFor="amount">{t("transactionsForm.amount", "Amount (฿)")}</label>
                        <Input id="amount" type="number" value={formData.amount} onChange={(e) => setFormData({ ...formData, amount: e.target.value })} />
                    </div>

                    <div className="grid gap-2">
                        <label htmlFor="received-at">{t("transactionsForm.receivedAt", "Received date and time")}</label>
                        <Input id="received-at" type="datetime-local" value={formData.receivedAt} onChange={(e) => setFormData({ ...formData, receivedAt: e.target.value })} />
                    </div>

                    <div className="grid gap-2">
                        <label htmlFor="bank-reference">{t("transactionsForm.reference", "Bank reference")}</label>
                        <Input id="bank-reference" value={formData.bankReference} onChange={(e) => setFormData({ ...formData, bankReference: e.target.value })} />
                    </div>

                    <div className="grid gap-2">
                        <label htmlFor="notes">{t("transactionsForm.notes", "Notes")}</label>
                        <Input id="notes" value={formData.notes} onChange={(e) => setFormData({ ...formData, notes: e.target.value })} />
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
