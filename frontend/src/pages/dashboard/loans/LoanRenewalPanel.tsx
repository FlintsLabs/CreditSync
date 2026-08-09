import { useCallback, useState } from "react";
import { AlertTriangle, CalendarClock, CheckCircle2, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "../../../lib/api";
import { executeRenewal, normalizeMoney, type HttpClient } from "../../../lib/workflow-api";
import { Button } from "../../../components/ui/Button";
import { Card, CardContent, CardHeader, CardTitle } from "../../../components/ui/Card";
import { Input } from "../../../components/ui/Input";
import { Badge } from "../../../components/ui/badge";

interface RenewableLoan {
    publicId: string;
    principalAmount: string;
    interestRate: string;
    repaymentType: string;
    termMonths: number | null;
    totalInstallments: number | null;
    installmentAmount: string | null;
    status: string;
}

interface RenewalPreview {
    publicId: string;
    status: string;
    previewHash: string;
    principalPaid: string;
    outstandingPrincipal: string;
    dueInterest: string;
    dueFees: string;
    duePenalties: string;
    dueCharges: string;
    settlementAmount: string;
    waivedCharges: string;
    requestedPrincipal: string;
    cashDirection: "payout" | "collection" | "none";
    cashAmount: string;
    expiresAt: string;
}

interface ScheduleRow { installmentNo: number; dueDate: string; amount: string; principalComponent: string; interestComponent: string }
interface RenewalExecution extends RenewalPreview { newLoanPublicId?: string | null; executedAt?: string | null; reversedAt?: string | null }
interface AuditEntry { id: number; action: string; correlationId?: string | null; requestId?: string | null; createdAt: string }

export function LoanRenewalPanel({ loan }: { loan: RenewableLoan }) {
    const { t, i18n } = useTranslation();
    const [requestedPrincipal, setRequestedPrincipal] = useState(loan.principalAmount);
    const [waivedCharges, setWaivedCharges] = useState("0.00");
    const [waiverReason, setWaiverReason] = useState("");
    const [executionReason, setExecutionReason] = useState("");
    const [reverseReason, setReverseReason] = useState("");
    const [confirmed, setConfirmed] = useState(false);
    const [preview, setPreview] = useState<RenewalPreview | null>(null);
    const [execution, setExecution] = useState<RenewalExecution | null>(null);
    const [schedule, setSchedule] = useState<ScheduleRow[]>([]);
    const [audits, setAudits] = useState<AuditEntry[]>([]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    const money = useCallback((value: string | number) => new Intl.NumberFormat(i18n.language, {
        style: "currency", currency: "THB", minimumFractionDigits: 2,
    }).format(Number(value)), [i18n.language]);
    const dateTime = useCallback((value: string) => new Intl.DateTimeFormat(i18n.language, {
        dateStyle: "medium", timeStyle: "short",
    }).format(new Date(value)), [i18n.language]);

    const loadAudit = async (renewalId: string) => {
        try {
            const response = await api.get("/audit-logs", { params: { entityType: "loan_renewal", entityId: renewalId } });
            setAudits(response.data ?? []);
        } catch { setAudits([]); }
    };

    const previewRenewal = async () => {
        setBusy(true); setError(""); setExecution(null); setConfirmed(false);
        try {
            const [renewal, nextSchedule] = await Promise.all([
                api.post("/loan-renewals/preview", {
                    oldLoanPublicId: loan.publicId,
                    requestedPrincipal: normalizeMoney(requestedPrincipal),
                    waivedCharges: normalizeMoney(waivedCharges),
                    waiverReason: waiverReason.trim() || null,
                }),
                api.post("/loans/preview", {
                    principal: normalizeMoney(requestedPrincipal), interestRate: loan.interestRate,
                    termMonths: loan.termMonths, repaymentType: "daily",
                    startDate: new Date().toISOString().slice(0, 10),
                    ...(loan.totalInstallments ? { totalInstallments: loan.totalInstallments } : {}),
                    ...(loan.installmentAmount ? { installmentAmount: loan.installmentAmount } : {}),
                }),
            ]);
            setPreview(renewal.data);
            setSchedule(nextSchedule.data?.schedule ?? []);
            await loadAudit(renewal.data.publicId);
        } catch (caught: unknown) {
            const apiError = caught as { response?: { data?: { error?: string } } };
            setError(apiError.response?.data?.error ?? t("renewal.errors.preview"));
        } finally { setBusy(false); }
    };

    const execute = async () => {
        if (!preview) return;
        setBusy(true); setError("");
        try {
            const result = await executeRenewal(api as unknown as HttpClient, preview.publicId, preview.previewHash, executionReason, crypto.randomUUID()) as RenewalExecution;
            setExecution(result);
            await loadAudit(preview.publicId);
        } catch (caught: unknown) {
            const apiError = caught as { response?: { data?: { error?: string } } };
            setError(apiError.response?.data?.error ?? (caught instanceof Error ? caught.message : t("renewal.errors.execute")));
        } finally { setBusy(false); }
    };

    const reverse = async () => {
        if (!preview) return;
        setBusy(true); setError("");
        try {
            const result = await api.post(`/loan-renewals/${preview.publicId}/reverse`, { reason: reverseReason.trim() }, { headers: { "Idempotency-Key": crypto.randomUUID() } });
            setExecution(result.data);
            await loadAudit(preview.publicId);
        } catch (caught: unknown) {
            const apiError = caught as { response?: { data?: { error?: string } } };
            setError(apiError.response?.data?.error ?? t("renewal.errors.reverse"));
        } finally { setBusy(false); }
    };

    return (
        <Card>
            <CardHeader><CardTitle className="flex items-center gap-2"><CalendarClock className="h-5 w-5" />{t("renewal.title")}</CardTitle></CardHeader>
            <CardContent className="space-y-5">
                <p className="text-sm text-muted-foreground">{t("renewal.description")}</p>
                {error && <div className="flex gap-2 rounded border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"><AlertTriangle className="h-4 w-4" />{error}</div>}
                {!execution && <div className="grid gap-3 md:grid-cols-2"><label className="grid gap-1 text-sm">{t("renewal.requestedPrincipal")}<Input value={requestedPrincipal} onChange={(event) => setRequestedPrincipal(event.target.value)} /></label><label className="grid gap-1 text-sm">{t("renewal.waivedCharges")}<Input value={waivedCharges} onChange={(event) => setWaivedCharges(event.target.value)} /></label><label className="grid gap-1 text-sm md:col-span-2">{t("renewal.waiverReason")}<Input value={waiverReason} onChange={(event) => setWaiverReason(event.target.value)} /></label><div className="md:col-span-2"><Button onClick={() => void previewRenewal()} disabled={busy || !requestedPrincipal}>{t("renewal.preview")}</Button></div></div>}
                {preview && <div className="space-y-4">
                    <div className="rounded border p-4"><div className="flex items-center justify-between gap-3"><strong>{t("renewal.previewTitle")}</strong><Badge>{t(`renewal.status.${execution?.status ?? preview.status}`)}</Badge></div><div className="mt-3 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4"><div><span className="text-muted-foreground">{t("renewal.recoveredPrincipal")}</span><div className="font-medium">{money(preview.principalPaid)}</div></div><div><span className="text-muted-foreground">{t("renewal.oldOutstanding")}</span><div className="font-medium">{money(preview.outstandingPrincipal)}</div></div><div><span className="text-muted-foreground">{t("renewal.dueCharges")}</span><div className="font-medium">{money(preview.dueCharges)}</div></div><div><span className="text-muted-foreground">{t("renewal.waiver")}</span><div className="font-medium">{money(preview.waivedCharges)}</div></div><div><span className="text-muted-foreground">{t("renewal.settlement")}</span><div className="font-medium">{money(preview.settlementAmount)}</div></div><div><span className="text-muted-foreground">{t("renewal.cashPayout")}</span><div className="font-medium">{t(`renewal.cashDirection.${preview.cashDirection}`)} · {money(preview.cashAmount)}</div></div><div className="sm:col-span-2"><span className="text-muted-foreground">{t("renewal.renewalId")}</span><div className="break-all font-mono text-xs">{preview.publicId}</div><div className="text-xs text-muted-foreground">{t("renewal.expires")}: {dateTime(preview.expiresAt)}</div></div></div></div>
                    <div className="rounded border p-4"><strong>{t("renewal.newSchedule")}</strong><div className="mt-3 max-h-64 overflow-auto"><table className="w-full text-sm"><thead><tr className="border-b text-left"><th className="p-2">#</th><th className="p-2">{t("renewal.dueDate")}</th><th className="p-2">{t("renewal.principal")}</th><th className="p-2">{t("renewal.interest")}</th><th className="p-2">{t("renewal.total")}</th></tr></thead><tbody>{schedule.map((row) => <tr key={row.installmentNo} className="border-b"><td className="p-2">{row.installmentNo}</td><td className="p-2">{new Intl.DateTimeFormat(i18n.language).format(new Date(`${row.dueDate}T00:00:00`))}</td><td className="p-2">{money(row.principalComponent)}</td><td className="p-2">{money(row.interestComponent)}</td><td className="p-2 font-medium">{money(row.amount)}</td></tr>)}</tbody></table></div></div>
                    {!execution && <div className="rounded border p-4"><label className="grid gap-1 text-sm">{t("renewal.executionReason")}<Input value={executionReason} onChange={(event) => setExecutionReason(event.target.value)} /></label><label className="mt-3 flex items-start gap-2 text-sm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} className="mt-1" /><span>{t("renewal.confirmation")}</span></label><Button className="mt-3 bg-emerald-600 hover:bg-emerald-700" disabled={busy || !confirmed || !executionReason.trim()} onClick={() => void execute()}><CheckCircle2 className="mr-2 h-4 w-4" />{t("renewal.confirm")}</Button></div>}
                    {execution?.status === "executed" && <div className="rounded border p-4"><div className="font-medium text-emerald-700">{t("renewal.executed", { id: execution.newLoanPublicId })}</div><label className="mt-3 grid gap-1 text-sm">{t("renewal.reverseReason")}<Input value={reverseReason} onChange={(event) => setReverseReason(event.target.value)} /></label><Button className="mt-3" variant="destructive" disabled={busy || !reverseReason.trim()} onClick={() => void reverse()}><RotateCcw className="mr-2 h-4 w-4" />{t("renewal.reverse")}</Button></div>}
                    {!!audits.length && <div className="rounded border p-4"><strong>{t("renewal.audit")}</strong>{audits.map((audit) => <div key={audit.id} className="mt-2 rounded bg-muted/30 p-2 text-xs"><div>{audit.action} · {dateTime(audit.createdAt)}</div><div className="break-all font-mono text-muted-foreground">{t("renewal.auditId")}: {audit.id} · {t("renewal.correlationId")}: {audit.correlationId || "—"} · {t("renewal.requestId")}: {audit.requestId || "—"}</div></div>)}</div>}
                </div>}
            </CardContent>
        </Card>
    );
}
