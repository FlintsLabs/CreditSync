import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import Decimal from "decimal.js";
import { Loader2 } from "lucide-react";
import { api } from "../../../lib/api";
import { createPaymentWorkflow, type HttpClient } from "../../../lib/workflow-api";
import { formatMoneyExact } from "../../../lib/workflow-model";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/Button";
import { Card, CardContent, CardHeader, CardTitle } from "../../../components/ui/Card";
import { Input } from "../../../components/ui/Input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../../components/ui/table";
import { repaymentLineageTarget } from "./loan-repayment-history-model";

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
    repostOfIntakePublicId?: string | null;
    repostedByIntakePublicId?: string | null;
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

const postedComponentEntries = (item: PaymentIntakeHistoryItem) => item.postedComponents
    ? ([
        ["principal", item.postedComponents.principal],
        ["interest", item.postedComponents.interest],
        ["fee", item.postedComponents.fee],
        ["penalty", item.postedComponents.penalty],
    ] as const).filter(([, amount]) => !new Decimal(amount).isZero())
    : [];

const Allocation = ({ item, t, i18n }: { item: PaymentIntakeHistoryItem; t: (key: string, options?: Record<string, string>) => string; i18n: { language: string } }) => {
    const components = postedComponentEntries(item);
    if (components.length > 0) {
        return (
            <div className="flex min-w-64 flex-wrap gap-x-2 gap-y-1 text-xs text-muted-foreground">
                {components.map(([key, amount]) => (
                    <span key={key}>{t(`loanDetail.repaymentHistory.${key}`)} {formatMoneyExact(amount, i18n.language)}</span>
                ))}
            </div>
        );
    }

    return item.latestAllocation
        ? <span className="whitespace-nowrap text-xs text-muted-foreground">{formatMoneyExact(item.latestAllocation.amount, i18n.language)}</span>
        : <span className="text-muted-foreground">—</span>;
};

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

    const Status = ({ item }: { item: PaymentIntakeHistoryItem }) => (
        <div className="flex flex-col items-start gap-1"><Badge variant={statusVariant(item.status)}>{item.repostOfIntakePublicId ? t("loanDetail.repaymentHistory.repostedAfterReversal") : t(`loanDetail.repaymentHistory.status.${item.status}`, { defaultValue: item.status })}</Badge>{item.repostedByIntakePublicId && <span className="text-xs text-muted-foreground">{t("loanDetail.repaymentHistory.repostedBy")}</span>}</div>
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
                        <div className="overflow-x-auto">
                            <Table className="min-w-[64rem]">
                                <TableHeader>
                                    <TableRow className="hover:bg-transparent">
                                        <TableHead>{t("loanDetail.repaymentHistory.receivedAt")}</TableHead>
                                        <TableHead className="text-right">{t("loanDetail.repaymentHistory.amount")}</TableHead>
                                        <TableHead>{t("loanDetail.repaymentHistory.reference")}</TableHead>
                                        <TableHead>{t("loanDetail.repaymentHistory.allocation")}</TableHead>
                                        <TableHead>{t("loanDetail.repaymentHistory.statusColumn")}</TableHead>
                                        <TableHead><span className="sr-only">{t("loanDetail.repaymentHistory.continue")}</span></TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {items.map((item) => (
                                        <TableRow key={item.publicId}>
                                            <TableCell className="whitespace-nowrap text-muted-foreground">{formatReceivedAt(item.receivedAt)}</TableCell>
                                            <TableCell className="whitespace-nowrap text-right font-medium tabular-nums">{formatMoneyExact(item.amount, i18n.language)}</TableCell>
                                            <TableCell className="max-w-56 truncate" title={item.bankReference ?? undefined}>{item.bankReference ?? "—"}</TableCell>
                                            <TableCell><Allocation item={item} t={t} i18n={i18n} /></TableCell>
                                            <TableCell className="whitespace-nowrap"><Status item={item} /></TableCell>
                                            <TableCell className="text-right">
                                                {repaymentLineageTarget(item) && <Button className="mr-2" variant="ghost" size="sm" onClick={() => openIntake(repaymentLineageTarget(item)!.publicId)}>{t(repaymentLineageTarget(item)!.labelKey)}</Button>}
                                                <Button variant="outline" size="sm" onClick={() => openIntake(item.publicId)}>
                                                    {t("loanDetail.repaymentHistory.continue")}
                                                </Button>
                                            </TableCell>
                                        </TableRow>
                                    ))}
                                </TableBody>
                            </Table>
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
