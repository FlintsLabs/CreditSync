import { useEffect, useMemo, useRef, useState } from "react";
import Decimal from "decimal.js";
import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "../../../lib/api";
import { formatMoneyExact } from "../../../lib/workflow-model";
import { Button } from "../../../components/ui/Button";
import { Input } from "../../../components/ui/Input";
import { Badge } from "../../../components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "../../../components/ui/Card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../../components/ui/table";
import { LoanTablePagination, type LoanTablePageSize } from "./LoanTablePagination";

interface PaymentRow { publicId: string; loanPublicId: string; amount: string; interestComponent?: string | null; date: string; type: string }
interface Attribution { publicId: string; sourceKind: "direct" | "intermediary"; intermediaryPublicId: string | null; amount: string }
interface Intermediary { publicId: string; name: string }
interface CommissionSummary { totalCommission: string; participants: Array<{ intermediaryPublicId: string; commissionAmount: string }> }

function errorMessage(error: unknown, fallback: string) {
    return (error as { response?: { data?: { message?: string; error?: string } } }).response?.data?.message
        ?? (error as { response?: { data?: { error?: string } } }).response?.data?.error ?? fallback;
}

export function LoanPaymentHistoryTab({ loanPublicId }: { loanPublicId: string }) {
    const { t, i18n } = useTranslation();
    const [payments, setPayments] = useState<PaymentRow[]>([]);
    const [attributions, setAttributions] = useState<Record<string, Attribution[]>>({});
    const [intermediaries, setIntermediaries] = useState<Intermediary[]>([]);
    const [commission, setCommission] = useState<CommissionSummary>({ totalCommission: "0.00", participants: [] });
    const [commissionByPayment, setCommissionByPayment] = useState<Record<string, string>>({});
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [editing, setEditing] = useState<string | null>(null);
    const [form, setForm] = useState({ sourceKind: "direct" as "direct" | "intermediary", intermediaryPublicId: "", amount: "", confirmed: false });
    const [saving, setSaving] = useState(false);
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState<LoanTablePageSize>(10);
    const commandIntentRef = useRef<{ fingerprint: string; idempotencyKey: string } | null>(null);

    const load = async () => {
        setLoading(true); setError("");
        try {
            const [transactionResponse, intermediaryResponse] = await Promise.all([api.get("/transactions"), api.get("/intermediaries?status=all")]);
            const posted: PaymentRow[] = (transactionResponse.data ?? []).filter((item: PaymentRow) => item.loanPublicId === loanPublicId && ["repayment", "close_account", "reversal"].includes(item.type));
            const attributionEntries = await Promise.all(posted.map(async (item: PaymentRow) => [item.publicId, (await api.get(`/payments/${item.publicId}/intermediary-attributions`)).data ?? []] as const));
            const ids = posted.map((item: PaymentRow) => item.publicId);
            const commissionResponse = ids.length
                ? await api.get(`/loans/${loanPublicId}/commissions?${new URLSearchParams({ paymentPublicIds: ids.join(",") }).toString()}`)
                : { data: { totalCommission: "0.00", participants: [] } };
            const paymentCommissionEntries = await Promise.all(ids.map(async (paymentPublicId) => {
                try {
                    const response = await api.get(`/loans/${loanPublicId}/commissions?${new URLSearchParams({ paymentPublicIds: paymentPublicId }).toString()}`);
                    return [paymentPublicId, String(response.data?.totalCommission ?? "0.00")] as const;
                } catch {
                    return [paymentPublicId, ""] as const;
                }
            }));
            setPayments(posted);
            setPage(1);
            setAttributions(Object.fromEntries(attributionEntries));
            setIntermediaries(intermediaryResponse.data?.items ?? intermediaryResponse.data ?? []);
            setCommission(commissionResponse.data);
            setCommissionByPayment(Object.fromEntries(paymentCommissionEntries));
            return true;
        } catch (loadError) { setError(errorMessage(loadError, t("loanDetail.paymentHistory.errors.load", "Unable to load payment history."))); return false; }
        finally { setLoading(false); }
    };
    useEffect(() => {
        const timer = window.setTimeout(() => { void load(); }, 0);
        return () => window.clearTimeout(timer);
    }, [loanPublicId]); // eslint-disable-line react-hooks/exhaustive-deps

    const names = useMemo(() => new Map(intermediaries.map((item) => [item.publicId, item.name])), [intermediaries]);
    const openEditor = (payment: PaymentRow) => { setEditing(payment.publicId); setForm({ sourceKind: "direct", intermediaryPublicId: "", amount: payment.amount, confirmed: false }); setError(""); };
    const save = async () => {
        if (!editing || saving) return;
        if (!form.confirmed) { setError(t("loanDetail.paymentHistory.errors.confirm", "Confirm the attribution before saving.")); return; }
        if (!/^(0|[1-9]\d*)\.\d{2}$/.test(form.amount) || !new Decimal(form.amount).gt(0)) { setError(t("loanDetail.paymentHistory.errors.amount", "Enter a positive amount with exactly two decimals.")); return; }
        if (form.sourceKind === "intermediary" && !form.intermediaryPublicId) { setError(t("loanDetail.paymentHistory.errors.agent", "Choose an agent.")); return; }
        setSaving(true); setError("");
        try {
            const command = {
                url: `/payments/${editing}/intermediary-attributions`,
                body: { sourceKind: form.sourceKind, ...(form.sourceKind === "intermediary" ? { intermediaryPublicId: form.intermediaryPublicId } : {}), amount: form.amount, confirmed: true },
            };
            const fingerprint = JSON.stringify(command);
            if (commandIntentRef.current?.fingerprint !== fingerprint) {
                commandIntentRef.current = { fingerprint, idempotencyKey: crypto.randomUUID() };
            }
            await api.post(command.url, command.body, { headers: { "Idempotency-Key": commandIntentRef.current.idempotencyKey } });
            if (await load()) {
                commandIntentRef.current = null;
                setEditing(null);
            }
        } catch (saveError) { setError(errorMessage(saveError, t("loanDetail.paymentHistory.errors.save", "Unable to save payment attribution."))); }
        finally { setSaving(false); }
    };

    const AttributionChips = ({ payment }: { payment: PaymentRow }) => {
        const rows = attributions[payment.publicId] ?? [];
        const netAttributed = rows.reduce((sum, row) => sum.plus(row.amount), new Decimal(0));
        if (rows.length === 0 || netAttributed.isZero()) return <Badge variant="outline">{t("loanDetail.paymentHistory.unattributed", "Unattributed")}</Badge>;
        return <div className="flex min-w-56 flex-wrap gap-1">{rows.map((row) => <Badge key={row.publicId} variant={row.sourceKind === "direct" ? "secondary" : "outline"}>{row.sourceKind === "direct" ? <><span>{t("loanDetail.paymentHistory.direct", "Direct payment")}</span><span className="ml-1">· {formatMoneyExact(row.amount, i18n.language)}</span></> : <span>{names.get(row.intermediaryPublicId ?? "") ?? row.intermediaryPublicId} · {formatMoneyExact(row.amount, i18n.language)}</span>}</Badge>)}</div>;
    };

    return <Card><CardHeader><CardTitle>{t("loanDetail.paymentHistory.title", "Payment History")}</CardTitle><p className="mt-1 text-sm text-muted-foreground">{t("loanDetail.paymentHistory.description", "Posted payments, explicit source attribution, and authoritative commission.")}</p></CardHeader><CardContent className="space-y-4">
        {error && !editing && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {loading ? <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{t("common.loading", "Loading...")}</div>
            : payments.length === 0 ? <div className="rounded border border-dashed p-5 text-sm text-muted-foreground">{t("loanDetail.paymentHistory.empty", "No posted payments.")}</div>
            : <><div className="rounded border bg-muted/20 p-4"><div className="text-sm text-muted-foreground">{t("loanDetail.paymentHistory.totalCommission", "Total commission")}</div><div className="text-xl font-semibold tabular-nums">{formatMoneyExact(commission.totalCommission, i18n.language)}</div></div>
                <div className="overflow-x-auto"><Table className="min-w-[62rem]"><TableHeader><TableRow><TableHead>{t("loanDetail.table.no", "No.")}</TableHead><TableHead>{t("loanDetail.paymentHistory.date", "Posted date")}</TableHead><TableHead className="text-right">{t("loanDetail.paymentHistory.amountLabel", "Amount")}</TableHead><TableHead className="text-right">{t("loanDetail.paymentHistory.interest", "Interest")}</TableHead><TableHead className="text-right">{t("loanDetail.paymentHistory.commission", "Commission")}</TableHead><TableHead>{t("loanDetail.paymentHistory.attribution", "Attribution")}</TableHead><TableHead><span className="sr-only">{t("common.actions", "Actions")}</span></TableHead></TableRow></TableHeader><TableBody>{payments.slice((page - 1) * (pageSize === "all" ? payments.length : pageSize), pageSize === "all" ? payments.length : page * pageSize).map((payment, index) => <TableRow key={payment.publicId} data-testid={`payment-${payment.publicId}`}><TableCell data-testid={`payment-row-number-${(page - 1) * (pageSize === "all" ? payments.length : pageSize) + index + 1}`}>{(page - 1) * (pageSize === "all" ? payments.length : pageSize) + index + 1}</TableCell><TableCell className="whitespace-nowrap">{new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium", timeZone: "Asia/Bangkok" }).format(new Date(payment.date))}</TableCell><TableCell className="text-right tabular-nums">{formatMoneyExact(payment.amount, i18n.language)}</TableCell><TableCell className="text-right tabular-nums">{formatMoneyExact(payment.interestComponent ?? "0.00", i18n.language)}</TableCell><TableCell className="text-right tabular-nums">{commissionByPayment[payment.publicId] ? formatMoneyExact(commissionByPayment[payment.publicId], i18n.language) : "—"}</TableCell><TableCell><AttributionChips payment={payment} /></TableCell><TableCell className="text-right"><Button size="sm" variant="outline" onClick={() => openEditor(payment)}>{t("loanDetail.paymentHistory.edit", "Attribute")}</Button></TableCell></TableRow>)}</TableBody></Table></div><LoanTablePagination controlId="loan-payment-page-size" page={page} pageSize={pageSize} totalItems={payments.length} onPageChange={setPage} onPageSizeChange={(nextPageSize) => { setPageSize(nextPageSize); setPage(1); }} /></>}
        {editing && <div className="rounded border p-4 space-y-4"><h3 className="font-medium">{t("loanDetail.paymentHistory.editorTitle", "Attribute payment")}</h3><div className="grid gap-4 sm:grid-cols-3"><div className="grid gap-2"><label htmlFor="attribution-source">{t("loanDetail.paymentHistory.source", "Source")}</label><select id="attribution-source" className="h-10 rounded-md border bg-background px-3" value={form.sourceKind} onChange={(event) => setForm({ ...form, sourceKind: event.target.value as "direct" | "intermediary", confirmed: false })}><option value="direct">{t("loanDetail.paymentHistory.direct", "Direct payment")}</option><option value="intermediary">{t("loanDetail.paymentHistory.agent", "Agent")}</option></select></div>{form.sourceKind === "intermediary" && <div className="grid gap-2"><label htmlFor="attribution-agent">{t("loanDetail.paymentHistory.agent", "Agent")}</label><select id="attribution-agent" className="h-10 rounded-md border bg-background px-3" value={form.intermediaryPublicId} onChange={(event) => setForm({ ...form, intermediaryPublicId: event.target.value, confirmed: false })}><option value="">{t("loanDetail.agents.choose", "Choose an agent")}</option>{intermediaries.map((item) => <option key={item.publicId} value={item.publicId}>{item.name}</option>)}</select></div>}<div className="grid gap-2"><label htmlFor="attribution-amount">{t("loanDetail.paymentHistory.amountLabel", "Amount")}</label><Input id="attribution-amount" inputMode="decimal" value={form.amount} onChange={(event) => setForm({ ...form, amount: event.target.value, confirmed: false })} /></div></div><label className="flex gap-2 text-sm"><input type="checkbox" checked={form.confirmed} onChange={(event) => setForm({ ...form, confirmed: event.target.checked })} />{t("loanDetail.paymentHistory.confirmation", "I confirm this payment source attribution")}</label>{error && <p role="alert" className="text-sm text-destructive">{error}</p>}<div className="flex justify-end gap-2"><Button variant="outline" onClick={() => setEditing(null)}>{t("common.cancel", "Cancel")}</Button><Button disabled={saving} onClick={() => void save()}>{t("common.save", "Save")}</Button></div></div>}
    </CardContent></Card>;
}
