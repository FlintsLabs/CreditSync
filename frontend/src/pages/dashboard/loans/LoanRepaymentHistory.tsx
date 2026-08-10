import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { api } from "../../../lib/api";
import { createPaymentWorkflow, type HttpClient } from "../../../lib/workflow-api";
import { formatMoneyExact } from "../../../lib/workflow-model";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/Button";
import { Card, CardContent, CardHeader, CardTitle } from "../../../components/ui/Card";
import { Input } from "../../../components/ui/Input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog";

interface PostedComponents {
    principal: string;
    interest: string;
    fee: string;
    penalty: string;
}

interface PaymentIntakeHistoryItem {
    publicId: string;
    status: string;
    amount: string;
    receivedAt: string;
    bankReference: string | null;
    latestAllocation: { amount: string; proposalPublicId: string | null } | null;
    postedComponents: PostedComponents | null;
}

interface LoanRepaymentHistoryProps {
    loanPublicId: string;
    borrowerName: string;
    borrowerPublicId?: string | null;
}

function localDateTimeValue(date = new Date()) {
    return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function statusVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
    if (status === "posted") return "default";
    if (status === "reversed" || status === "duplicate") return "destructive";
    if (status === "ready") return "secondary";
    return "outline";
}

export function LoanRepaymentHistory({ loanPublicId, borrowerName, borrowerPublicId }: LoanRepaymentHistoryProps) {
    const { t, i18n } = useTranslation();
    const navigate = useNavigate();
    const [items, setItems] = useState<PaymentIntakeHistoryItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [errorMessage, setErrorMessage] = useState("");
    const [dialogOpen, setDialogOpen] = useState(false);
    const [saving, setSaving] = useState(false);
    const [capture, setCapture] = useState({ amount: "", receivedAt: localDateTimeValue(), bankReference: "", notes: "" });

    useEffect(() => {
        let active = true;
        api.get(`/loans/${loanPublicId}/payment-intakes`)
            .then((response) => {
                if (!active) return;
                setItems(response.data ?? []);
                setErrorMessage("");
            })
            .catch(() => {
                if (active) setErrorMessage(t("loanDetail.repaymentHistory.errors.load", "Unable to load repayment history."));
            })
            .finally(() => {
                if (active) setLoading(false);
            });
        return () => { active = false; };
    }, [loanPublicId, t]);

    const openIntake = (publicId: string) => navigate(`/payments?${new URLSearchParams({ intake: publicId, loanId: loanPublicId }).toString()}`);

    const beginCapture = () => {
        if (typeof window !== "undefined" && window.matchMedia?.("(min-width: 768px)").matches) {
            setDialogOpen(true);
            return;
        }
        const params = new URLSearchParams({ loanId: loanPublicId });
        if (borrowerPublicId) params.set("borrowerId", borrowerPublicId);
        navigate(`/transactions/new?${params.toString()}`);
    };

    const saveCapture = async (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        setSaving(true);
        setErrorMessage("");
        try {
            const result = await createPaymentWorkflow(api as unknown as HttpClient, {
                amount: capture.amount,
                receivedAt: new Date(capture.receivedAt).toISOString(),
                payerName: borrowerName,
                bankReference: capture.bankReference,
                notes: capture.notes,
                originLoanPublicId: loanPublicId,
            });
            setDialogOpen(false);
            openIntake(result.publicId);
        } catch (error: unknown) {
            const code = (error as { response?: { data?: { code?: string } } }).response?.data?.code;
            setErrorMessage(code
                ? t(`domainErrors.${code}`, { defaultValue: t("transactionsForm.errors.recordFailed", "Record failed") })
                : (error instanceof Error ? error.message : t("transactionsForm.errors.recordFailed", "Record failed")));
        } finally {
            setSaving(false);
        }
    };

    const formatReceivedAt = (value: string) => new Intl.DateTimeFormat(i18n.language, {
        dateStyle: "medium",
        timeStyle: "short",
    }).format(new Date(value));

    const Status = ({ status }: { status: string }) => (
        <Badge variant={statusVariant(status)}>{t(`loanDetail.repaymentHistory.status.${status}`, { defaultValue: status })}</Badge>
    );

    const Allocation = ({ item }: { item: PaymentIntakeHistoryItem }) => (
        <div className="space-y-1 text-xs text-muted-foreground">
            {item.latestAllocation && <div>{t("loanDetail.repaymentHistory.allocation", "Latest allocation")}: {formatMoneyExact(item.latestAllocation.amount, i18n.language)}</div>}
            {item.postedComponents && (
                <div>{t("loanDetail.repaymentHistory.postedComponents", "Posted allocation")}: {[
                    ["principal", item.postedComponents.principal],
                    ["interest", item.postedComponents.interest],
                    ["fee", item.postedComponents.fee],
                    ["penalty", item.postedComponents.penalty],
                ].map(([key, amount]) => `${t(`loanDetail.repaymentHistory.${key}`)} ${formatMoneyExact(amount, i18n.language)}`).join(" • ")}</div>
            )}
        </div>
    );

    return (
        <Card>
            <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                    <CardTitle>{t("loanDetail.repaymentHistory.title", "Repayments received")}</CardTitle>
                    <p className="mt-1 text-sm text-muted-foreground">{t("loanDetail.repaymentHistory.description", "Every payment received from the borrower for this agreement, including drafts and reversals.")}</p>
                </div>
                <Button onClick={beginCapture}>{t("loanDetail.repaymentHistory.record", "Record repayment")}</Button>
            </CardHeader>
            <CardContent>
                {errorMessage && <p role="alert" className="mb-3 text-sm text-destructive">{errorMessage}</p>}
                {loading ? <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{t("common.loading", "Loading...")}</div>
                    : items.length === 0 ? <div className="rounded border border-dashed p-4 text-sm text-muted-foreground">{t("loanDetail.repaymentHistory.empty", "No repayment intakes have been recorded for this agreement.")}</div>
                    : <>
                        <div className="hidden overflow-x-auto md:block">
                            <table className="w-full text-sm">
                                <thead className="border-b text-left text-muted-foreground">
                                    <tr><th className="p-2">{t("loanDetail.repaymentHistory.receivedAt", "Received at")}</th><th className="p-2">{t("loanDetail.repaymentHistory.amount", "Received amount")}</th><th className="p-2">{t("loanDetail.repaymentHistory.reference", "Bank reference")}</th><th className="p-2">{t("loanDetail.repaymentHistory.allocation", "Latest allocation")}</th><th className="p-2" /></tr>
                                </thead>
                                <tbody>
                                    {items.map((item) => <tr key={item.publicId} className="border-b last:border-0">
                                        <td className="p-2"><div>{formatReceivedAt(item.receivedAt)}</div><Status status={item.status} /></td>
                                        <td className="p-2 font-medium">{formatMoneyExact(item.amount, i18n.language)}</td>
                                        <td className="p-2">{item.bankReference ?? "—"}</td>
                                        <td className="p-2"><Allocation item={item} /></td>
                                        <td className="p-2 text-right"><Button variant="outline" size="sm" onClick={() => openIntake(item.publicId)}>{t("loanDetail.repaymentHistory.continue", "Open payment review")}</Button></td>
                                    </tr>)}
                                </tbody>
                            </table>
                        </div>
                        <div className="space-y-3 md:hidden">
                            {items.map((item) => <div key={item.publicId} className="rounded border p-3 text-sm">
                                <div className="flex items-start justify-between gap-3"><div><div className="font-medium">{formatMoneyExact(item.amount, i18n.language)}</div><div className="text-xs text-muted-foreground">{formatReceivedAt(item.receivedAt)}</div></div><Status status={item.status} /></div>
                                {item.bankReference && <div className="mt-2 text-xs text-muted-foreground">{t("loanDetail.repaymentHistory.reference", "Bank reference")}: {item.bankReference}</div>}
                                <div className="mt-2"><Allocation item={item} /></div>
                                <Button className="mt-3 w-full" variant="outline" size="sm" onClick={() => openIntake(item.publicId)}>{t("loanDetail.repaymentHistory.continue", "Open payment review")}</Button>
                            </div>)}
                        </div>
                    </>}
            </CardContent>
            <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>{t("loanDetail.repaymentHistory.quickCaptureTitle", "Record repayment")}</DialogTitle>
                        <DialogDescription>{t("loanDetail.repaymentHistory.quickCaptureDescription", "Capture the incoming payment now, then review its allocation before posting.")}</DialogDescription>
                    </DialogHeader>
                    <form className="space-y-4" onSubmit={saveCapture}>
                        <div className="grid gap-2"><label htmlFor="quick-repayment-amount">{t("loanDetail.repaymentHistory.amount", "Received amount")}</label><Input id="quick-repayment-amount" type="number" inputMode="decimal" required value={capture.amount} onChange={(event) => setCapture((current) => ({ ...current, amount: event.target.value }))} /></div>
                        <div className="grid gap-2"><label htmlFor="quick-repayment-received-at">{t("transactionsForm.receivedAt", "Received date and time")}</label><Input id="quick-repayment-received-at" type="datetime-local" required value={capture.receivedAt} onChange={(event) => setCapture((current) => ({ ...current, receivedAt: event.target.value }))} /></div>
                        <div className="grid gap-2"><label htmlFor="quick-repayment-reference">{t("loanDetail.repaymentHistory.reference", "Bank reference")}</label><Input id="quick-repayment-reference" value={capture.bankReference} onChange={(event) => setCapture((current) => ({ ...current, bankReference: event.target.value }))} /></div>
                        <div className="grid gap-2"><label htmlFor="quick-repayment-notes">{t("transactionsForm.notes", "Notes")}</label><Input id="quick-repayment-notes" value={capture.notes} onChange={(event) => setCapture((current) => ({ ...current, notes: event.target.value }))} /></div>
                        <DialogFooter><Button type="submit" disabled={saving}>{saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{t("loanDetail.repaymentHistory.saveAndReview", "Continue to payment review")}</Button></DialogFooter>
                    </form>
                </DialogContent>
            </Dialog>
        </Card>
    );
}
