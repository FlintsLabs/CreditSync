import { useCallback, useRef, useState, type MutableRefObject } from "react";
import { AlertTriangle, CalendarClock, CheckCircle2, Plus, RotateCcw, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "../../../lib/api";
import { executeRenewal, normalizeMoney, type HttpClient } from "../../../lib/workflow-api";
import { formatMoneyExact } from "../../../lib/workflow-model";
import { Button } from "../../../components/ui/Button";
import { Card, CardContent, CardHeader, CardTitle } from "../../../components/ui/Card";
import { Input } from "../../../components/ui/Input";
import { Badge } from "../../../components/ui/badge";
import {
    canExecuteRenewal,
    defaultRenewalPolicy,
    newRenewalAdjustment,
    type RenewalAdjustmentDraft,
    type RenewalAdjustmentKind,
    type RenewalComposition,
    type RenewalSettlementPolicy,
} from "./loan-renewal-model";
import { RenewalSummaryCard } from "./RenewalSummaryCard";
import type { LoanRenewalSummary } from "./renewal-summary-image";

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
    settlementPolicy: RenewalSettlementPolicy;
    composition: RenewalComposition;
}

interface ScheduleRow { installmentNo: number; dueDate: string; amount: string; principalComponent: string; interestComponent: string }
interface RenewalExecution extends RenewalPreview { newLoanPublicId?: string | null; executedAt?: string | null; reversedAt?: string | null }
interface AuditEntry { id: number; action: string; correlationId?: string | null; requestId?: string | null; createdAt: string }
type AuditState = { status: "idle" | "loading" | "empty" | "forbidden" | "error" } | { status: "ready"; entries: AuditEntry[] };
type IntentKey = { fingerprint: string; key: string };

function stableIntentKey(ref: MutableRefObject<IntentKey | null>, fingerprint: string) {
    if (ref.current?.fingerprint !== fingerprint) ref.current = { fingerprint, key: crypto.randomUUID() };
    return ref.current.key;
}

export function LoanRenewalPanel({ loan }: { loan: RenewableLoan }) {
    const { t, i18n } = useTranslation();
    const [requestedPrincipal, setRequestedPrincipal] = useState(loan.principalAmount);
    const [settlementPolicy, setSettlementPolicy] = useState<RenewalSettlementPolicy>(defaultRenewalPolicy);
    const [adjustments, setAdjustments] = useState<RenewalAdjustmentDraft[]>([]);
    const [executionReason, setExecutionReason] = useState("");
    const [reverseReason, setReverseReason] = useState("");
    const [confirmed, setConfirmed] = useState(false);
    const [collectionConfirmed, setCollectionConfirmed] = useState(false);
    const [preview, setPreview] = useState<RenewalPreview | null>(null);
    const [execution, setExecution] = useState<RenewalExecution | null>(null);
    const [schedule, setSchedule] = useState<ScheduleRow[]>([]);
    const [summary, setSummary] = useState<LoanRenewalSummary | null>(null);
    const [audit, setAudit] = useState<AuditState>({ status: "idle" });
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const executionKey = useRef<IntentKey | null>(null);
    const reversalKey = useRef<IntentKey | null>(null);

    const money = useCallback((value: string) => formatMoneyExact(value, i18n.language), [i18n.language]);
    const dateTime = useCallback((value: string) => new Intl.DateTimeFormat(i18n.language, {
        dateStyle: "medium", timeStyle: "short",
    }).format(new Date(value)), [i18n.language]);
    const localizedError = useCallback((caught: unknown, fallbackKey: string) => {
        const code = (caught as { response?: { data?: { code?: string } } }).response?.data?.code;
        return code ? t(`domainErrors.${code}`, { defaultValue: t(fallbackKey) }) : t(fallbackKey);
    }, [t]);

    const discardApproval = () => {
        setPreview(null); setExecution(null); setSchedule([]); setSummary(null); setConfirmed(false); setCollectionConfirmed(false);
        executionKey.current = null; reversalKey.current = null;
    };

    const editRequestedPrincipal = (value: string) => { discardApproval(); setRequestedPrincipal(value); };
    const editPolicy = (value: RenewalSettlementPolicy) => { discardApproval(); setSettlementPolicy(value); };
    const editAdjustment = (index: number, field: keyof RenewalAdjustmentDraft, value: string) => {
        discardApproval();
        setAdjustments((current) => current.map((line, lineIndex) => lineIndex === index ? { ...line, [field]: value } : line));
    };

    const loadAudit = async (renewalId: string) => {
        setAudit({ status: "loading" });
        try {
            const response = await api.get("/audit-logs", { params: { entityType: "loan_renewal", entityId: renewalId } });
            const entries = response.data ?? [];
            setAudit(entries.length ? { status: "ready", entries } : { status: "empty" });
        } catch (caught) {
            const status = (caught as { response?: { status?: number } }).response?.status;
            setAudit({ status: status === 403 ? "forbidden" : "error" });
        }
    };

    const previewRenewal = async () => {
        setBusy(true); setError(""); setExecution(null); setConfirmed(false); setCollectionConfirmed(false);
        executionKey.current = null; reversalKey.current = null;
        try {
            const [renewal, nextSchedule] = await Promise.all([
                api.post("/loan-renewals/preview", {
                    oldLoanPublicId: loan.publicId,
                    requestedPrincipal: normalizeMoney(requestedPrincipal),
                    settlementPolicy,
                    adjustments: adjustments.map((line) => ({ ...line, amount: normalizeMoney(line.amount), reason: line.reason.trim() })),
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
            const summaryResponse = await api.get(`/loan-renewals/${renewal.data.publicId}/summary`);
            setSummary(summaryResponse.data);
            await loadAudit(renewal.data.publicId);
        } catch (caught) {
            setError(localizedError(caught, "renewal.errors.preview"));
        } finally { setBusy(false); }
    };

    const execute = async () => {
        if (!preview) return;
        setBusy(true); setError("");
        const reason = executionReason.trim();
        const fingerprint = `${preview.publicId}:${preview.previewHash}:${reason}`;
        try {
            const result = await executeRenewal(
                api as unknown as HttpClient,
                preview.publicId,
                preview.previewHash,
                reason,
                stableIntentKey(executionKey, fingerprint),
                preview.cashDirection === "collection" && collectionConfirmed ? "collection" : undefined,
            ) as RenewalExecution;
            setExecution(result);
            reversalKey.current = null;
            setSummary((await api.get(`/loan-renewals/${preview.publicId}/summary`)).data);
            await loadAudit(preview.publicId);
        } catch (caught) {
            setError(localizedError(caught, "renewal.errors.execute"));
        } finally { setBusy(false); }
    };

    const reverse = async () => {
        if (!preview) return;
        setBusy(true); setError("");
        const reason = reverseReason.trim();
        const fingerprint = `${preview.publicId}:${reason}`;
        try {
            const result = await api.post(`/loan-renewals/${preview.publicId}/reverse`, { reason }, {
                headers: { "Idempotency-Key": stableIntentKey(reversalKey, fingerprint) },
            });
            setExecution(result.data);
            setSummary((await api.get(`/loan-renewals/${preview.publicId}/summary`)).data);
            await loadAudit(preview.publicId);
        } catch (caught) {
            setError(localizedError(caught, "renewal.errors.reverse"));
        } finally { setBusy(false); }
    };

    return <Card aria-busy={busy}>
        <CardHeader><CardTitle className="flex items-center gap-2"><CalendarClock className="h-5 w-5" />{t("renewal.title")}</CardTitle></CardHeader>
        <CardContent className="space-y-5">
            <p className="text-sm text-muted-foreground">{t("renewal.description")}</p>
            {error && <div role="alert" className="flex gap-2 rounded border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"><AlertTriangle className="h-4 w-4" />{error}</div>}
            {!execution && !preview && <div className="space-y-4">
                <div className="grid gap-3 md:grid-cols-2">
                    <label className="grid gap-1 text-sm">{t("renewal.requestedPrincipal")}<Input value={requestedPrincipal} onChange={(event) => editRequestedPrincipal(event.target.value)} /></label>
                    <label className="grid gap-1 text-sm">{t("renewal.settlementPolicy.label")}<select className="h-10 rounded-md border bg-background px-3" value={settlementPolicy} onChange={(event) => editPolicy(event.target.value as RenewalSettlementPolicy)}><option value="full_contract_interest">{t("renewal.settlementPolicy.full_contract_interest")}</option><option value="accrued_to_date">{t("renewal.settlementPolicy.accrued_to_date")}</option></select></label>
                </div>
                <div className="space-y-3 rounded border p-4"><div className="flex items-center justify-between"><strong>{t("renewal.adjustments.title")}</strong><Button type="button" variant="outline" onClick={() => { discardApproval(); setAdjustments((current) => [...current, newRenewalAdjustment()]); }}><Plus className="mr-2 h-4 w-4" />{t("renewal.adjustments.add")}</Button></div>
                    {adjustments.length === 0 && <p className="text-sm text-muted-foreground">{t("renewal.adjustments.empty")}</p>}
                    {adjustments.map((line, index) => <div className="grid gap-2 md:grid-cols-[10rem_10rem_1fr_auto]" key={index}><select aria-label={t("renewal.adjustments.kind")} className="h-10 rounded-md border bg-background px-3" value={line.kind} onChange={(event) => editAdjustment(index, "kind", event.target.value as RenewalAdjustmentKind)}>{(["fee", "penalty", "other_charge", "waiver"] as const).map((kind) => <option value={kind} key={kind}>{t(`renewal.adjustments.kinds.${kind}`)}</option>)}</select><Input aria-label={t("renewal.adjustments.amount")} inputMode="decimal" value={line.amount} onChange={(event) => editAdjustment(index, "amount", event.target.value)} placeholder="0.00" /><Input aria-label={t("renewal.adjustments.reason")} value={line.reason} onChange={(event) => editAdjustment(index, "reason", event.target.value)} /><Button type="button" variant="outline" aria-label={t("renewal.adjustments.remove")} onClick={() => { discardApproval(); setAdjustments((current) => current.filter((_, lineIndex) => lineIndex !== index)); }}><Trash2 className="h-4 w-4" /></Button></div>)}
                </div>
                <Button onClick={() => void previewRenewal()} disabled={busy || !requestedPrincipal || adjustments.some((line) => !line.amount || !line.reason.trim())}>{busy ? t("common.loading") : t("renewal.preview")}</Button>
            </div>}
            {preview && <div className="space-y-4">
                <div className="rounded border p-4"><div className="flex items-center justify-between gap-3"><strong>{t("renewal.previewTitle")}</strong><div className="flex gap-2"><Badge>{t(`renewal.status.${execution?.status ?? preview.status}`)}</Badge>{!execution && <Button variant="outline" onClick={discardApproval}>{t("renewal.edit")}</Button>}</div></div><div className="mt-3 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
                    <div><span className="text-muted-foreground">{t("renewal.settlementPolicy.label")}</span><div className="font-medium">{t(`renewal.settlementPolicy.${preview.composition.settlementPolicy}`)}</div></div>
                    {[["contractualInterest", preview.composition.contractualInterest], ["receivedInterest", preview.composition.receivedInterest], ["remainingContractInterest", preview.composition.remainingContractInterest], ["accruedDueInterest", preview.composition.accruedDueInterest], ["totalPaid", preview.composition.totalPaid], ["recoveredBeforeAdjustments", preview.composition.recoveredBeforeAdjustments], ["dueFees", preview.composition.dueFees], ["duePenalties", preview.composition.duePenalties], ["manualCharges", preview.composition.manualCharges], ["manualWaivers", preview.composition.manualWaivers], ["settlement", preview.composition.settlementAmount]].map(([label, value]) => <div key={label}><span className="text-muted-foreground">{t(`renewal.${label}`)}</span><div className="font-medium">{money(value)}</div></div>)}
                    <div><span className="text-muted-foreground">{t("renewal.cashPayout")}</span><div className="font-medium">{t(`renewal.cashDirection.${preview.cashDirection}`)} · {money(preview.cashAmount)}</div></div><div className="sm:col-span-2"><span className="text-muted-foreground">{t("renewal.renewalId")}</span><div className="break-all font-mono text-xs">{preview.publicId}</div><div className="text-xs text-muted-foreground">{t("renewal.expires")}: {dateTime(preview.expiresAt)}</div></div>
                </div>{preview.composition.payments.length > 0 && <div className="mt-4"><strong>{t("renewal.payments")}</strong>{preview.composition.payments.map((payment) => <div className="mt-2 grid gap-1 rounded bg-muted/30 p-2 text-xs sm:grid-cols-3" key={payment.transactionPublicId}><span>{dateTime(payment.paidAt)}</span><span>{money(payment.amount)}</span><span className="break-all font-mono">{payment.transactionPublicId}</span></div>)}</div>}{preview.composition.adjustments.length > 0 && <div className="mt-4"><strong>{t("renewal.adjustments.title")}</strong>{preview.composition.adjustments.map((line) => <div className="mt-2 flex justify-between gap-3 rounded bg-muted/30 p-2 text-xs" key={line.lineNo}><span>{t(`renewal.adjustments.kinds.${line.kind}`)} · {line.reason}</span><span>{money(line.amount)}</span></div>)}</div>}</div>
                <div className="rounded border p-4"><strong>{t("renewal.newSchedule")}</strong><div className="mt-3 max-h-64 overflow-auto"><table className="w-full text-sm"><thead><tr className="border-b text-left"><th className="p-2">#</th><th className="p-2">{t("renewal.dueDate")}</th><th className="p-2">{t("renewal.principal")}</th><th className="p-2">{t("renewal.interest")}</th><th className="p-2">{t("renewal.total")}</th></tr></thead><tbody>{schedule.map((row) => <tr key={row.installmentNo} className="border-b"><td className="p-2">{row.installmentNo}</td><td className="p-2">{new Intl.DateTimeFormat(i18n.language).format(new Date(`${row.dueDate}T00:00:00`))}</td><td className="p-2">{money(row.principalComponent)}</td><td className="p-2">{money(row.interestComponent)}</td><td className="p-2 font-medium">{money(row.amount)}</td></tr>)}</tbody></table></div></div>
                {summary && <RenewalSummaryCard summary={summary} />}
                {!execution && <div className="rounded border p-4"><div className="mb-3 rounded bg-muted/30 p-3 text-sm">{t("renewal.approvalSummary", { policy: t(`renewal.settlementPolicy.${preview.composition.settlementPolicy}`), oldInterest: money(preview.composition.settlementAmount), newInterest: money(preview.composition.contractualInterest), cash: money(preview.cashAmount), direction: t(`renewal.cashDirection.${preview.cashDirection}`) })}</div><label className="grid gap-1 text-sm">{t("renewal.executionReason")}<Input value={executionReason} onChange={(event) => setExecutionReason(event.target.value)} /></label><label className="mt-3 flex items-start gap-2 text-sm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} className="mt-1" /><span>{t("renewal.confirmation")}</span></label>{preview.cashDirection === "collection" && <label className="mt-3 flex items-start gap-2 rounded border border-amber-300 bg-amber-50 p-3 text-sm"><input type="checkbox" checked={collectionConfirmed} onChange={(event) => setCollectionConfirmed(event.target.checked)} className="mt-1" /><span>{t("renewal.collectionConfirmation", { amount: money(preview.cashAmount) })}</span></label>}<Button className="mt-3 bg-emerald-600 hover:bg-emerald-700" disabled={busy || !canExecuteRenewal(preview.cashDirection, confirmed, collectionConfirmed) || !executionReason.trim()} onClick={() => void execute()}><CheckCircle2 className="mr-2 h-4 w-4" />{busy ? t("common.loading") : t("renewal.confirm")}</Button></div>}
                {execution?.status === "executed" && <div className="rounded border p-4"><div className="font-medium text-emerald-700">{t("renewal.executed", { id: execution.newLoanPublicId })}</div><label className="mt-3 grid gap-1 text-sm">{t("renewal.reverseReason")}<Input value={reverseReason} onChange={(event) => setReverseReason(event.target.value)} /></label><Button className="mt-3" variant="destructive" disabled={busy || !reverseReason.trim()} onClick={() => void reverse()}><RotateCcw className="mr-2 h-4 w-4" />{busy ? t("common.loading") : t("renewal.reverse")}</Button></div>}
                <div className="rounded border p-4" aria-live="polite"><strong>{t("renewal.audit")}</strong>{audit.status === "loading" && <div role="status">{t("renewal.auditLoading")}</div>}{audit.status === "empty" && <div>{t("renewal.auditEmpty")}</div>}{audit.status === "forbidden" && <div>{t("renewal.auditForbidden")}</div>}{audit.status === "error" && <div role="alert">{t("renewal.auditFailed")}</div>}{audit.status === "ready" && audit.entries.map((entry) => <div key={entry.id} className="mt-2 rounded bg-muted/30 p-2 text-xs"><div>{t(`auditActions.${entry.action}`, { defaultValue: t("auditActions.unknown") })} · {dateTime(entry.createdAt)}</div><div className="break-all font-mono text-muted-foreground">{t("renewal.auditId")}: {entry.id} · {t("renewal.correlationId")}: {entry.correlationId || "—"} · {t("renewal.requestId")}: {entry.requestId || "—"}</div></div>)}</div>
            </div>}
        </CardContent>
    </Card>;
}
